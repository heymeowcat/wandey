import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderKind } from "./types.ts";
import { AUTO_LOCAL_PROVIDERS, PROVIDER_TEMPLATES, firstEnv, templateFor } from "../providers/catalog.ts";

/**
 * Configuration is deliberately a single JSON file.
 *
 * Resolution order:
 *   1. $WANDEY_CONFIG
 *   2. ./wandey.json (project-local)
 *   3. ~/.wandey/config.json
 *
 * Missing files are fine: defaults are complete. Env vars (API keys, ports)
 * fill in the gaps. Nothing is ever written unless the user runs `wandey config`.
 */

export interface ProviderConfig {
  kind?: ProviderKind;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Name of the env var holding the key, so keys can stay out of the file. */
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  /** Extra models to expose, useful for endpoints without a /models route. */
  models?: string[];
  enabled?: boolean;
  /** Local servers don't need a key, but may need a reachability check. */
  local?: boolean;
  /** Where this provider came from (not persisted). */
  auto?: "env" | "local" | "opencode";
  description?: string;
}

export type SearchProviderConfig =
  | { type: "searxng"; baseUrl: string; enabled?: boolean }
  | { type: "brave"; apiKey?: string; apiKeyEnv?: string; enabled?: boolean }
  | { type: "tavily"; apiKey?: string; apiKeyEnv?: string; enabled?: boolean }
  | { type: "exa"; apiKey?: string; apiKeyEnv?: string; enabled?: boolean }
  | { type: "duckduckgo"; enabled?: boolean }
  | { type: "bing"; enabled?: boolean }
  | { type: "wikipedia"; enabled?: boolean };

export interface CrawlConfig {
  concurrency: number;
  perHost: number;
  delayMs: number;
  timeoutMs: number;
  /** Refuse to buffer more than this many bytes for a single response. */
  maxContentBytes: number;
  /** Characters kept per page before handing content to the model. */
  maxCharsPerPage: number;
  /** Default page cap for a single crawl call. */
  maxPagesPerCall: number;
  maxDepth: number;
  respectRobots: boolean;
  useSitemaps: boolean;
  /** Fall back to a reader service when extraction comes back nearly empty. */
  readerFallback: boolean;
  readerEndpoint: string;
  userAgent: string;
  pdf: { enabled: boolean; command: string };
  /** Optional JS renderer. "none" keeps wandey dependency-free. */
  render: {
    backend: "none" | "firecrawl" | "crawl4ai" | "reader";
    endpoint: string;
    apiKey: string;
  };
}

export interface ResearchConfig {
  depth: "quick" | "standard" | "deep" | "exhaustive";
  rounds: number;
  /** Search queries generated per sub-question. */
  breadth: number;
  resultsPerQuery: number;
  pagesPerSubQuestion: number;
  maxSources: number;
  workers: number;
  outputDir: string;
  maxReportChars: number;
  /** Optional model overrides for planning/extraction/synthesis. */
  planModel: string;
  workerModel: string;
  synthModel: string;
}

export interface Config {
  server: {
    host: string;
    port: number;
    openBrowser: boolean;
  };
  agent: {
    /** Default model ref ("provider/model"). Empty means "first available". */
    model: string;
    maxSteps: number;
    temperature: number;
    /** Rough character budget before old turns are compacted. */
    contextChars: number;
    autoTitle: boolean;
    systemExtra: string;
    streamReasoning: boolean;
  };
  providers: Record<string, ProviderConfig>;
  integrations: {
    /** Reuse provider credentials that OpenCode already has on this machine. */
    opencode: boolean;
  };
  search: {
    providers: SearchProviderConfig[];
    maxResults: number;
  };
  crawl: CrawlConfig;
  research: ResearchConfig;
  storage: {
    dir: string;
  };
}

export interface Paths {
  home: string;
  configFile: string;
  dbFile: string;
  cacheDir: string;
}

export interface LoadedConfig {
  config: Config;
  paths: Paths;
}

