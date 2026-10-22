import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULTS,
  loadConfig,
  mergeConfig,
  redactConfig,
  resolvePaths,
  saveConfig,
} from "../src/core/config.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wandey-config-test-"));

afterAll(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("mergeConfig", () => {
  test("merges nested settings without losing defaults", () => {
    const merged = mergeConfig(DEFAULTS, {
      crawl: {
        ...DEFAULTS.crawl,
        maxDepth: 9,
        pdf: { ...DEFAULTS.crawl.pdf, enabled: false },
      },
      agent: { ...DEFAULTS.agent, temperature: 0.9 },
    });
    expect(merged.crawl.maxDepth).toBe(9);
    expect(merged.crawl.pdf.enabled).toBe(false);
    expect(merged.crawl.concurrency).toBe(DEFAULTS.crawl.concurrency);
    expect(merged.agent.temperature).toBe(0.9);
    expect(merged.agent.maxSteps).toBe(DEFAULTS.agent.maxSteps);
  });

  test("replaces search provider arrays instead of concatenating them", () => {
    const merged = mergeConfig(DEFAULTS, {
      search: { ...DEFAULTS.search, providers: [{ type: "brave" }] },
    });
    expect(merged.search.providers).toEqual([{ type: "brave" }]);
  });
});

describe("resolvePaths and WANDEY_HOME", () => {
  test("WANDEY_HOME isolates config, database, and cache", () => {
    const home = tempDir("home");
    const paths = resolvePaths({ WANDEY_HOME: home });
    expect(paths.home).toBe(home);
    expect(paths.configFile).toBe(path.join(home, "config.json"));
    expect(paths.dbFile).toBe(path.join(home, "wandey.db"));
    expect(paths.cacheDir).toBe(path.join(home, "cache"));
  });

  test("WANDEY_CONFIG wins over the default config location", () => {
    const home = tempDir("config-priority");
    const file = path.join(home, "custom.json");
    const paths = resolvePaths({ WANDEY_HOME: home, WANDEY_CONFIG: file });
    expect(paths.configFile).toBe(file);
  });
});

describe("loadConfig", () => {
  test("WANDEY_HOME is used for storage when config does not override it", () => {
    const home = tempDir("storage-home");
    const loaded = loadConfig({ WANDEY_HOME: home });
    expect(loaded.config.storage.dir).toBe(home);
    expect(loaded.config.research.outputDir).toBe(path.join(home, "research"));
    expect(loaded.paths.home).toBe(home);
    expect(loaded.paths.dbFile).toBe(path.join(home, "wandey.db"));
  });

  test("explicit storage paths win over WANDEY_HOME", () => {
    const home = tempDir("storage-home-override");
    const storage = tempDir("storage-explicit");
    const configFile = path.join(home, "config.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        storage: { dir: storage },
        agent: { model: "ollama/qwen" },
        research: { outputDir: path.join(storage, "reports") },
      }),
    );

    const loaded = loadConfig({ WANDEY_HOME: home, WANDEY_CONFIG: configFile });
    expect(loaded.config.storage.dir).toBe(storage);
    expect(loaded.config.research.outputDir).toBe(path.join(storage, "reports"));
    expect(loaded.paths.dbFile).toBe(path.join(storage, "wandey.db"));
    expect(loaded.config.agent.model).toBe("ollama/qwen");
    expect(loaded.config.agent.maxSteps).toBe(DEFAULTS.agent.maxSteps);
  });

  test("reads server and agent overrides, including environment flags", () => {
    const home = tempDir("env-flags");
    const configFile = path.join(home, "config.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        storage: { dir: home },
        server: { host: "0.0.0.0", port: 5000, openBrowser: true },
        agent: { temperature: 0.1 },
      }),
    );

    const loaded = loadConfig({
      WANDEY_CONFIG: configFile,
      WANDEY_PORT: "5555",
      WANDEY_HOST: "127.0.0.1",
      WANDEY_NO_OPEN: "1",
    });
    expect(loaded.config.server.port).toBe(5555);
    expect(loaded.config.server.host).toBe("127.0.0.1");
    expect(loaded.config.server.openBrowser).toBe(false);
    expect(loaded.config.agent.temperature).toBe(0.1);
  });

  test("imports provider keys and optional search providers from the environment", () => {
    const home = tempDir("env-providers");
    const loaded = loadConfig({
      WANDEY_HOME: home,
      OPENROUTER_API_KEY: "sk-test",
      SEARXNG_URL: "http://127.0.0.1:8080",
    });

    expect(loaded.config.providers.openrouter?.apiKeyEnv).toBe("OPENROUTER_API_KEY");
    expect(loaded.config.providers.openrouter?.auto).toBe("env");
    expect(loaded.config.search.providers.map((provider) => provider.type)).toEqual([
      "searxng",
      "bing",
      "wikipedia",
    ]);
  });

  test("throws a useful error for invalid JSON", () => {
    const home = tempDir("invalid");
    const configFile = path.join(home, "config.json");
    fs.writeFileSync(configFile, "{ not json");
    expect(() => loadConfig({ WANDEY_CONFIG: configFile })).toThrow(/Invalid config/);
  });
});

describe("saveConfig", () => {
  test("writes merged configuration and strips machine-specific providers", () => {
    const home = tempDir("save");
    const configFile = path.join(home, "config.json");
    const paths = resolvePaths({ WANDEY_HOME: home, WANDEY_CONFIG: configFile });
    saveConfig(
      {
        storage: { dir: home },
        server: { ...DEFAULTS.server, port: 6789 },
        agent: { ...DEFAULTS.agent, model: "ollama/qwen" },
      },
      paths,
    );

    const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as {
      server: { port: number };
      agent: { model: string };
      providers: Record<string, { auto?: string }>;
    };
    expect(raw.server.port).toBe(6789);
    expect(raw.agent.model).toBe("ollama/qwen");
    expect(Object.values(raw.providers).some((provider) => provider.auto)).toBe(false);

    const loaded = loadConfig({ WANDEY_HOME: home, WANDEY_CONFIG: configFile });
    expect(loaded.config.server.port).toBe(6789);
  });
});

describe("redactConfig", () => {
  test("removes secrets while preserving useful settings", () => {
    const config = structuredClone(DEFAULTS);
    config.providers.custom = {
      kind: "openai",
      apiKey: "secret",
      headers: { Authorization: "Bearer secret", "X-Trace": "keep" },
    };
    config.search.providers = [{ type: "brave", apiKey: "secret" }];
    config.crawl.render.apiKey = "secret";
    config.crawl.render.endpoint = "https://render.test";

    const redacted = redactConfig(config);
    expect(redacted.providers.custom?.apiKey).toBe("•••");
    expect(redacted.providers.custom?.headers?.Authorization).toBe("•••");
    expect(redacted.providers.custom?.headers?.["X-Trace"]).toBe("keep");
    expect(redacted.search.providers[0]).toEqual({ type: "brave", apiKey: "•••" });
    expect(redacted.crawl.render.apiKey).toBe("•••");
    expect(redacted.crawl.render.endpoint).toBe("https://render.test");
    expect(redacted.providers.custom?.auto).toBeUndefined();
  });
});
