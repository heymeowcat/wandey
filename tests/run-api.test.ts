import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, resolvePaths, type Paths } from "../src/core/config.ts";
import { normalizeRunBudget } from "../src/core/run-usage.ts";
import type { ServerEvent } from "../src/core/types.ts";
import { startServer, type WandeyServer } from "../src/server/server.ts";
import { Store } from "../src/storage/store.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wandey-run-api-test-"));

afterAll(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

function testPaths(home: string): Paths {
  const config = structuredClone(DEFAULTS);
  config.providers = {};
  config.integrations = { opencode: false, opencodeLocal: false };
  config.server = { ...config.server, openBrowser: false };
  config.storage.dir = home;
  config.research.outputDir = path.join(home, "research");
  return resolvePaths({ WANDEY_HOME: home });
}

async function withServer(fn: (server: WandeyServer, paths: Paths) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(temp, "case-"));
  const paths = testPaths(home);
  const server = await startServer({ config: structuredClone(DEFAULTS), paths, port: 0, openBrowser: false });
  try {
    await fn(server, paths);
  } finally {
    await server.stop();
  }
}

function seedRun(server: WandeyServer, options: { status?: "running" | "interrupted" } = {}) {
  const session = server.store.createSession({ title: "Run API session" });
  const user = server.store.createMessage(session.id, "user");
  server.store.addPart(session.id, user.id, "text", { text: "Research this" });
  const run = server.store.createRun({
    sessionID: session.id,
    userMessageID: user.id,
    prompt: "Research this",
    mode: "chat",
    model: "fake/model",
    budget: normalizeRunBudget({}),
  });
  if (options.status === "running") return { session, run };
  const interrupted =
    server.store.updateRun(run.id, { status: "interrupted", stopReason: "error", endedAt: Date.now() }) ?? run;
  return { session, run: interrupted };
}

async function getJSON(url: string): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function post(url: string): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(url, { method: "POST" });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("run API", () => {
  test("includes recent runs in the session detail", async () => {
    await withServer(async (server) => {
      const { session, run } = seedRun(server);
      const response = await getJSON(`${server.url}/api/sessions/${session.id}`);
      expect(response.status).toBe(200);
      expect(response.body.runs).toHaveLength(1);
      expect(response.body.runs[0].id).toBe(run.id);
    });
  });

  test("returns a run with its steps and checkpoints", async () => {
    await withServer(async (server) => {
      const { run } = seedRun(server);
      const step = server.store.createRunStep({
        runID: run.id,
        stepKey: "model:0",
        kind: "model",
        name: "model",
        attempt: 1,
        model: "fake/model",
      });
      const checkpoint = server.store.createRunCheckpoint(run.id, {
        version: 1,
        loopStep: 0,
        phase: "model",
        assistantMessageID: null,
        modelStepID: step.id,
        toolCalls: [],
        nextToolIndex: 0,
      });

      const response = await getJSON(`${server.url}/api/runs/${run.id}`);
      expect(response.status).toBe(200);
      expect(response.body.run.id).toBe(run.id);
      expect(response.body.steps.map((entry: any) => entry.id)).toEqual([step.id]);
      expect(response.body.checkpoints.map((entry: any) => entry.id)).toEqual([checkpoint.id]);
    });
  });

  test("returns 404 for an unknown run", async () => {
    await withServer(async (server) => {
      const response = await getJSON(`${server.url}/api/runs/run_missing`);
      expect(response.status).toBe(404);
    });
  });

  test("resumes an interrupted run and rejects a running one", async () => {
    await withServer(async (server) => {
      const { run: interrupted } = seedRun(server);
      server.store.createRunCheckpoint(interrupted.id, {
        version: 1,
        loopStep: 0,
        phase: "done",
        assistantMessageID: null,
        modelStepID: null,
        toolCalls: [],
        nextToolIndex: 0,
      });

      const resumed = await post(`${server.url}/api/runs/${interrupted.id}/resume`);
      expect(resumed.status).toBe(202);
      expect(resumed.body.run.status).toBe("completed");

      const { run: running } = seedRun(server, { status: "running" });
      const rejected = await post(`${server.url}/api/runs/${running.id}/resume`);
      expect(rejected.status).toBe(409);
      expect(rejected.body.error).toContain("already running");
    });
  });

  test("dismisses a stopped run but refuses a running one", async () => {
    await withServer(async (server) => {
      const events: ServerEvent[] = [];
      server.bus.on((event) => events.push(event));

      const { run } = seedRun(server);
      const dismissed = await post(`${server.url}/api/runs/${run.id}/dismiss`);
      expect(dismissed.status).toBe(200);
      expect(dismissed.body.run.dismissedAt).toEqual(expect.any(Number));
      expect(
        events.some(
          (event) => event.type === "run.updated" && event.run.id === run.id && event.run.dismissedAt !== null,
        ),
      ).toBe(true);

      const { run: running } = seedRun(server, { status: "running" });
      const rejected = await post(`${server.url}/api/runs/${running.id}/dismiss`);
      expect(rejected.status).toBe(409);
    });
  });

  test("recovers runs left running by a dead process", async () => {
    const home = fs.mkdtempSync(path.join(temp, "recover-"));
    const paths = testPaths(home);
    fs.mkdirSync(paths.home, { recursive: true });

    const store = new Store(paths.dbFile);
    const session = store.createSession({ title: "Stale" });
    const user = store.createMessage(session.id, "user");
    const run = store.createRun({
      sessionID: session.id,
      userMessageID: user.id,
      prompt: "Stale",
      mode: "chat",
      model: "fake/model",
      budget: normalizeRunBudget({}),
    });
    store.close();

    const server = await startServer({ config: structuredClone(DEFAULTS), paths, port: 0, openBrowser: false });
    try {
      const response = await getJSON(`${server.url}/api/runs/${run.id}`);
      expect(response.status).toBe(200);
      expect(response.body.run.status).toBe("interrupted");
      expect(response.body.run.stopReason).toBe("restart");
    } finally {
      await server.stop();
    }
  });
});
