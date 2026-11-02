import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent.ts";
import { DEFAULTS, type Config } from "../src/core/config.ts";
import { EventBus } from "../src/core/events.ts";
import { normalizeRunBudget } from "../src/core/run-usage.ts";
import type { ResearchDepth, ServerEvent } from "../src/core/types.ts";
import { now } from "../src/core/util.ts";
import type { PageFetcher } from "../src/crawl/fetcher.ts";
import type { SearchService } from "../src/search/search.ts";
import { Store } from "../src/storage/store.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import {
  FakeRegistry,
  textResponse,
  toolCallResponse,
  waitForRun,
  type FakeModel,
  type Responder,
} from "./support/fake-provider.ts";

/**
 * Lifecycle tests for durable runs. Every model response is scripted, so these
 * tests are deterministic and never touch the network.
 */

interface Harness {
  store: Store;
  agent: Agent;
  registry: FakeRegistry;
  events: ServerEvent[];
  sessionID: string;
  tools: ToolRegistry;
  close(): void;
}

function harness(
  responder: Responder,
  options: { models?: Record<string, FakeModel>; config?: (config: Config) => void } = {},
): Harness {
  const config = structuredClone(DEFAULTS);
  config.agent.model = "fake/model";
  config.agent.autoTitle = false;
  options.config?.(config);

  const store = new Store(":memory:");
  const registry = new FakeRegistry(options.models ?? { "fake/model": {} }, responder);
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.on((event) => events.push(event));
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "Echo a value",
    parameters: { type: "object", properties: { value: { type: "string" } } },
    async execute(args) {
      return { title: "Echo", output: `echo:${String(args.value ?? "")}` };
    },
  });

  const agent = new Agent({
    config,
    store,
    registry: registry.asRegistry(),
    tools,
    fetcher: {} as PageFetcher,
    search: {} as SearchService,
    bus,
  });
  const session = store.createSession({ title: "Test session" });

  return {
    store,
    agent,
    registry,
    events,
    sessionID: session.id,
    tools,
    close() {
      agent.abortAll();
      store.close();
    },
  };
}

const running: Harness[] = [];

function setup(responder: Responder, options: Parameters<typeof harness>[1] = {}): Harness {
  const created = harness(responder, options);
  running.push(created);
  return created;
}

afterEach(() => {
  while (running.length > 0) running.pop()!.close();
});

