import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { EvidenceNote, FetchedPage, ResearchJobState, ResearchPlan, RunBudget, RunUsage } from "../src/core/types.ts";
import { MIGRATIONS } from "../src/storage/schema.ts";
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

  test("round-trips checkpoints and recovers interrupted jobs", () => {
    const session = store.createSession({ mode: "research" });
    const job = store.createResearchJob({
      sessionID: session.id,
      question: "What changed?",
      depth: "deep",
    });
    const plan: ResearchPlan = {
      restatedQuestion: "What changed?",
      scope: "Test scope",
      subQuestions: [{ id: "q1", question: "First?", queries: ["first"] }],
    };
    const message = store.createMessage(session.id, "assistant");
    const part = store.addPart(session.id, message.id, "research", {
      jobID: job.id,
      question: job.question,
      depth: job.depth,
      status: "running",
      progress: {
        stage: "searching",
        message: "Searching",
        subQuestionsDone: 0,
        subQuestionsTotal: 1,
        sourcesFound: 0,
        pagesFetched: 0,
        round: 1,
        roundTotal: 1,
        current: [],
      },
    });
    const state: ResearchJobState = {
      model: "test/model",
      allQuestions: plan.subQuestions,
      rounds: [{ round: 1, questions: plan.subQuestions, completed: ["q1"] }],
      candidates: [
        {
          url: "https://example.com/a",
          title: "A",
          snippet: "Snippet",
          provider: "test",
          subQuestionIDs: ["q1"],
        },
      ],
      pages: [{ url: "https://example.com/a", sourceID: "s1" }],
      warnings: ["a warning"],
      progress: {
        stage: "synthesizing",
        message: "Writing the report",
        subQuestionsDone: 1,
        subQuestionsTotal: 2,
        sourcesFound: 1,
        pagesFetched: 1,
        round: 1,
        roundTotal: 3,
        current: [],
      },
    };

    store.updateResearchJob(job.id, { status: "running", plan, state });
    const loaded = store.getResearchJob(job.id);
    expect(loaded?.state).toEqual(state);
    expect(store.recoverInterruptedResearchJobs()).toBe(1);

    const recovered = store.getResearchJob(job.id);
    expect(recovered?.status).toBe("aborted");
    expect(recovered?.error).toContain("server restart");
    expect(recovered?.state).toEqual(state);
    const recoveredPart = store.listResearchParts(session.id, job.id).find((item) => item.id === part.id);
    expect(recoveredPart?.type).toBe("research");
    if (recoveredPart?.type === "research") {
      expect(recoveredPart.data.status).toBe("error");
      expect(recoveredPart.data.progress.stage).toBe("error");
      expect(recoveredPart.data.error).toContain("server restart");
    }
    expect(store.recoverInterruptedResearchJobs()).toBe(0);
  });

  test("finds the latest research part for a job", () => {
    const session = store.createSession({ mode: "research" });
    const message = store.createMessage(session.id, "assistant");
    const job = store.createResearchJob({
      sessionID: session.id,
      question: "What changed?",
      depth: "quick",
    });
    const part = store.addPart(session.id, message.id, "research", {
      jobID: job.id,
      question: job.question,
      depth: job.depth,
      status: "running",
      progress: {
        stage: "planning",
        message: "Planning",
        subQuestionsDone: 0,
        subQuestionsTotal: 0,
        sourcesFound: 0,
        pagesFetched: 0,
        round: 0,
        roundTotal: 1,
        current: [],
      },
    });
    expect(store.findResearchPart(session.id, job.id)?.id).toBe(part.id);
    expect(store.findResearchPart(session.id, "job_missing")).toBeNull();
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

describe("Store durable runs", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  function budget(overrides: Partial<RunBudget> = {}): RunBudget {
    return {
      maxTokens: 1000,
      maxCostUsd: 0.5,
      maxSeconds: 60,
      maxToolCalls: 4,
      maxCrawlPages: 10,
      ...overrides,
    };
  }

  function usage(overrides: Partial<RunUsage> = {}): RunUsage {
    return {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 0.01,
      toolCalls: 1,
      crawlPages: 2,
      elapsedMs: 5000,
      estimated: false,
      ...overrides,
    };
  }

  test("migrates a version 2 database without losing data", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wandey-migrate-"));
    const file = path.join(dir, "wandey.db");
    const db = new Database(file, { create: true });
    db.run(MIGRATIONS[0]!);
    db.run(MIGRATIONS[1]!);
    db.run("pragma user_version = 2");
    db.query(
      "insert into session (id, title, mode, model, parent_id, archived, created_at, updated_at) values (?, ?, ?, null, null, 0, ?, ?)",
    ).run("ses_old", "Old session", "chat", 1, 1);
    db.query(
      "insert into message (id, session_id, role, model, error, finish_reason, usage, created_at) values (?, ?, ?, null, null, null, null, ?)",
    ).run("msg_old", "ses_old", "user", 1);
    db.query(
      "insert into research_job (id, session_id, question, depth, status, plan, report, error, output_path, state, created_at, updated_at) values (?, ?, ?, ?, ?, null, null, null, null, null, ?, ?)",
    ).run("job_old", "ses_old", "Old question", "quick", "done", 1, 1);
    db.close();

    const migrated = new Store(file);
    try {
      expect(migrated.getSession("ses_old")?.title).toBe("Old session");
      expect(migrated.getMessage("msg_old")?.role).toBe("user");
      expect(migrated.getResearchJob("job_old")?.status).toBe("done");
      const tables = migrated.db
        .query("select name from sqlite_master where type = 'table'")
        .all() as Array<{ name: string }>;
      const names = new Set(tables.map((row) => row.name));
      expect(names.has("run")).toBe(true);
      expect(names.has("run_step")).toBe(true);
      expect(names.has("run_checkpoint")).toBe(true);
      expect(Number((migrated.db.query("pragma user_version").get() as { user_version: number }).user_version)).toBe(3);
    } finally {
      migrated.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates, updates, lists, dismisses, and deletes runs", () => {
    const session = store.createSession();
    const user = store.createMessage(session.id, "user");
    const assistant = store.createMessage(session.id, "assistant");
    const run = store.createRun({
      sessionID: session.id,
      userMessageID: user.id,
      prompt: "  Research this  ",
      mode: "research",
      model: "test/model",
      budget: budget(),
    });

    expect(run.status).toBe("running");
    expect(run.prompt).toBe("  Research this  ");
    expect(store.getRun(run.id)?.budget).toEqual(budget());
    expect(store.latestRun(session.id)?.id).toBe(run.id);
    expect(store.activeRun(session.id)?.id).toBe(run.id);
    expect(() =>
      store.createRun({
        sessionID: session.id,
        userMessageID: user.id,
        prompt: "Second",
        mode: "chat",
        model: null,
        budget: budget(),
      }),
    ).toThrow("active run");

    const updated = store.updateRun(run.id, {
      status: "completed",
      stopReason: "completed",
      assistantMessageID: assistant.id,
      usage: usage(),
      endedAt: 1234,
    });
    expect(updated?.status).toBe("completed");
    expect(updated?.usage).toEqual(usage());
    expect(store.activeRun(session.id)).toBeNull();

    store.dismissRun(run.id);
    expect(store.latestRun(session.id)?.dismissedAt).not.toBeNull();
    expect(store.listRuns(session.id, { includeDismissed: false })).toHaveLength(0);
    expect(store.listRuns(session.id)).toHaveLength(1);

    store.deleteRun(run.id);
    expect(store.getRun(run.id)).toBeNull();
  });

  test("recovery interrupts live runs and fails only running steps", () => {
    const session = store.createSession();
    const user = store.createMessage(session.id, "user");
    const run = store.createRun({
      sessionID: session.id,
      userMessageID: user.id,
      prompt: "Question",
      mode: "chat",
      model: "test/model",
      budget: budget(),
    });
    const modelStep = store.createRunStep({
      runID: run.id,
      stepKey: "model:0",
      kind: "model",
      name: "model",
      model: "test/model",
    });
    const doneStep = store.createRunStep({
      runID: run.id,
      stepKey: "tool:0:0:call_1",
      kind: "tool",
      name: "web_search",
    });
    store.updateRunStep(doneStep.id, { status: "completed", endedAt: 5 });

    expect(store.recoverInterruptedRuns("restarted")).toBe(1);
    const recovered = store.getRun(run.id)!;
    expect(recovered.status).toBe("interrupted");
    expect(recovered.stopReason).toBe("restart");
    expect(recovered.error).toBe("restarted");
    expect(recovered.endedAt).not.toBeNull();
    expect(store.getRunStep(modelStep.id)?.status).toBe("failed");
    expect(store.getRunStep(modelStep.id)?.error).toBe("restarted");
    expect(store.getRunStep(doneStep.id)?.status).toBe("completed");
    expect(store.recoverInterruptedRuns()).toBe(0);
  });

  test("orders steps by ordinal and keeps attempts unique per key", () => {
    const session = store.createSession();
    const user = store.createMessage(session.id, "user");
    const run = store.createRun({
      sessionID: session.id,
      userMessageID: user.id,
      prompt: "Question",
      mode: "chat",
      model: "test/model",
      budget: budget(),
    });
    const first = store.createRunStep({ runID: run.id, stepKey: "model:0", kind: "model", name: "model" });
    const second = store.createRunStep({
      runID: run.id,
      stepKey: "model:0",
      kind: "model",
      name: "model",
      attempt: 2,
    });
    const tool = store.createRunStep({
      runID: run.id,
      stepKey: "tool:0:0:call_1",
      kind: "tool",
      name: "web_search",
      callID: "call_1",
    });

    expect([first.ordinal, second.ordinal, tool.ordinal]).toEqual([0, 1, 2]);
    expect(store.latestRunStep(run.id, "model:0")?.id).toBe(second.id);
    expect(store.listRunSteps(run.id).map((step) => step.id)).toEqual([first.id, second.id, tool.id]);
    expect(() =>
      store.createRunStep({ runID: run.id, stepKey: "model:0", kind: "model", name: "model", attempt: 2 }),
    ).toThrow("already has attempt 2");
  });

  test("allocates checkpoint sequence numbers", () => {
    const session = store.createSession();
    const user = store.createMessage(session.id, "user");
    const run = store.createRun({
      sessionID: session.id,
      userMessageID: user.id,
      prompt: "Question",
      mode: "chat",
      model: null,
      budget: budget(),
    });
    for (let index = 0; index < 3; index++) {
      store.createRunCheckpoint(run.id, {
        version: 1,
        loopStep: index,
        phase: "model",
        assistantMessageID: null,
        modelStepID: null,
        toolCalls: [],
        nextToolIndex: 0,
      });
    }
    expect(store.listRunCheckpoints(run.id).map((checkpoint) => checkpoint.seq)).toEqual([0, 1, 2]);
    expect(store.latestRunCheckpoint(run.id)?.state.loopStep).toBe(2);
  });

  test("deletes partial messages and expires pending questions", () => {
    const session = store.createSession();
    const empty = store.createMessage(session.id, "assistant");
    const failed = store.createMessage(session.id, "assistant");
    store.addPart(session.id, failed.id, "error", { message: "failed" });
    const message = store.createMessage(session.id, "assistant");
    const pending = store.addPart(session.id, message.id, "question", {
      questionID: "q_pending",
      question: "Pick one",
      options: [],
      multiple: false,
      allowCustom: true,
      status: "pending",
    });
    const answered = store.addPart(session.id, message.id, "question", {
      questionID: "q_answered",
      question: "Already answered",
      options: [],
      multiple: false,
      allowCustom: true,
      answer: ["yes"],
      status: "answered",
    });

    expect(store.deleteEmptyAssistantMessages(session.id)).toBe(1);
    expect(store.getMessage(empty.id)).toBeNull();
    expect(store.getMessage(failed.id)).not.toBeNull();
    expect(store.deleteEmptyAssistantMessages(session.id)).toBe(0);

    expect(store.expirePendingQuestions()).toBe(1);
    const expired = store.getPart(pending.id);
    expect(expired?.type === "question" && expired.data.status).toBe("expired");
    const kept = store.getPart(answered.id);
    expect(kept?.type === "question" && kept.data.status).toBe("answered");

    store.deleteMessage(message.id);
    expect(store.getPart(pending.id)).toBeNull();
    expect(store.getPart(answered.id)).toBeNull();
  });

  test("reconciles usage from steps without double counting retried tools", () => {
    const session = store.createSession();
    const user = store.createMessage(session.id, "user");
    const run = store.createRun({
      sessionID: session.id,
      userMessageID: user.id,
      prompt: "Question",
      mode: "chat",
      model: "test/model",
      budget: budget(),
    });
    store.updateRun(run.id, { usage: usage({ elapsedMs: 5000 }) });

    const model = store.createRunStep({ runID: run.id, stepKey: "model:0", kind: "model", name: "model" });
    store.updateRunStep(model.id, {
      status: "completed",
      usage: { input: 100, output: 20, cost: 0.01 },
    });
    const failedModel = store.createRunStep({
      runID: run.id,
      stepKey: "model:1",
      kind: "model",
      name: "model",
      attempt: 2,
    });
    store.updateRunStep(failedModel.id, {
      status: "failed",
      usage: { input: 50, output: 10, total: 70, estimated: true },
    });
    const tool = store.createRunStep({
      runID: run.id,
      stepKey: "tool:0:0:call_1",
      kind: "tool",
      name: "fetch_url",
      callID: "call_1",
    });
    store.updateRunStep(tool.id, { status: "completed", crawlPages: 3 });
    const retried = store.createRunStep({
      runID: run.id,
      stepKey: "tool:0:0:call_1",
      kind: "tool",
      name: "fetch_url",
      callID: "call_1",
      attempt: 2,
    });
    store.updateRunStep(retried.id, { status: "completed", crawlPages: 2 });

    expect(store.sumRunUsage(run.id)).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 190,
      costUsd: 0.01,
      toolCalls: 1,
      crawlPages: 5,
      elapsedMs: 5000,
      estimated: true,
    });
  });

  test("finds research jobs that are not linked from a run step", () => {
    const session = store.createSession();
    const job = store.createResearchJob({ sessionID: session.id, question: "What changed?", depth: "quick" });
    expect(store.findUnlinkedResearchJob(session.id, "What changed?", job.createdAt - 1)?.id).toBe(job.id);
    expect(store.findUnlinkedResearchJob(session.id, "Other question", 0)).toBeNull();

    const user = store.createMessage(session.id, "user");
    const run = store.createRun({
      sessionID: session.id,
      userMessageID: user.id,
      prompt: "What changed?",
      mode: "research",
      model: "test/model",
      budget: budget(),
    });
    store.createRunStep({
      runID: run.id,
      stepKey: "tool:0:0:call_1",
      kind: "tool",
      name: "deep_research",
      refID: job.id,
    });
    expect(store.findUnlinkedResearchJob(session.id, "What changed?", 0)).toBeNull();
    expect(store.findRunStepByRef(job.id)?.runID).toBe(run.id);
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
