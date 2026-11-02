/**
 * Live smoke test for durable runs.
 *
 * Usage:
 *   bun scripts/smoke-runs.ts [provider/model]
 *
 * Exercises the run ledger against a real provider:
 *   1. a short completed run;
 *   2. a run aborted mid-stream, then resumed;
 *   3. the same database reopened, proving restart recovery and resume;
 *   4. a token budget stop.
 *
 * It uses a temporary database so it never touches ~/.wandey. Not part of
 * `bun test` because it calls a real model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { EventBus } from "../src/core/events.ts";
import type { Run, ServerEvent } from "../src/core/types.ts";
import { Agent } from "../src/agent/agent.ts";
import { PageFetcher } from "../src/crawl/fetcher.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { SearchService } from "../src/search/search.ts";
import { Store } from "../src/storage/store.ts";
import { createToolRegistry } from "../src/tools/index.ts";

const model = process.argv[2] || "opencode-local/beam-free";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wandey-runs-smoke-"));
const dbFile = path.join(dir, "wandey.db");

const base = loadConfig().config;
base.integrations.opencodeLocal = true;
base.agent.model = model;
base.agent.autoTitle = false;
base.agent.retry = { attempts: 2, baseDelayMs: 500 };
base.agent.fallback = [];

function makeAgent(config: Config, store: Store): { agent: Agent; bus: EventBus; registry: ProviderRegistry } {
  const bus = new EventBus();
  const registry = new ProviderRegistry(config);
  const agent = new Agent({
    config,
    store,
    registry,
    tools: createToolRegistry(),
    fetcher: new PageFetcher(config.crawl),
    search: new SearchService(config),
    bus,
  });
  bus.on((event) => {
    if (event.type === "session.error") console.log("  error:", event.message);
    if (event.type === "run.updated" && event.run.status !== "running") {
      console.log(`  run ${event.run.status}${event.run.stopReason ? ` (${event.run.stopReason})` : ""}`);
    }
  });
  return { agent, bus, registry };
}

async function waitIdle(agent: Agent, sessionID: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (agent.isRunning(sessionID) && Date.now() < deadline) await Bun.sleep(150);
  if (agent.isRunning(sessionID)) throw new Error("run did not finish before the timeout");
}

function firstTextDelta(bus: EventBus, sessionID: string): Promise<void> {
  return new Promise((resolve) => {
    const off = bus.on((event: ServerEvent) => {
      if (event.type === "part.delta" && event.sessionID === sessionID && event.kind === "text") {
        off();
        resolve();
      }
    });
  });
}

function printRun(run: Run): void {
  const steps = store.listRunSteps(run.id);
  console.log(
    `  ${run.status}/${run.stopReason ?? "-"} · ${run.usage.totalTokens} tokens · ` +
      `${steps.length} steps · resumes ${run.resumeCount} · ${run.usage.elapsedMs}ms`,
  );
  for (const step of steps) {
    console.log(
      `    #${step.ordinal} ${step.kind} ${step.name} attempt ${step.attempt} ${step.status}` +
        `${step.error ? ` · ${step.error}` : ""}`,
    );
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

console.log(`model ${model}`);
console.log(`db    ${dbFile}`);

let store = new Store(dbFile);
let harness = makeAgent(base, store);
let agent = harness.agent;
let bus = harness.bus;

// 1. A normal completed run.
const session = store.createSession({ title: "Run smoke" });
console.log("\n[1] completed run");
const first = await agent.prompt(session.id, "Reply with exactly: ready. Do not use any tools.");
await waitIdle(agent, session.id);
const completed = store.getRun(first.run.id)!;
printRun(completed);
expect(completed.status === "completed", `expected completed, got ${completed.status}`);
expect(store.listRunSteps(completed.id).some((step) => step.kind === "model" && step.status === "completed"), "no completed model step");

// 2. Abort after the first token, then resume the same run.
console.log("\n[2] abort and resume");
const delta = firstTextDelta(bus, session.id);
const second = await agent.prompt(
  session.id,
  "Write three short paragraphs about why deterministic tests matter. Do not use any tools.",
);
await delta;
agent.abort(session.id);
await waitIdle(agent, session.id);
const stopped = store.getRun(second.run.id)!;
printRun(stopped);
expect(stopped.resumeCount === 0, "fresh run should not have been resumed yet");
expect(stopped.status === "aborted" || stopped.status === "interrupted", `unexpected stopped status ${stopped.status}`);

// 3. Reopen the database, recover, and resume. This is the restart path.
console.log("\n[3] restart and resume");
harness.registry.stop();
store.close();
store = new Store(dbFile);
harness = makeAgent(base, store);
agent = harness.agent;
bus = harness.bus;
const recovered = store.getRun(second.run.id)!;
console.log(`  after reopen: ${recovered.status}/${recovered.stopReason ?? "-"}`);
expect(recovered.status === "aborted" || recovered.status === "interrupted", "stopped run changed status on reopen");

const resumed = await agent.resumeRun(second.run.id);
expect(resumed.resumeCount === 1, "resume count did not advance");
await waitIdle(agent, session.id);
const finished = store.getRun(second.run.id)!;
printRun(finished);
expect(finished.status === "completed", `resumed run ended ${finished.status}: ${finished.error ?? ""}`);

// 4. A deliberately tiny token budget stops the run terminally.
console.log("\n[4] budget stop");
const budgetConfig: Config = structuredClone(base);
budgetConfig.agent.budget = {
  ...budgetConfig.agent.budget,
  maxTokens: 1,
  maxCostUsd: 0,
  maxSeconds: 0,
  maxToolCalls: 0,
  maxCrawlPages: 0,
};
const budgetSession = store.createSession({ title: "Budget smoke" });
const budgetHarness = makeAgent(budgetConfig, store);
const budgetAgent = budgetHarness.agent;
const budgetRun = await budgetAgent.prompt(budgetSession.id, "Write one long paragraph about durable runs.");
await waitIdle(budgetAgent, budgetSession.id);
const stoppedByBudget = store.getRun(budgetRun.run.id)!;
printRun(stoppedByBudget);
expect(stoppedByBudget.stopReason === "budget", `expected a budget stop, got ${stoppedByBudget.stopReason}`);
await expectResumeRejected(budgetAgent, budgetRun.run.id);

budgetHarness.registry.stop();
harness.registry.stop();
store.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("\nPASS");

async function expectResumeRejected(target: Agent, runID: string): Promise<void> {
  try {
    await target.resumeRun(runID);
  } catch (err) {
    if ((err as Error).message.includes("budget")) return;
    throw err;
  }
  throw new Error("budget-stopped run should not resume");
}