describe("Agent run recording", () => {
  test("records a completed model step and run usage", async () => {
    const h = setup(() => textResponse("hello", { input: 10, output: 2, total: 12, cost: 0.002 }));
    const { message, run } = await h.agent.prompt(h.sessionID, "Hi");

    expect(message.role).toBe("user");
    expect(run.status).toBe("running");

    const done = await waitForRun(h.store, run.id);
    expect(done.status).toBe("completed");
    expect(done.stopReason).toBe("completed");
    expect(done.usage.totalTokens).toBe(12);
    expect(done.usage.costUsd).toBe(0.002);
    expect(done.endedAt).not.toBeNull();

    const steps = h.store.listRunSteps(run.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.stepKey).toBe("model:0");
    expect(steps[0]!.status).toBe("completed");
    expect(steps[0]!.model).toBe("fake/model");
    expect(steps[0]!.usage?.total).toBe(12);

    const detail = h.store.getSessionDetail(h.sessionID)!;
    const assistant = detail.messages.find((entry) => entry.message.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.parts.some((part) => part.type === "text" && part.data.text === "hello")).toBe(true);
    expect(done.assistantMessageID).toBe(assistant!.message.id);

    expect(h.events.some((event) => event.type === "run.created")).toBe(true);
    expect(h.events.filter((event) => event.type === "run.step")).toHaveLength(2);
    const updates = h.events.filter((event) => event.type === "run.updated");
    expect(updates.at(-1)).toMatchObject({ type: "run.updated", run: { status: "completed" } });
  });

  test("records tool calls as ordered steps", async () => {
    const h = setup((_ref, _request, call) =>
      call === 1
        ? toolCallResponse([{ id: "call_1", name: "echo", args: { value: "x" } }])
        : textResponse("done"),
    );
    const { run } = await h.agent.prompt(h.sessionID, "Use the tool");
    const done = await waitForRun(h.store, run.id);

    expect(done.status).toBe("completed");
    expect(done.usage.toolCalls).toBe(1);

    const steps = h.store.listRunSteps(run.id);
    expect(steps.map((step) => step.stepKey)).toEqual(["model:0", "tool:0:0:call_1", "model:1"]);
    expect(steps.map((step) => step.kind)).toEqual(["model", "tool", "model"]);
    expect(steps[1]!.status).toBe("completed");
    expect(steps[1]!.callID).toBe("call_1");
    expect(steps[1]!.output).toBe("echo:x");
    expect(steps[1]!.endedAt).not.toBeNull();
    expect(steps[2]!.status).toBe("completed");

    const detail = h.store.getSessionDetail(h.sessionID)!;
    const toolPart = detail.messages
      .flatMap((entry) => entry.parts)
      .find((part) => part.type === "tool" && part.data.callID === "call_1");
    expect(toolPart?.type).toBe("tool");
    if (toolPart?.type === "tool") {
      expect(toolPart.data.status).toBe("done");
      expect(toolPart.data.output).toBe("echo:x");
    }
  });

  test("estimates usage when the provider reports none", async () => {
    const h = setup(() => textResponse("a reasonably long answer"));
    const { run } = await h.agent.prompt(h.sessionID, "Question");
    const done = await waitForRun(h.store, run.id);

    const step = h.store.listRunSteps(run.id)[0]!;
    expect(step.usage?.estimated).toBe(true);
    expect(step.usage?.input ?? 0).toBeGreaterThan(0);
    expect(step.usage?.output ?? 0).toBeGreaterThan(0);
    expect(done.usage.estimated).toBe(true);
    expect(done.usage.totalTokens).toBeGreaterThan(0);
  });

  test("rejects a second prompt while a run is active", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setup(async () => {
      await gate;
      return textResponse("late");
    });
    const first = await h.agent.prompt(h.sessionID, "First");
    await expect(h.agent.prompt(h.sessionID, "Second")).rejects.toThrow("already running");
    release?.();
    await waitForRun(h.store, first.run.id);
  });
});

function registerResearchTool(h: Harness): void {
  h.tools.register({
    name: "deep_research",
    description: "Run deep research",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
        depth: { type: "string" },
      },
    },
    async execute(args, ctx) {
      if (!ctx.deepResearch) throw new Error("deep research handler is missing");
      return ctx.deepResearch(String(args.question ?? ""), args.depth as ResearchDepth | undefined, {
        messageID: ctx.messageID,
        callID: ctx.callID,
        signal: ctx.signal,
      });
    },
  });
}

/** Build a run stopped in the middle of a deep_research tool call. */
function interruptedResearchRun(
  h: Harness,
  options: { question: string; jobID: string | null },
): { runID: string; toolStepID: string } {
  const user = h.store.createMessage(h.sessionID, "user");
  h.store.addPart(h.sessionID, user.id, "text", { text: "Research this" });
  const assistant = h.store.createMessage(h.sessionID, "assistant", "fake/model");
  const run = h.store.createRun({
    sessionID: h.sessionID,
    userMessageID: user.id,
    prompt: "Research this",
    mode: "chat",
    model: "fake/model",
    budget: normalizeRunBudget(undefined),
  });
  const modelStep = h.store.createRunStep({
    runID: run.id,
    stepKey: "model:0",
    kind: "model",
    name: "model",
    model: "fake/model",
    messageID: assistant.id,
  });
  h.store.updateRunStep(modelStep.id, { status: "completed", endedAt: now() });
  h.store.addPart(h.sessionID, assistant.id, "tool", {
    callID: "call_research",
    name: "deep_research",
    args: { question: options.question, depth: "quick" },
    status: "running",
    startedAt: now(),
  });
  const toolStep = h.store.createRunStep({
    runID: run.id,
    stepKey: "tool:0:0:call_research",
    kind: "tool",
    name: "deep_research",
    model: "fake/model",
    messageID: assistant.id,
    callID: "call_research",
    refID: options.jobID,
  });
  h.store.updateRun(run.id, {
    assistantMessageID: assistant.id,
    status: "interrupted",
    stopReason: "restart",
    endedAt: now(),
  });
  h.store.createRunCheckpoint(run.id, {
    version: 1,
    loopStep: 0,
    phase: "tools",
    assistantMessageID: assistant.id,
    modelStepID: modelStep.id,
    toolCalls: [
      { id: "call_research", name: "deep_research", args: { question: options.question, depth: "quick" } },
    ],
    nextToolIndex: 0,
  });
  return { runID: run.id, toolStepID: toolStep.id };
}

