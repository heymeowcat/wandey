import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChatMessage,
  ChatRequest,
  FinishReason,
  ModelInfo,
  ProviderAdapter,
  ProviderEvent,
  Usage,
} from "../core/types.ts";
import { asArray, asNumber, asRecord, asString } from "./stream.ts";
import { isOpenCodeFreeModel } from "./openai.ts";

/**
 * The local OpenCode backend.
 *
 * OpenCode's anonymous free tier only runs inside OpenCode itself: a direct API
 * call is rejected with FreeTierError. This adapter starts `opencode serve` on
 * demand and talks to its local HTTP API, which keeps the free-tier check intact
 * without impersonating a client.
 *
 * The runtime is deliberately isolated: a throwaway HOME, XDG directories, and
 * working directory mean it cannot read Wandey's project, config, credentials,
 * or the user's OpenCode history. A custom primary agent disables every tool
 * that can touch the system. Read-only discovery tools stay enabled because the
 * free tier rejects requests when tools are fully denied; the empty temporary
 * directory limits what they can see.
 */

export const OPENCODE_LOCAL_PROVIDER_ID = "opencode-local";
export const OPENCODE_LOCAL_AGENT_ID = "wandey-text";
const OPENCODE_MODELS_URL = "https://opencode.ai/inference/v1/models";
const OPENCODE_API_BASE = "https://opencode.ai/inference/openai/v1";
const START_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;
const GENERATION_TIMEOUT_MS = 30 * 60_000;

type OpenCodeProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

interface FreeModelMeta {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
}

