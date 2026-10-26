import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent.ts";
import { DEFAULTS, type Config } from "../src/core/config.ts";
import { EventBus } from "../src/core/events.ts";
import type { ServerEvent } from "../src/core/types.ts";
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