describe("Agent run resume", () => {
  test("marks a mid-stream provider failure as interrupted", async () => {
    const h = setup(async function* () {
      yield { type: "text", delta: "partial" };
      throw new Error("stream broke");
    });
    const { run } = await h.agent.prompt(h.sessionID, "Hi");
    const done = await waitForRun(h.store, run.id);

    expect(done.status).toBe("interrupted");
    expect(done.stopReason).toBe("error");
    expect(done.error).toContain("stream broke");
    expect(h.store.listRunSteps(run.id)[0]!.status).toBe("failed");

    const detail = h.store.getSessionDetail(h.sessionID)!;
    const assistant = detail.messages.find((entry) => entry.message.role === "assistant")!;
    expect(assistant.parts.some((part) => part.type === "text" && part.data.text === "partial")).toBe(true);
  });

  test("resume deletes partial output and retries the model step", async () => {
    let calls = 0;
    const h = setup(async function* () {
      calls++;
      if (calls === 1) {
        yield { type: "text", delta: "partial" };
        throw new Error("stream broke");
      }
      yield { type: "text", delta: "final answer" };
      yield { type: "finish", reason: "stop" };
    });
    const { run } = await h.agent.prompt(h.sessionID, "Hi");
    await waitForRun(h.store, run.id);

    const resumed = await h.agent.resumeRun(run.id);
    expect(resumed.status).toBe("running");
    expect(resumed.resumeCount).toBe(1);

    const done = await waitForRun(h.store, run.id);
    expect(done.status).toBe("completed");
    expect(done.stopReason).toBe("completed");

    const attempts = h.store.listRunSteps(run.id).filter((step) => step.stepKey === "model:0");
    expect(attempts.map((step) => step.status)).toEqual(["failed", "completed"]);
    expect(attempts.map((step) => step.attempt)).toEqual([1, 2]);

    const detail = h.store.getSessionDetail(h.sessionID)!;
    const assistants = detail.messages.filter((entry) => entry.message.role === "assistant");
    expect(assistants).toHaveLength(1);
    const texts = assistants[0]!.parts.filter((part) => part.type === "text").map((part) => part.data.text);
    expect(texts).toEqual(["final answer"]);
  });

  test("resume keeps completed tool steps and continues at the next model step", async () => {
    let toolRuns = 0;
    let calls = 0;
    const h = setup(async function* () {
      calls++;
      if (calls === 1) {
        yield* toolCallResponse([{ id: "call_1", name: "count", args: {} }]);
        return;
      }
      if (calls === 2) {
        yield { type: "text", delta: "partial" };
        throw new Error("model broke");
      }
      yield { type: "text", delta: "final" };
      yield { type: "finish", reason: "stop" };
    });
    h.tools.register({
      name: "count",
      description: "Count calls",
      parameters: { type: "object", properties: {} },
      async execute() {
        toolRuns++;
        return { title: "Counted", output: `run ${toolRuns}` };
      },
    });

    const { run } = await h.agent.prompt(h.sessionID, "Use the tool");
    const interrupted = await waitForRun(h.store, run.id);
    expect(interrupted.status).toBe("interrupted");
    expect(toolRuns).toBe(1);

    await h.agent.resumeRun(run.id);
    const done = await waitForRun(h.store, run.id);
    expect(done.status).toBe("completed");
    expect(toolRuns).toBe(1);

    const steps = h.store.listRunSteps(run.id);
    expect(steps.filter((step) => step.stepKey === "model:0")).toHaveLength(1);
    expect(steps.filter((step) => step.stepKey === "tool:0:0:call_1")).toHaveLength(1);
    expect(steps.filter((step) => step.stepKey === "model:1").map((step) => step.status)).toEqual([
      "failed",
      "completed",
    ]);
  });

  test("resume re-runs a tool that was aborted by the user", async () => {
    let slowRuns = 0;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const h = setup(async function* () {
      calls++;
      if (calls === 1) {
        yield* toolCallResponse([{ id: "call_slow", name: "slow", args: {} }]);
        return;
      }
      yield { type: "text", delta: "done" };
      yield { type: "finish", reason: "stop" };
    });
    h.tools.register({
      name: "slow",
      description: "Wait for an abort",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        slowRuns++;
        if (slowRuns > 1) return { title: "Slow", output: "slow finished" };
        started();
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve();
          else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new DOMException("Aborted", "AbortError");
      },
    });

    const { run } = await h.agent.prompt(h.sessionID, "Use the slow tool");
    await startedPromise;
    h.agent.abort(h.sessionID);
    const aborted = await waitForRun(h.store, run.id);
    expect(aborted.status).toBe("aborted");
    expect(aborted.stopReason).toBe("user");
    expect(
      h.store.listRunSteps(run.id).find((step) => step.stepKey === "tool:0:0:call_slow")?.status,
    ).toBe("aborted");

    await h.agent.resumeRun(run.id);
    const done = await waitForRun(h.store, run.id);
    expect(done.status).toBe("completed");
    expect(slowRuns).toBe(2);
    expect(
      h.store
        .listRunSteps(run.id)
        .filter((step) => step.stepKey === "tool:0:0:call_slow")
        .map((step) => step.status),
    ).toEqual(["aborted", "completed"]);
    expect(h.store.listRunSteps(run.id).filter((step) => step.stepKey === "model:0")).toHaveLength(1);
  });

  test("resume finishes a run whose checkpoint is already done", async () => {
    const h = setup(() => textResponse("unused"));
    const user = h.store.createMessage(h.sessionID, "user");
    h.store.addPart(h.sessionID, user.id, "text", { text: "Hi" });
    const assistant = h.store.createMessage(h.sessionID, "assistant", "fake/model");
    const run = h.store.createRun({
      sessionID: h.sessionID,
      userMessageID: user.id,
      prompt: "Hi",
      mode: "chat",
      model: "fake/model",
      budget: normalizeRunBudget(undefined),
    });
    const step = h.store.createRunStep({
      runID: run.id,
      stepKey: "model:0",
      kind: "model",
      name: "model",
      messageID: assistant.id,
    });
    h.store.updateRun(run.id, {
      assistantMessageID: assistant.id,
      status: "interrupted",
      stopReason: "restart",
      endedAt: now(),
    });
    h.store.createRunCheckpoint(run.id, {
      version: 1,
      loopStep: 0,
      phase: "done",
      assistantMessageID: assistant.id,
      modelStepID: step.id,
      toolCalls: [],
      nextToolIndex: 0,
    });

    const resumed = await h.agent.resumeRun(run.id);
    expect(resumed.status).toBe("completed");
    expect(h.registry.calls).toHaveLength(0);
    expect(h.store.getRunStep(step.id)?.status).toBe("completed");
  });

  test("resume reuses a linked completed research job", async () => {
    const h = setup(() => textResponse("final answer"));
    registerResearchTool(h);
    const job = h.store.createResearchJob({
      sessionID: h.sessionID,
      question: "What changed?",
      depth: "quick",
    });
    h.store.updateResearchJob(job.id, {
      status: "done",
      report: "# Report\n\nIt changed [s1].",
      outputPath: "/tmp/report.md",
    });
    const { runID, toolStepID } = interruptedResearchRun(h, {
      question: "What changed?",
      jobID: job.id,
    });

    await h.agent.resumeRun(runID);
    const done = await waitForRun(h.store, runID);
    expect(done.status).toBe("completed");
    expect(h.store.listResearchJobs(h.sessionID)).toHaveLength(1);

    expect(h.store.getRunStep(toolStepID)?.status).toBe("aborted");
    const step = h.store.latestRunStep(runID, "tool:0:0:call_research")!;
    expect(step.status).toBe("completed");
    expect(step.attempt).toBe(2);
    expect(step.refID).toBe(job.id);
    expect(step.output).toContain("It changed");

    const toolPart = h.store
      .getSessionDetail(h.sessionID)!
      .messages.flatMap((entry) => entry.parts)
      .find((part) => part.type === "tool" && part.data.callID === "call_research");
    expect(toolPart?.type).toBe("tool");
    if (toolPart?.type === "tool") expect(toolPart.data.output).toContain("It changed");
  });

  test("resume links an unlinked completed research job instead of starting another", async () => {
    const h = setup(() => textResponse("final answer"));
    registerResearchTool(h);
    const { runID, toolStepID } = interruptedResearchRun(h, {
      question: "What changed?",
      jobID: null,
    });
    const job = h.store.createResearchJob({
      sessionID: h.sessionID,
      question: "What changed?",
      depth: "quick",
    });
    h.store.updateResearchJob(job.id, {
      status: "done",
      report: "# Report\n\nRecovered [s1].",
      outputPath: "/tmp/report.md",
    });

    await h.agent.resumeRun(runID);
    const done = await waitForRun(h.store, runID);
    expect(done.status).toBe("completed");
    expect(h.store.listResearchJobs(h.sessionID)).toHaveLength(1);
    expect(h.store.getRunStep(toolStepID)?.status).toBe("aborted");
    expect(h.store.latestRunStep(runID, "tool:0:0:call_research")?.refID).toBe(job.id);
  });

  test("resume reuses an answered question instead of asking again", async () => {
    const h = setup(() => textResponse("final"));
    h.tools.register({
      name: "ask",
      description: "Ask the user",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        const response = await ctx.ask({
          question: "Proceed?",
          options: [{ label: "Yes" }, { label: "No" }],
        });
        return { title: "Asked", output: `answer:${response.answer.join(",")}` };
      },
    });

    const user = h.store.createMessage(h.sessionID, "user");
    h.store.addPart(h.sessionID, user.id, "text", { text: "Ask me" });
    const assistant = h.store.createMessage(h.sessionID, "assistant", "fake/model");
    const run = h.store.createRun({
      sessionID: h.sessionID,
      userMessageID: user.id,
      prompt: "Ask me",
      mode: "chat",
      model: "fake/model",
      budget: normalizeRunBudget(undefined),
    });
    const modelStep = h.store.createRunStep({
      runID: run.id,
      stepKey: "model:0",
      kind: "model",
      name: "model",
      messageID: assistant.id,
    });
    h.store.updateRunStep(modelStep.id, { status: "completed", endedAt: now() });
    h.store.addPart(h.sessionID, assistant.id, "tool", {
      callID: "call_ask",
      name: "ask",
      args: {},
      status: "running",
      startedAt: now(),
    });
    h.store.addPart(h.sessionID, assistant.id, "question", {
      questionID: "q_saved",
      question: "Proceed?",
      options: [{ label: "Yes" }, { label: "No" }],
      multiple: false,
      allowCustom: true,
      callID: "call_ask",
      status: "answered",
      answer: ["Yes"],
    });
    h.store.createRunStep({
      runID: run.id,
      stepKey: "tool:0:0:call_ask",
      kind: "tool",
      name: "ask",
      messageID: assistant.id,
      callID: "call_ask",
    });
    h.store.updateRun(run.id, {
      assistantMessageID: assistant.id,
      status: "interrupted",
      stopReason: "restart",
      endedAt: now(),
    });
    h.store.createRunCheckpoint(run.id, {
      version: 1,
      loopStep: 0,
      phase: "tools",
      assistantMessageID: assistant.id,
      modelStepID: modelStep.id,
      toolCalls: [{ id: "call_ask", name: "ask", args: {} }],
      nextToolIndex: 0,
    });

    await h.agent.resumeRun(run.id);
    const done = await waitForRun(h.store, run.id);
    expect(done.status).toBe("completed");

    const step = h.store.latestRunStep(run.id, "tool:0:0:call_ask")!;
    expect(step.status).toBe("completed");
    expect(step.output).toContain("answer:Yes");
    const questions = h.store
      .getSessionDetail(h.sessionID)!
      .messages.flatMap((entry) => entry.parts)
      .filter((part) => part.type === "question");
    expect(questions).toHaveLength(1);
    if (questions[0]?.type === "question") expect(questions[0].data.status).toBe("answered");
  });
});