export const DEFAULTS: Config = {
  server: {
    host: "127.0.0.1",
    port: 4319,
    openBrowser: true,
  },
  agent: {
    model: "",
    maxSteps: 24,
    temperature: 0.4,
    contextChars: 220_000,
    autoTitle: true,
    systemExtra: "",
    streamReasoning: true,
  },
  providers: {
    ollama: {
      kind: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      local: true,
      auto: "local",
    },
    lmstudio: {
      kind: "openai",
      baseUrl: "http://127.0.0.1:1234/v1",
      local: true,
      auto: "local",
    },
  },
  integrations: {
    opencode: true,
  },
  search: {
    providers: [
      { type: "bing" },
      { type: "wikipedia" },
    ],
    maxResults: 10,
  },
  crawl: {
    concurrency: 8,
    perHost: 2,
    delayMs: 300,
    timeoutMs: 20_000,
    maxContentBytes: 6 * 1024 * 1024,
    maxCharsPerPage: 80_000,
    maxPagesPerCall: 12,
    maxDepth: 1,
    respectRobots: true,
    useSitemaps: true,
    readerFallback: true,
    readerEndpoint: "https://r.jina.ai",
    userAgent: "wandey/0.1 (research agent)",
    pdf: { enabled: true, command: "pdftotext" },
    render: {
      backend: "none",
      endpoint: "",
      apiKey: "",
    },
  },
  research: {
    depth: "standard",
    rounds: 2,
    breadth: 4,
    resultsPerQuery: 8,
    pagesPerSubQuestion: 6,
    maxSources: 60,
    workers: 3,
    outputDir: "",
    maxReportChars: 50_000,
    planModel: "",
    workerModel: "",
    synthModel: "",
  },
  storage: { dir: "~/.wandey" },
};

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function resolvePaths(env: Record<string, string | undefined> = Bun.env): Paths {
  const home = path.resolve(expandHome(env.WANDEY_HOME?.trim() || "~/.wandey"));
  const envConfig = env.WANDEY_CONFIG?.trim();
  const cwdConfig = path.resolve(process.cwd(), "wandey.json");
  const configFile = envConfig
    ? path.resolve(expandHome(envConfig))
    : fs.existsSync(cwdConfig)
      ? cwdConfig
      : path.join(home, "config.json");
  return {
    home,
    configFile,
    dbFile: path.join(home, "wandey.db"),
    cacheDir: path.join(home, "cache"),
  };
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): LoadedConfig {
  const paths = resolvePaths(env);
  let raw: Partial<Config> = {};
  if (fs.existsSync(paths.configFile)) {
    try {
      raw = JSON.parse(fs.readFileSync(paths.configFile, "utf8")) as Partial<Config>;
    } catch (err) {
      throw new Error(`Invalid config at ${paths.configFile}: ${(err as Error).message}`);
    }
  }

  const config = mergeConfig(DEFAULTS, raw);
  // An explicit config wins. Otherwise WANDEY_HOME is the storage root, which
  // makes throwaway instances and tests genuinely isolated. The final fallback
  // is the normal ~/.wandey home.
  const storageDir = raw.storage?.dir?.trim() || env.WANDEY_HOME?.trim() || DEFAULTS.storage.dir;
  config.storage.dir = path.resolve(expandHome(storageDir));
  // The storage dir owns runtime data even when the config lives in a repo.
  paths.home = config.storage.dir;
  paths.dbFile = path.join(paths.home, "wandey.db");
  paths.cacheDir = path.join(paths.home, "cache");
  if (!config.research.outputDir.trim()) {
    config.research.outputDir = path.join(paths.home, "research");
  }

  applyPortEnv(config, env);
  applyEnvProviders(config, env);
  applyEnvSearch(config, env);
  return { config, paths };
}

export function mergeConfig(base: Config, patch: Partial<Config>): Config {
  const clone = structuredClone(base) as Config;
  const next: Config = {
    ...clone,
    server: { ...clone.server, ...(patch.server ?? {}) },
    agent: { ...clone.agent, ...(patch.agent ?? {}) },
    providers: { ...clone.providers, ...(patch.providers ?? {}) },
    integrations: { ...clone.integrations, ...(patch.integrations ?? {}) },
    search: {
      ...clone.search,
      ...(patch.search ?? {}),
      // Arrays are replaced, not merged: order matters for search fallbacks.
      providers: patch.search?.providers ?? clone.search.providers,
    },
    crawl: {
      ...clone.crawl,
      ...(patch.crawl ?? {}),
      pdf: { ...clone.crawl.pdf, ...(patch.crawl?.pdf ?? {}) },
      render: { ...clone.crawl.render, ...(patch.crawl?.render ?? {}) },
    },
    research: { ...clone.research, ...(patch.research ?? {}) },
    storage: { ...clone.storage, ...(patch.storage ?? {}) },
  };
  return next;
}

/** Add providers whose API key is already in the environment. */
function applyEnvProviders(config: Config, env: Record<string, string | undefined>): void {
  for (const template of Object.values(PROVIDER_TEMPLATES)) {
    if (config.providers[template.id]?.enabled === false) continue;
    // For local providers the env var is a host URL, not a secret.
    if (template.local) continue;
    const found = firstEnvFrom(template.env, env);
    if (!found) continue;
    const existing = config.providers[template.id];
    if (existing?.apiKey || existing?.apiKeyEnv) continue;
    config.providers[template.id] = {
      kind: template.kind,
      baseUrl: template.baseUrl,
      apiKeyEnv: found.name,
      name: template.name,
      auto: "env",
      ...(existing ?? {}),
    };
  }
  // Local servers are always probed; a dead port is skipped silently.
  for (const id of AUTO_LOCAL_PROVIDERS) {
    const template = templateFor(id);
    if (!template) continue;
    if (config.providers[id]?.enabled === false) continue;
    if (config.providers[id]) {
      config.providers[id]!.local ??= true;
    } else {
      config.providers[id] = {
        kind: template.kind,
        baseUrl: template.baseUrl,
        local: true,
        auto: "local",
      };
    }
  }
}

