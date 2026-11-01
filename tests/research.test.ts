import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, type Config } from "../src/core/config.ts";
import { EventBus } from "../src/core/events.ts";
import type {
  EvidenceNote,
  FetchedPage,
  ResearchJobState,
  ResearchPlan,
} from "../src/core/types.ts";
import type { PageFetcher } from "../src/crawl/fetcher.ts";
import type { ProviderRegistry } from "../src/providers/registry.ts";
import { ResearchEngine } from "../src/research/engine.ts";
import type { SearchService } from "../src/search/search.ts";
import { Store } from "../src/storage/store.ts";

/**
 * These tests deliberately run only the synthesis phase. Checkpoint/resume is
 * about continuing from persisted evidence; the search and fetch fakes fail
 * loudly if a resume accidentally re-runs them.
 */

function page(url = "https://example.com/article"): FetchedPage {
  return {
    url,
    finalUrl: url,
    status: 200,
    contentType: "text/html",
    title: "Saved source",
    site: "example.com",
    markdown: "# Saved source\n\nThis page was already read and persisted.",
    text: "This page was already read and persisted.",
    links: [],
    words: 8,
    fetchedAt: Date.now(),
    via: "http",
  };
}

function note(sessionID: string, jobID: string, sourceID: string): EvidenceNote {
  return {
    id: "note_saved",
    sessionID,
    jobID,
    claim: "The saved source supports this claim.",
    quote: "This page was already read and persisted.",
    sourceID,
    sourceTitle: "Saved source",
    sourceURL: "https://example.com/article",
    subQuestionID: "q1",
    confidence: "high",
    round: 1,
  };
}

function registryReturning(text: string): ProviderRegistry {
  return {
    defaultModel: async () => "test/model",
    stream: async function* () {
      yield { type: "text", delta: text };
      yield { type: "finish", reason: "stop" };
    },
  } as unknown as ProviderRegistry;
}

const failingSearch = {
  search: async () => {
    throw new Error("resume must not search again");
  },
} as unknown as SearchService;

const failingFetcher = {
  fetch: async () => {
    throw new Error("resume must not fetch again");
  },
} as unknown as PageFetcher;