describe("Agent retry and fallback", () => {
  test("retries a transient failure before any content", async () => {
    const h = setup(
      (_ref, _request, call) => {
        if (call === 1) throw Object.assign(new Error("provider: HTTP 429"), { status: 429 });
        return textResponse("recovered", { input: 3, output: 2, total: 5 });
      },
      {
        config: (config) => {
          config.agent.retry.attempts = 2;
          config.agent.retry.baseDelayMs = 0;
        },
      },
    );

    const { run } = await h.agent.prompt(h.sessionID, "Hi");
    const done = await waitForRun(h.store, run.id);

    expect(done.status).toBe("completed");
    expect(done.usage.totalTokens).toBe(5);
    const steps = h.store.listRunSteps(run.id).filter((step) => step.kind === "model");
    expect(steps.map((step) => step.attempt)).toEqual([1, 2]);
    expect(steps[0]!.status).toBe("failed");
    expect(steps[1]!.status).toBe("completed");
    const assistant = h.store
      .getSessionDetail(h.sessionID)!
      .messages.find((entry) => entry.message.role === "assistant")!;
    const texts = assistant.parts.filter((part) => part.type === "text");
    expect(texts).toHaveLength(1);
    if (texts[0]?.type === "text") expect(texts[0].data.text).toBe("recovered");
  });

  test("falls back to the next model after the primary is exhausted", async () => {
    const h = setup(
      (ref) => {
        if (ref === "fake/model") {
          throw Object.assign(new Error("provider: HTTP 503"), { status: 503 });
        }
        return textResponse("backup answer", { input: 4, output: 2, total: 6 });
      },
      {
        models: { "fake/model": {}, "fake/backup": {} },
        config: (config) => {
          config.agent.retry.attempts = 2;
          config.agent.retry.baseDelayMs = 0;
          config.agent.fallback = ["fake/backup"];
        },
      },
    );

    const { run } = await h.agent.prompt(h.sessionID, "Hi");
    const done = await waitForRun(h.store, run.id);

    expect(done.status).toBe("completed");
    expect(done.usage.totalTokens).toBe(6);
    const steps = h.store.listRunSteps(run.id).filter((step) => step.kind === "model");
    expect(steps.map((step) => step.model)).toEqual(["fake/model", "fake/model", "fake/backup"]);
    expect(steps.map((step) => step.attempt)).toEqual([1, 2, 3]);
    const assistant = h.store
      .getSessionDetail(h.sessionID)!
      .messages.find((entry) => entry.message.role === "assistant")!;
    expect(assistant.message.model).toBe("fake/backup");
  });

  test("does not retry or fall back after content has streamed", async () => {
    const h = setup(
      async function* (ref) {
        if (ref === "fake/model") {
          yield { type: "text", delta: "partial" };
          throw Object.assign(new Error("provider: HTTP 500"), { status: 500 });
        }
        yield { type: "text", delta: "backup" };
        yield { type: "finish", reason: "stop" as const };
      },
      {
        models: { "fake/model": {}, "fake/backup": {} },
        config: (config) => {
          config.agent.retry.attempts = 3;
          config.agent.retry.baseDelayMs = 0;
          config.agent.fallback = ["fake/backup"];
        },
      },
    );

    const { run } = await h.agent.prompt(h.sessionID, "Hi");
    const done = await waitForRun(h.store, run.id);

    expect(done.status).toBe("interrupted");
    expect(done.stopReason).toBe("error");
    expect(h.registry.calls.filter((call) => call.ref === "fake/model")).toHaveLength(1);
    expect(h.registry.calls.some((call) => call.ref === "fake/backup")).toBe(false);
    const steps = h.store.listRunSteps(run.id).filter((step) => step.kind === "model");
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe("failed");
  });

  test("runs a text-only fallback without tool schemas", async () => {
    const toolsSeen: number[] = [];
    const h = setup(
      (ref, request) => {
        if (ref === "fake/model") {
          throw Object.assign(new Error("provider: HTTP 429"), { status: 429 });
        }
        toolsSeen.push(request.tools?.length ?? 0);
        return textResponse("text only");
      },
      {
        models: { "fake/model": {}, "fake/backup": { supportsTools: false } },
        config: (config) => {
          config.agent.retry.attempts = 1;
          config.agent.retry.baseDelayMs = 0;
          config.agent.fallback = ["fake/backup"];
        },
      },
    );

    const { run } = await h.agent.prompt(h.sessionID, "Hi");
    const done = await waitForRun(h.store, run.id);

    expect(done.status).toBe("completed");
    expect(toolsSeen).toEqual([0]);
  });
});

