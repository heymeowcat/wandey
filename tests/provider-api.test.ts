import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, resolvePaths, type Paths } from "../src/core/config.ts";
import { startServer, type WandeyServer } from "../src/server/server.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wandey-provider-test-"));

afterAll(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

async function withServer(fn: (server: WandeyServer, paths: Paths) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(temp, "case-"));
  const config = structuredClone(DEFAULTS);
  config.providers = {};
  config.integrations = { opencode: false, opencodeLocal: false };
  config.server = { ...config.server, openBrowser: false };
  config.storage.dir = home;
  config.research.outputDir = path.join(home, "research");
  const paths = resolvePaths({ WANDEY_HOME: home });
  const server = await startServer({ config, paths, port: 0, openBrowser: false });
  try {
    await fn(server, paths);
  } finally {
    await server.stop();
  }
}

async function postProvider(
  server: WandeyServer,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${server.url}/api/providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("provider API", () => {
  test("rejects duplicate custom names and built-in id collisions", async () => {
    await withServer(async (server) => {
      const first = await postProvider(server, {
        name: "Test Endpoint",
        baseUrl: "http://127.0.0.1:1/v1",
        models: ["test-model"],
      });
      expect(first.status).toBe(201);

      const duplicate = await postProvider(server, {
        name: "Test Endpoint",
        baseUrl: "http://127.0.0.1:2/v1",
        models: ["other-model"],
      });
      expect(duplicate.status).toBe(409);

      const builtIn = await postProvider(server, {
        name: "OpenAI",
        baseUrl: "https://example.com/v1",
      });
      expect(builtIn.status).toBe(409);
    });
  });

  test("requires a key for remote Anthropic and Gemini endpoints", async () => {
    await withServer(async (server) => {
      const anthropic = await postProvider(server, {
        name: "Anthropic Proxy",
        kind: "anthropic",
        baseUrl: "https://example.com",
        models: ["claude-test"],
      });
      expect(anthropic.status).toBe(400);
      expect(anthropic.body.error).toMatch(/needs an API key/i);

      const gemini = await postProvider(server, {
        name: "Gemini Proxy",
        kind: "gemini",
        baseUrl: "https://example.com",
        models: ["gemini-test"],
      });
      expect(gemini.status).toBe(400);
      expect(gemini.body.error).toMatch(/needs an API key/i);
    });
  });

  test("keeps disconnected custom providers visible and removes saved secrets", async () => {
    await withServer(async (server, paths) => {
      const created = await postProvider(server, {
        name: "Private Proxy",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "secret-key",
        models: ["test-model"],
      });
      expect(created.status).toBe(201);
      expect(created.body.provider?.id).toBe("private-proxy");

      const response = await fetch(`${server.url}/api/providers/private-proxy`, { method: "DELETE" });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { catalog: Array<Record<string, any>> };
      const entry = body.catalog.find((item) => item.id === "private-proxy");
      expect(entry).toMatchObject({
        id: "private-proxy",
        custom: true,
        configured: true,
        disabled: true,
        connected: false,
      });

      const raw = JSON.parse(fs.readFileSync(paths.configFile, "utf8")) as {
        providers: Record<string, Record<string, unknown>>;
      };
      expect(raw.providers["private-proxy"]?.enabled).toBe(false);
      expect(raw.providers["private-proxy"]?.apiKey).toBeUndefined();
      expect(raw.providers["private-proxy"]?.apiKeyEnv).toBeUndefined();
      expect(raw.providers["private-proxy"]?.headers).toBeUndefined();
    });
  });
});