describe("ResearchEngine resume", () => {
  let temp: string;
  let store: Store;
  let config: Config;
  let engine: ResearchEngine;
  let plan: ResearchPlan;

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "wandey-research-test-"));
    store = new Store(":memory:");
    config = structuredClone(DEFAULTS);
    config.research.outputDir = temp;
    config.research.rounds = 1;
    config.research.workers = 1;
    engine = new ResearchEngine({
      config,
      store,
      registry: registryReturning("# Recovered report\n\nThe saved evidence supports the answer [s1]."),
      search: failingSearch,
      fetcher: failingFetcher,
      bus: new EventBus(),
    });
    plan = {
      restatedQuestion: "What changed?",
      scope: "Test scope",
      subQuestions: [{ id: "q1", question: "First?", queries: ["first"] }],
    };
  });

  afterEach(() => {
    store.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  test("finishes a legacy job from saved notes and sources", async () => {
    const session = store.createSession({ mode: "research" });
    const source = store.addSource(session.id, page()).source;
    const job = store.createResearchJob({
      sessionID: session.id,
      question: "What changed?",
      depth: "quick",
    });
    store.addNotes([note(session.id, job.id, source.sourceID)]);
    store.updateResearchJob(job.id, {
      status: "aborted",
      plan,
      error: "Stopped by user.",
    });
    const message = store.createMessage(session.id, "assistant");

    const outcome = await engine.resume({
      jobID: job.id,
      messageID: message.id,
      model: "test/model",
    });

    expect(outcome.report).toContain("Recovered report");
    expect(outcome.outputPath.startsWith(temp)).toBe(true);
    expect(outcome.notes).toBe(1);
    expect(outcome.warnings.join("\n")).toContain("Recovered an older job");
    expect(store.listNotes(job.id)).toHaveLength(1);
    expect(store.getResearchJob(job.id)?.status).toBe("done");
    expect(fs.existsSync(outcome.outputPath)).toBe(true);

    const part = store.findResearchPart(session.id, job.id);
    expect(part?.type).toBe("research");
    if (part?.type === "research") {
      expect(part.data.status).toBe("done");
      expect(part.data.report).toContain("Recovered report");
    }
  });

  test("continues a checkpointed job without repeating completed rounds", async () => {
    const session = store.createSession({ mode: "research" });
    const source = store.addSource(session.id, page()).source;
    const job = store.createResearchJob({
      sessionID: session.id,
      question: "What changed?",
      depth: "quick",
    });
    store.addNotes([note(session.id, job.id, source.sourceID)]);
    const state: ResearchJobState = {
      model: "test/model",
      allQuestions: plan.subQuestions,
      rounds: [{ round: 1, questions: plan.subQuestions, completed: ["q1"] }],
      candidates: [
        {
          url: "https://example.com/article",
          title: "Saved source",
          snippet: "Already discovered",
          provider: "test",
          subQuestionIDs: ["q1"],
        },
      ],
      pages: [{ url: "https://example.com/article", sourceID: source.sourceID }],
      warnings: [],
      progress: {
        stage: "synthesizing",
        message: "Writing the report",
        subQuestionsDone: 1,
        subQuestionsTotal: 1,
        sourcesFound: 1,
        pagesFetched: 1,
        round: 1,
        roundTotal: 1,
        current: [],
      },
    };
    store.updateResearchJob(job.id, {
      status: "aborted",
      plan,
      state,
      error: "Stopped by user.",
    });
    const message = store.createMessage(session.id, "assistant");

    const outcome = await engine.resume({
      jobID: job.id,
      messageID: message.id,
      model: "test/model",
    });

    expect(outcome.report).toContain("Recovered report");
    expect(outcome.notes).toBe(1);
    expect(store.listNotes(job.id)).toHaveLength(1);
    expect(store.getResearchJob(job.id)?.status).toBe("done");
    expect(store.getResearchJob(job.id)?.state?.rounds[0]?.completed).toEqual(["q1"]);
  });

  test("aborting during search marks the job aborted and saves its checkpoint", async () => {
    const session = store.createSession({ mode: "research" });
    const message = store.createMessage(session.id, "assistant");
    const controller = new AbortController();
    let searchCalls = 0;
    const planningRegistry = {
      defaultModel: async () => "test/model",
      stream: async function* () {
        yield {
          type: "text",
          delta: JSON.stringify({
            restatedQuestion: "What changed?",
            scope: "Test scope",
            subQuestions: [{ id: "q1", question: "First?", queries: ["first"] }],
          }),
        };
        yield { type: "finish", reason: "stop" };
      },
    } as unknown as ProviderRegistry;
    const search = {
      search: async () => {
        searchCalls++;
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      },
    } as unknown as SearchService;
    const abortingEngine = new ResearchEngine({
      config,
      store,
      registry: planningRegistry,
      search,
      fetcher: failingFetcher,
      bus: new EventBus(),
    });

    const observed: string[] = [];
    const promise = abortingEngine.run({
      sessionID: session.id,
      messageID: message.id,
      question: "What changed?",
      depth: "quick",
      model: "test/model",
      signal: controller.signal,
      observer: {
        onJobCreated: (job) => observed.push(job.id),
      },
    });
    await expect(promise).rejects.toThrow();

    const job = store.findResearchPart(session.id, "missing");
    expect(job).toBeNull();
    const saved = store.listResearchJobs(session.id)[0]!;
    expect(observed).toEqual([saved.id]);
    expect(saved.status).toBe("aborted");
    expect(saved.error).toBe("Stopped by user.");
    expect(saved.state).not.toBeNull();
    expect(saved.state?.rounds[0]?.questions[0]?.id).toBe("q1");
    expect(saved.state?.rounds[0]?.completed).toEqual([]);
    expect(store.listNotes(saved.id)).toHaveLength(0);
    expect(searchCalls).toBeGreaterThan(0);
  });
});