describe("Agent run budgets", () => {
  test("stops a run when the token budget is exceeded", async () => {
    const h = setup(() => textResponse("hello", { input: 6, output: 4, total: 10 }), {
      config: (config) => {
        config.agent.budget.maxTokens = 5;
      },
    });

    const { run } = await h.agent.prompt(h.sessionID, "Hi");
    const done = await waitForRun(h.store, run.id);

    expect(done.status).toBe("aborted");
    expect(done.stopReason).toBe("budget");
    expect(done.error).toContain("max 5 tokens");
    expect(done.usage.totalTokens).toBe(10);

    const assistant = h.store
      .getSessionDetail(h.sessionID)!
      .messages.find((entry) => entry.message.role === "assistant")!;
    expect(assistant.parts.some((part) => part.type === "error" && part.data.message.includes("budget"))).toBe(true);
    expect(h.events.some((event) => event.type === "session.error")).toBe(true);
    await expect(h.agent.resumeRun(run.id)).rejects.toThrow("budget");
  });

  test("stops before starting a tool that would exceed the call limit", async () => {
    const h = setup(
      (_ref, _request, call) =>
        call <= 2
          ? toolCallResponse([{ id: `call_${call}`, name: "echo", args: { value: String(call) } }])
          : textResponse("done"),
      {
        config: (config) => {
          config.agent.budget.maxToolCalls = 1;
        },
      },
    );

    const { run } = await h.agent.prompt(h.sessionID, "Use tools");
    const done = await waitForRun(h.store, run.id);

    expect(done.status).toBe("aborted");
    expect(done.stopReason).toBe("budget");
    expect(done.error).toContain("max 1 tool calls");
    expect(done.usage.toolCalls).toBe(1);
    expect(h.store.listRunSteps(run.id).filter((step) => step.kind === "tool" && step.status === "completed")).toHaveLength(1);
  });

  test("stops after a fetch exceeds the crawl limit", async () => {
    const h = setup(
      (_ref, _request, call) =>
        call <= 2
          ? toolCallResponse([
              { id: `call_${call}`, name: "fetch_url", args: { url: `https://example.com/${call}` } },
            ])
          : textResponse("done"),
      {
        config: (config) => {
          config.agent.budget.maxCrawlPages = 1;
        },
      },
    );
    h.tools.register({
      name: "fetch_url",
      description: "Fetch one page",
      parameters: { type: "object", properties: { url: { type: "string" } } },
      async execute(args) {
        const url = String(args.url ?? "");
        return {
          title: "Fetched",
          output: `page:${url}`,
          sources: [{ sourceID: "s1", url, title: "Page" }],
        };
      },
    });

    const { run } = await h.agent.prompt(h.sessionID, "Fetch pages");
    const done = await waitForRun(h.store, run.id);

    expect(done.status).toBe("aborted");
    expect(done.stopReason).toBe("budget");
    expect(done.error).toContain("max 1 crawled pages");
    expect(done.usage.crawlPages).toBe(2);
  });
});
