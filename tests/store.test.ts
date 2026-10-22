import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EvidenceNote, FetchedPage, ResearchPlan } from "../src/core/types.ts";
import { Store } from "../src/storage/store.ts";

function page(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: "https://example.com/article?utm_source=test",
    finalUrl: "https://www.example.com/article?utm_source=test",
    status: 200,
    contentType: "text/html",
    title: "An article",
    site: "example.com",
    markdown: "# An article\n\nSome **markdown**.",
    text: "Some plain text about an article.",
    links: [],
    words: 6,
    fetchedAt: Date.now(),
    via: "http",
    ...overrides,
  };
}

describe("Store sessions and messages", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("creates, updates, lists, archives, and deletes sessions", () => {
    const session = store.createSession({ title: "  First  ", mode: "research" });
    expect(session.title).toBe("First");
    expect(session.mode).toBe("research");

    const updated = store.updateSession(session.id, { title: "Renamed", model: "ollama/qwen" });
    expect(updated?.title).toBe("Renamed");
    expect(updated?.model).toBe("ollama/qwen");

    expect(store.listSessions().map((item) => item.id)).toContain(session.id);
    store.updateSession(session.id, { archived: true });
    expect(store.listSessions().map((item) => item.id)).not.toContain(session.id);
    expect(store.listSessions({ includeArchived: true }).map((item) => item.id)).toContain(session.id);

    store.deleteSession(session.id);
    expect(store.getSession(session.id)).toBeNull();
    expect(store.getSessionDetail(session.id)).toBeNull();
  });

  test("stores messages and ordered parts", () => {
    const session = store.createSession({ title: "Chat" });
    const user = store.createMessage(session.id, "user");
    const assistant = store.createMessage(session.id, "assistant", "openrouter/test");

    store.addPart(session.id, user.id, "text", { text: "A question" });
    store.addPart(session.id, assistant.id, "reasoning", { text: "Thinking" });
    const textPart = store.addPart(session.id, assistant.id, "text", { text: "An answer" });
    store.addPart(session.id, assistant.id, "text", { text: "A second paragraph" });

    const detail = store.getSessionDetail(session.id);
    expect(detail?.messages).toHaveLength(2);
    expect(detail?.messages[0]?.message.role).toBe("user");
    expect(detail?.messages[1]?.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
      "text",
    ]);
    expect(detail?.messages[1]?.parts[1]?.data).toEqual({ text: "An answer" });

    const updated = store.updatePart(textPart.id, { text: "Edited answer" });
    expect(updated?.data).toEqual({ text: "Edited answer" });

    store.updateMessage(assistant.id, {
      finishReason: "stop",
      usage: { input: 10, output: 5, total: 15 },
    });
    expect(store.getMessage(assistant.id)?.usage).toEqual({ input: 10, output: 5, total: 15 });
  });

  test("persists question answers as ordinary parts", () => {
    const session = store.createSession();
    const message = store.createMessage(session.id, "assistant");
    const part = store.addPart(session.id, message.id, "question", {
      questionID: "q1",
      question: "Pick one",
      options: [{ label: "A" }, { label: "B" }],
      multiple: false,
      allowCustom: true,
      status: "pending",
    });

    store.updatePart(part.id, {
      questionID: "q1",
      question: "Pick one",
      options: [{ label: "A" }, { label: "B" }],
      multiple: false,
      allowCustom: true,
      status: "answered",
      answer: ["B"],
    });

    const saved = store.getPart(part.id);
    expect(saved?.type).toBe("question");
    if (saved?.type === "question") {
      expect(saved.data.status).toBe("answered");
      expect(saved.data.answer).toEqual(["B"]);
    }
  });
});