function applyEnvSearch(config: Config, env: Record<string, string | undefined>): void {
  // If the user explicitly configured search, respect it untouched.
  const userFile = fs.existsSync(resolvePaths(env).configFile)
    ? safeReadJson(resolvePaths(env).configFile)
    : null;
  if (userFile?.search?.providers) return;

  const auto: SearchProviderConfig[] = [];
  const searx = env.SEARXNG_URL?.trim();
  if (searx) auto.push({ type: "searxng", baseUrl: searx });
  const brave = firstEnvFrom(["BRAVE_API_KEY"], env);
  if (brave) auto.push({ type: "brave", apiKeyEnv: brave.name });
  const tavily = firstEnvFrom(["TAVILY_API_KEY"], env);
  if (tavily) auto.push({ type: "tavily", apiKeyEnv: tavily.name });
  const exa = firstEnvFrom(["EXA_API_KEY"], env);
  if (exa) auto.push({ type: "exa", apiKeyEnv: exa.name });
  if (auto.length > 0) {
    config.search.providers = [...auto, ...config.search.providers.filter((p) => p.type === "bing" || p.type === "duckduckgo" || p.type === "wikipedia")];
  }
}

function applyPortEnv(config: Config, env: Record<string, string | undefined>): void {
  const port = Number(env.WANDEY_PORT);
  if (Number.isInteger(port) && port > 0) config.server.port = port;
  if (env.WANDEY_HOST?.trim()) config.server.host = env.WANDEY_HOST.trim();
  if (env.WANDEY_NO_OPEN === "1") config.server.openBrowser = false;
}

function firstEnvFrom(names: string[], env: Record<string, string | undefined>): { name: string; value: string } | null {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim()) return { name, value: value.trim() };
  }
  return null;
}

function safeReadJson(file: string): Partial<Config> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>;
  } catch {
    return null;
  }
}

export function getApiKey(providerID: string, cfg: ProviderConfig): string | null {
  if (cfg.apiKey?.trim()) return cfg.apiKey.trim();
  if (cfg.apiKeyEnv) {
    const value = Bun.env[cfg.apiKeyEnv];
    if (value?.trim()) return value.trim();
  }
  const template = templateFor(providerID);
  if (template) {
    const found = firstEnv(template.env);
    if (found) return found.value;
  }
  return null;
}

/** Resolve inheritance from the catalog so adapters always get complete config. */
export function resolveProviderConfig(id: string, cfg: ProviderConfig): ProviderConfig {
  const template = templateFor(id);
  if (!template) return cfg;
  return {
    kind: cfg.kind ?? template.kind,
    name: cfg.name ?? template.name,
    baseUrl: cfg.baseUrl ?? template.baseUrl,
    description: cfg.description ?? template.description,
    ...cfg,
  };
}

/** Everything except secrets, for the HTTP API. */
export function redactConfig(config: Config): Config {
  const clean = structuredClone(config);
  for (const provider of Object.values(clean.providers)) {
    if (provider.apiKey) provider.apiKey = "•••";
    if (provider.headers) {
      for (const key of Object.keys(provider.headers)) {
        if (/auth|key|token/i.test(key)) provider.headers[key] = "•••";
      }
    }
    delete provider.auto;
  }
  for (const search of clean.search.providers) {
    if ("apiKey" in search && search.apiKey) search.apiKey = "•••";
  }
  clean.crawl.render.apiKey = clean.crawl.render.apiKey ? "•••" : "";
  return clean;
}

/** Persist a config patch, stripping machine-specific auto providers. */
export function saveConfig(patch: Partial<Config>, paths: Paths): Config {
  let current: Partial<Config> = {};
  if (fs.existsSync(paths.configFile)) {
    current = safeReadJson(paths.configFile) ?? {};
  }
  const merged = mergeConfig(mergeConfig(DEFAULTS, current), patch);
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, provider] of Object.entries(merged.providers)) {
    if (provider.auto) continue;
    providers[id] = provider;
  }
  const output = {
    server: merged.server,
    agent: merged.agent,
    providers,
    integrations: merged.integrations,
    search: merged.search,
    crawl: merged.crawl,
    research: merged.research,
    storage: merged.storage,
  };
  fs.mkdirSync(path.dirname(paths.configFile), { recursive: true });
  fs.writeFileSync(paths.configFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return merged;
}

export function ensurePaths(paths: Paths): void {
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.cacheDir, { recursive: true });
}

export function updateConfig(mutator: (config: Config) => void, loaded: LoadedConfig): Config {
  const config = structuredClone(loaded.config);
  mutator(config);
  return saveConfig(config, loaded.paths);
}