/** Used when the public model list is unreachable or changes shape. */
export const OPENCODE_FREE_FALLBACK_MODELS: FreeModelMeta[] = [
  { id: "big-pickle", name: "Big Pickle", contextWindow: 200_000, maxOutput: 32_000 },
  { id: "beam-free", name: "Beam Free", contextWindow: 1_048_576, maxOutput: 131_072 },
  { id: "flint-40b-free", name: "Flint 40B Free", contextWindow: 262_144, maxOutput: 65_536 },
  { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free", contextWindow: 200_000, maxOutput: 32_000 },
  {
    id: "nemotron-3.5-super-vl-free",
    name: "Nemotron 3.5 Super VL Free",
    contextWindow: 1_048_576,
    maxOutput: 131_072,
  },
  {
    id: "nemotron-3.5-lightning-free",
    name: "Nemotron 3.5 Lightning Free",
    contextWindow: 262_144,
    maxOutput: 262_144,
  },
  { id: "jev-1.13-free", name: "Jev 1.13 Free" },
  { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", contextWindow: 200_000, maxOutput: 32_000 },
  { id: "glm-5.3-flash-free", name: "GLM-5.3 Flash Free", contextWindow: 200_000, maxOutput: 32_000 },
  { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", contextWindow: 1_000_000, maxOutput: 128_000 },
];

export const OPENCODE_AGENT_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  agent: {
    [OPENCODE_LOCAL_AGENT_ID]: {
      description: "Text-only assistant for Wandey. Answer directly and never call tools.",
      mode: "primary",
      prompt:
        "You are a text-only assistant. Do not call tools. Answer directly in plain text, and be explicit about anything you cannot verify.",
      // One step is not enough for some free models, which spend a turn on a
      // read-only tool call and then need another turn to answer. Two steps
      // gives them room without allowing a long tool loop.
      steps: 2,
      // `tools` is the older form; `permission` is the current one. Keep both
      // so the same agent behaves safely across OpenCode versions.
      tools: {
        bash: false,
        edit: false,
        task: false,
        subagent: false,
        external_directory: false,
        todowrite: false,
        question: false,
        webfetch: false,
        websearch: false,
        lsp: false,
        doom_loop: false,
        skill: false,
        browser: false,
      },
      permission: {
        // Read-only discovery tools must stay available: the free tier rejects
        // requests when every tool is denied. They can only see the empty
        // temporary working directory.
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: "deny",
        edit: "deny",
        task: "deny",
        external_directory: "deny",
        todowrite: "deny",
        question: "deny",
        webfetch: "deny",
        websearch: "deny",
        lsp: "deny",
        doom_loop: "deny",
        skill: "deny",
        browser: "deny",
      },
    },
  },
};

export class OpenCodeLocalProvider implements ProviderAdapter {
  readonly id = OPENCODE_LOCAL_PROVIDER_ID;
  readonly kind = "opencode" as const;
  readonly authenticated = true;

  private child: OpenCodeProcess | null = null;
  private serverURL: string | null = null;
  private startPromise: Promise<string> | null = null;
  private tempDir: string | null = null;
  private workDir: string | null = null;
  private password = "";
  private disposed = false;

  async listModels(): Promise<ModelInfo[]> {
    if (!Bun.which("opencode")) {
      throw new Error(
        "OpenCode CLI not found on PATH. Install OpenCode from https://opencode.ai, then restart Wandey.",
      );
    }
    return (await fetchFreeModelIDs()).map((id) => freeModelInfo(id));
  }

  supportsTools(): boolean {
    return false;
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    if (!isOpenCodeFreeModel("opencode", req.model)) {
      throw new Error(
        `"${req.model}" is not an OpenCode free model. Choose big-pickle or a model id ending in -free.`,
      );
    }
    if (req.signal?.aborted) {
      yield { type: "finish", reason: "aborted" };
      return;
    }

    const base = await this.ensureServer();
    let sessionID: string | null = null;
    const waitController = new AbortController();
    const onAbort = (): void => waitController.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      sessionID = await this.createSession(base, req.model, req.signal);
      await this.request(
        base,
        `/api/session/${encodeURIComponent(sessionID)}/prompt`,
        {
          method: "POST",
          body: JSON.stringify({ text: buildOpenCodePrompt(req) }),
        },
        req.signal,
      );

      // The wait endpoint resolves as soon as the session is idle. It is only
      // an optimization: polling below remains the source of truth if the
      // experimental endpoint is unavailable.
      const wait = this.request(
        base,
        `/api/experimental/session/${encodeURIComponent(sessionID)}/wait`,
        { method: "POST" },
        waitController.signal,
      ).catch(() => null);

      let lastText = "";
      let lastReasoning = "";
      let lastUsage: Usage | null = null;
      let finish: FinishReason = "stop";
      let error: string | null = null;
      const deadline = Date.now() + GENERATION_TIMEOUT_MS;

      while (true) {
        if (req.signal?.aborted) {
          await this.interrupt(base, sessionID);
          finish = "aborted";
          break;
        }
        if (Date.now() > deadline) {
          await this.interrupt(base, sessionID);
          throw new Error("OpenCode did not finish within 30 minutes. Try a smaller prompt or another free model.");
        }

        let messages: Array<Record<string, unknown>>;
        try {
          messages = await this.listMessages(base, sessionID, req.signal);
        } catch (err) {
          if (req.signal?.aborted) {
            await this.interrupt(base, sessionID);
            finish = "aborted";
            break;
          }
          throw err;
        }

        const assistant = messages.filter((message) => asString(message.type) === "assistant");
        const text = assistant.map((message) => textFromOpenCodeContent(message.content)).join("");
        const reasoning = assistant.map((message) => reasoningFromOpenCodeContent(message.content)).join("");

        if (text !== lastText) {
          const delta = deltaFrom(lastText, text);
          if (delta) yield { type: "text", delta };
          lastText = text;
        }
        if (reasoning !== lastReasoning) {
          const delta = deltaFrom(lastReasoning, reasoning);
          if (delta) yield { type: "reasoning", delta };
          lastReasoning = reasoning;
        }

        const last = assistant.at(-1);
        if (last) {
          const usage = usageFromOpenCodeMessage(last);
          if (usage) lastUsage = usage;
          const messageError = asRecord(last.error);
          const detail =
            asString(messageError.message) ||
            asString(asRecord(messageError.data).message) ||
            asString(last.error);
          if (detail) error = detail;
          const mapped = mapOpenCodeFinish(last.finish);
          if (mapped === "error") finish = "error";
          else if (mapped === "length") finish = "length";
        }

        if (messages.some((message) => asString(message.type) === "idle")) break;
        await Promise.race([wait, delay(POLL_INTERVAL_MS)]);
      }

      if (lastUsage) yield { type: "usage", usage: lastUsage };
      if (finish === "error") {
        yield { type: "finish", reason: "error", error: error ?? "OpenCode reported an error." };
        return;
      }
      if (finish !== "aborted" && !lastText.trim() && !lastReasoning.trim()) {
        throw new Error(error ?? "OpenCode returned an empty response. Try another free model.");
      }
      yield { type: "finish", reason: finish, error: error ?? undefined };
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      waitController.abort();
      if (sessionID) await this.deleteSession(base, sessionID);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopServer();
  }

  private async ensureServer(): Promise<string> {
    if (this.disposed) throw new Error("OpenCode local runtime is stopped.");
    if (this.serverURL) return this.serverURL;
    if (!this.startPromise) {
      this.startPromise = this.startServer().catch((err) => {
        this.startPromise = null;
        throw err;
      });
    }
    return this.startPromise;
  }

  private async startServer(): Promise<string> {
    const binary = Bun.which("opencode");
    if (!binary) {
      throw new Error(
        "OpenCode CLI not found on PATH. Install OpenCode from https://opencode.ai, then restart Wandey.",
      );
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wandey-opencode-"));
    const workDir = path.join(tempDir, "work");
    const modelsPath = path.join(tempDir, "models.json");
    const password = crypto.randomBytes(24).toString("base64url");
    for (const dir of [
      workDir,
      path.join(tempDir, "data"),
      path.join(tempDir, "config"),
      path.join(tempDir, "state"),
      path.join(tempDir, "cache"),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // An isolated OpenCode has no models.dev catalog, so it cannot resolve most
    // free model ids. Give it a tiny catalog containing only the free models
    // Wandey is allowed to run. This is also why big-pickle works without one:
    // it is a built-in alias.
    fs.writeFileSync(modelsPath, JSON.stringify(buildModelCatalog(await fetchFreeModelIDs()), null, 2), "utf8");

    let child: OpenCodeProcess;
    try {
      child = Bun.spawn({
        cmd: [binary, "serve", "--hostname", "127.0.0.1", "--port", "0"],
        cwd: workDir,
        env: this.childEnv(tempDir, password, modelsPath),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw new Error(`Could not start OpenCode: ${(err as Error).message}`);
    }

    this.child = child;
    this.tempDir = tempDir;
    this.workDir = workDir;
    this.password = password;

    let reportedURL: string | null = null;
    let resolveURL: (url: string) => void = () => {};
    let rejectURL: (error: Error) => void = () => {};
    const urlPromise = new Promise<string>((resolve, reject) => {
      resolveURL = resolve;
      rejectURL = reject;
    });

    let stderr = "";
    const stdoutTask = this.readLines(child.stdout, (line) => {
      if (reportedURL) return;
      const match = line.match(/server listening on (https?:\/\/\S+)/);
      if (match?.[1]) {
        reportedURL = match[1];
        resolveURL(reportedURL);
      }
    }).catch((err) => {
      if (!reportedURL) rejectURL(err instanceof Error ? err : new Error(String(err)));
    });
    const stderrTask = this.readLines(child.stderr, (line) => {
      stderr = `${stderr}${line}\n`;
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    }).catch(() => {});
    void stdoutTask;
    void stderrTask;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("OpenCode local runtime did not start within 20 seconds.")),
        START_TIMEOUT_MS,
      );
    });
    const exited = child.exited.then((code) => {
      throw new Error(
        `OpenCode local runtime exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      );
    });

    try {
      const url = await Promise.race([urlPromise, exited, timeout]);
      if (this.disposed) {
        try {
          child.kill();
        } catch {
          // Already exiting.
        }
        throw new Error("OpenCode local runtime was stopped while starting.");
      }
      this.serverURL = url.replace(/\/+$/, "");
      void child.exited.then((code) => this.handleExit(child, code));
      return this.serverURL;
    } catch (err) {
      if (this.child === child) this.child = null;
      try {
        child.kill();
      } catch {
        // Already exiting.
      }
      this.serverURL = null;
      this.workDir = null;
      this.tempDir = null;
      this.password = "";
      fs.rmSync(tempDir, { recursive: true, force: true });
      const message = (err as Error).message;
      throw new Error(stderr.trim() && !message.includes(stderr.trim()) ? `${message}\n${stderr.trim()}` : message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private childEnv(
    tempDir: string,
    password: string,
    modelsPath: string,
  ): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    // Never let a user's OpenCode config or model override leak into this
    // isolated runtime. Only the generated config and temporary HOME are used.
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_CONFIG_DIR;
    delete env.OPENCODE_CONFIG_CONTENT;
    delete env.OPENCODE_MODELS_PATH;
    // Use the anonymous free tier, not a key the user happened to export.
    delete env.OPENCODE_API_KEY;
    delete env.OPENCODE_AUTH_CONTENT;
    delete env.OPENCODE_AUTH_PATH;
    delete env.OPENCODE_PERMISSION;
    env.HOME = tempDir;
    env.XDG_DATA_HOME = path.join(tempDir, "data");
    env.XDG_CONFIG_HOME = path.join(tempDir, "config");
    env.XDG_STATE_HOME = path.join(tempDir, "state");
    env.XDG_CACHE_HOME = path.join(tempDir, "cache");
    env.OPENCODE_PASSWORD = password;
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(OPENCODE_AGENT_CONFIG);
    env.OPENCODE_MODELS_PATH = modelsPath;
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
    env.NO_COLOR = "1";
    return env;
  }

  private handleExit(child: OpenCodeProcess, code: number): void {
    if (this.child !== child) return;
    this.child = null;
    this.serverURL = null;
    this.startPromise = null;
    if (code !== 0 && code !== 143) {
      console.error(`[opencode-local] runtime exited with code ${code}`);
    }
    this.cleanupTemp();
  }

  private stopServer(): void {
    const child = this.child;
    this.child = null;
    this.serverURL = null;
    this.startPromise = null;
    if (child) {
      try {
        child.kill();
      } catch {
        // Already exiting.
      }
    }
    this.cleanupTemp();
  }

  private cleanupTemp(): void {
    const tempDir = this.tempDir;
    this.tempDir = null;
    this.workDir = null;
    this.password = "";
    if (!tempDir) return;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // The runtime may still be releasing a file on Windows.
    }
  }

  private async createSession(base: string, model: string, signal?: AbortSignal): Promise<string> {
    if (!this.workDir) throw new Error("OpenCode local runtime has no working directory.");
    const json = await this.request(
      base,
      "/api/session",
      {
        method: "POST",
        body: JSON.stringify({
          title: "Wandey",
          model: { id: model, providerID: "opencode" },
          agent: OPENCODE_LOCAL_AGENT_ID,
          location: { directory: this.workDir },
        }),
      },
      signal,
    );
    const id = asString(asRecord(asRecord(json).data).id);
    if (!id) throw new Error("OpenCode did not return a session id.");
    return id;
  }

  private async listMessages(
    base: string,
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    const json = await this.request(
      base,
      `/api/session/${encodeURIComponent(sessionID)}/message?order=asc&limit=200`,
      {},
      signal,
    );
    return asArray(asRecord(json).data).map((row) => asRecord(row));
  }

  private async interrupt(base: string, sessionID: string): Promise<void> {
    await this.request(
      base,
      `/api/session/${encodeURIComponent(sessionID)}/interrupt`,
      { method: "POST" },
      AbortSignal.timeout(5_000),
    ).catch(() => {});
  }

  private async deleteSession(base: string, sessionID: string): Promise<void> {
    await this.request(
      base,
      `/api/session/${encodeURIComponent(sessionID)}`,
      { method: "DELETE" },
      AbortSignal.timeout(5_000),
    ).catch(() => {});
  }

  private async request(
    base: string,
    pathname: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    const response = await fetch(`${base}${pathname}`, { ...init, headers, signal });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    if (!response.ok) throw new Error(formatOpenCodeError(response.status, body));
    return body;
  }

  private async readLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          onLine(buffer.slice(0, newline).replace(/\r$/, ""));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) onLine(buffer.replace(/\r$/, ""));
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // The stream may already be closed.
      }
    }
  }
}

async function fetchFreeModelIDs(): Promise<string[]> {
  try {
    const response = await fetch(OPENCODE_MODELS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const json = (await response.json()) as unknown;
      const ids = asArray(asRecord(json).data)
        .map((row) => asString(asRecord(row).id))
        .filter(Boolean);
      if (ids.length > 0) return selectFreeOpenCodeModelIDs(ids);
    }
  } catch {
    // Offline is normal. Keep the known free models visible; starting a
    // session will surface a useful runtime error if the network is down.
  }
  return selectFreeOpenCodeModelIDs([]);
}

/**
 * A minimal models.dev-shaped catalog for the isolated runtime. OpenCode needs
 * catalog entries to resolve model ids; without this only built-in aliases such
 * as big-pickle work.
 */
export function buildModelCatalog(ids: Iterable<string>): Record<string, unknown> {
  const models: Record<string, unknown> = {};
  for (const id of selectFreeOpenCodeModelIDs(ids)) {
    const info = freeModelInfo(id);
    models[id] = {
      id,
      name: info.name,
      family: id.replace(/-free$/i, ""),
      attachment: false,
      reasoning: true,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
      structured_output: true,
      temperature: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: {
        context: info.contextWindow ?? 200_000,
        output: info.maxOutput ?? 32_000,
      },
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      provider: { api: OPENCODE_API_BASE },
    };
  }
  return {
    opencode: {
      id: "opencode",
      name: "OpenCode",
      api: OPENCODE_API_BASE,
      npm: "@ai-sdk/openai-compatible",
      env: ["OPENCODE_API_KEY"],
      models,
    },
  };
}

/** Pick free ids from a public model list, or fall back when it is empty. */
export function selectFreeOpenCodeModelIDs(ids: Iterable<string>): string[] {
  const free = [...new Set(ids)].filter((id) => id && isOpenCodeFreeModel("opencode", id));
  return free.length > 0 ? free : OPENCODE_FREE_FALLBACK_MODELS.map((model) => model.id);
}

export function freeModelInfo(id: string): ModelInfo {
  const known = OPENCODE_FREE_FALLBACK_MODELS.find((model) => model.id === id);
  return {
    id,
    name: known?.name ?? humanizeModelID(id),
    provider: OPENCODE_LOCAL_PROVIDER_ID,
    ref: `${OPENCODE_LOCAL_PROVIDER_ID}/${id}`,
    contextWindow: known?.contextWindow,
    maxOutput: known?.maxOutput,
    supportsTools: false,
    free: true,
    costPerMTok: { input: 0, output: 0 },
  };
}

/**
 * OpenCode sessions are text-only here. Fold Wandey's system prompt and the
 * conversation into one prompt so the runtime does not need to understand
 * Wandey's provider message format.
 */
export function buildOpenCodePrompt(req: Pick<ChatRequest, "system" | "messages">): string {
  const lines = [
    "You are answering through Wandey's local OpenCode backend.",
    "This backend is text-only. Tools are unavailable: do not call tools, do not claim you used tools, and do not mention tool mechanics.",
    "",
  ];
  const system = req.system?.trim();
  if (system) lines.push("System instructions:", system, "");
  lines.push("Conversation:");
  for (const message of req.messages) {
    const text = messageText(message);
    if (!text) continue;
    lines.push(`${message.role === "user" ? "User" : "Assistant"}:`, text, "");
  }
  lines.push(
    "Write the next assistant reply. Answer the latest user message directly. Do not prefix the reply with 'Assistant:'.",
    "Remember: tools are unavailable in this backend.",
  );
  return lines.join("\n");
}

export function textFromOpenCodeContent(content: unknown): string {
  return asArray(content)
    .map((part) => {
      const row = asRecord(part);
      return asString(row.type) === "text" ? asString(row.text) : "";
    })
    .join("");
}

export function reasoningFromOpenCodeContent(content: unknown): string {
  return asArray(content)
    .map((part) => {
      const row = asRecord(part);
      return asString(row.type) === "reasoning" ? asString(row.text) : "";
    })
    .join("");
}

export function mapOpenCodeFinish(value: unknown): FinishReason {
  const finish = asString(value);
  if (finish === "length") return "length";
  if (finish === "error") return "error";
  // OpenCode continues tool calls inside one session; a final tool-calls
  // finish means the step budget ran out. Surface it as a normal stop.
  return "stop";
}

function messageText(message: ChatMessage): string {
  return message.content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "tool_call":
          return `[Earlier tool call: ${block.name}]`;
        case "tool_result":
          return `[Earlier tool result: ${block.name}]\n${block.output}`;
        default:
          // Reasoning is internal; do not replay it into the next prompt.
          return "";
      }
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function usageFromOpenCodeMessage(message: Record<string, unknown>): Usage | null {
  const tokens = asRecord(message.tokens);
  const cache = asRecord(tokens.cache);
  const input = asNumber(tokens.input);
  const output = asNumber(tokens.output);
  const reasoning = asNumber(tokens.reasoning);
  const cacheRead = asNumber(cache.read);
  const cacheWrite = asNumber(cache.write);
  const cost = asNumber(message.cost);
  if (
    input === undefined &&
    output === undefined &&
    reasoning === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    cost === undefined
  ) {
    return null;
  }
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input !== undefined && output !== undefined ? input + output : undefined,
    cost,
  };
}

function deltaFrom(previous: string, next: string): string {
  if (next.startsWith(previous)) return next.slice(previous.length);
  // The content changed rather than appended. Emit only the changed suffix so
  // a UI does not duplicate the unchanged prefix.
  let index = 0;
  while (index < previous.length && index < next.length && previous[index] === next[index]) index++;
  return next.slice(index);
}

function humanizeModelID(id: string): string {
  const free = /-free$/i.test(id);
  const base = id.replace(/-free$/i, "");
  const words = base
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d/.test(part)) return part;
      if (/^[a-z]{1,4}\d/i.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    });
  return `${words.join(" ")}${free ? " Free" : ""}`;
}

function formatOpenCodeError(status: number, body: unknown): string {
  const record = asRecord(body);
  const error = asRecord(record.error);
  const message =
    asString(error.message) ||
    asString(asRecord(error.data).message) ||
    asString(record.message) ||
    asString(record.error) ||
    (typeof body === "string" ? body : "");
  const type = asString(error.type) || asString(record._tag) || asString(record.name);
  const detail = message || type || "OpenCode request failed.";
  if (type === "FreeTierError" || /free tier/i.test(detail)) {
    return `OpenCode refused the free-tier request (${status}): ${detail} Make sure the OpenCode CLI is up to date.`;
  }
  return `OpenCode request failed (${status}): ${detail}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