describe("Store sources", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("deduplicates by canonical URL and keeps the first source id", () => {
    const session = store.createSession();
    const first = store.addSource(session.id, page());
    expect(first.isNew).toBe(true);
    expect(first.source.sourceID).toBe("s1");

    const second = store.addSource(
      session.id,
      page({
        url: "https://example.com/article",
        finalUrl: "https://example.com/article",
        title: "A different title",
      }),
    );
    expect(second.isNew).toBe(false);
    expect(second.source.sourceID).toBe("s1");
    expect(second.source.title).toBe("An article");

    expect(store.listSources(session.id)).toHaveLength(1);
    expect(store.findSourceByURL(session.id, "https://example.com/article")).toBe("s1");
  });

  test("stores full content and assigns sequential ids", () => {
    const session = store.createSession();
    store.addSource(session.id, page());
    const second = store.addSource(
      session.id,
      page({ url: "https://other.test/x", finalUrl: "https://other.test/x", title: "Other" }),
    );
    expect(second.source.sourceID).toBe("s2");

    const stored = store.getSource(session.id, "s1");
    expect(stored?.title).toBe("An article");
    expect(stored?.text).toContain("Some plain text");
    expect(stored?.content).toContain("Some **markdown**");
    expect(stored?.fetchedAt).toBeGreaterThan(0);
  });
});

describe("Store research jobs and notes", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("round-trips plans, reports, statuses, and output paths", () => {
    const session = store.createSession({ mode: "research" });
    const job = store.createResearchJob({
      sessionID: session.id,
      question: "What changed?",
      depth: "deep",
    });
    expect(job.status).toBe("pending");

    const plan: ResearchPlan = {
      restatedQuestion: "What changed?",
      scope: "Test scope",
      subQuestions: [{ id: "q1", question: "First?", queries: ["first"] }],
    };
    const updated = store.updateResearchJob(job.id, {
      status: "done",
      plan,
      report: "# Report\n\nText [s1].",
      outputPath: "/tmp/report.md",
    });
    expect(updated?.status).toBe("done");
    expect(updated?.outputPath).toBe("/tmp/report.md");

    const loaded = store.getResearchJob(job.id);
    expect(loaded?.plan).toEqual(plan);
    expect(loaded?.report).toContain("[s1]");
    expect(store.listResearchJobs(session.id).map((item) => item.id)).toEqual([job.id]);
  });

  test("stores evidence notes in insertion order", () => {
    const session = store.createSession({ mode: "research" });
    const job = store.createResearchJob({
      sessionID: session.id,
      question: "What changed?",
      depth: "standard",
    });
    const notes: EvidenceNote[] = [
      {
        id: "note_a",
        sessionID: session.id,
        jobID: job.id,
        claim: "Claim A",
        quote: "Quote A",
        sourceID: "s1",
        sourceTitle: "Source A",
        sourceURL: "https://a.test",
        subQuestionID: "q1",
        confidence: "high",
        round: 1,
      },
      {
        id: "note_b",
        sessionID: session.id,
        jobID: job.id,
        claim: "Claim B",
        quote: "Quote B",
        sourceID: "s2",
        sourceTitle: "Source B",
        sourceURL: "https://b.test",
        subQuestionID: "q2",
        confidence: "low",
        round: 2,
      },
    ];
    store.addNotes(notes);
    expect(store.listNotes(job.id).map((note) => note.id)).toEqual(["note_a", "note_b"]);
  });

  test("deleting a session cascades to messages, sources, jobs, and notes", () => {
    const session = store.createSession();
    const message = store.createMessage(session.id, "user");
    store.addPart(session.id, message.id, "text", { text: "Hello" });
    store.addSource(session.id, page());
    const job = store.createResearchJob({
      sessionID: session.id,
      question: "Question",
      depth: "quick",
    });
    store.addNotes([
      {
        id: "note_cascade",
        sessionID: session.id,
        jobID: job.id,
        claim: "Claim",
        quote: "Quote",
        sourceID: "s1",
        sourceTitle: "Source",
        sourceURL: "https://a.test",
        subQuestionID: "q1",
        confidence: "high",
        round: 1,
      },
    ]);

    store.deleteSession(session.id);
    expect(store.getMessage(message.id)).toBeNull();
    expect(store.getSource(session.id, "s1")).toBeNull();
    expect(store.getResearchJob(job.id)).toBeNull();
    expect(store.listNotes(job.id)).toHaveLength(0);
  });
});

describe("Store settings", () => {
  test("upserts small key-value settings", () => {
    const store = new Store(":memory:");
    expect(store.getSetting("theme")).toBeNull();
    store.setSetting("theme", "dark");
    expect(store.getSetting("theme")).toBe("dark");
    store.setSetting("theme", "light");
    expect(store.getSetting("theme")).toBe("light");
    store.close();
  });
});
