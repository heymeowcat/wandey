import type {
  ChatMessage,
  ChatRequest,
  ContentBlock,
  FinishReason,
  ModelInfo,
  ProviderAdapter,
  ProviderEvent,
  ToolCallBlock,
  Usage,
} from "../core/types.ts";
import { joinURL, openStream, parseSSE, ProviderError, asArray, asNumber, asRecord, asString, fetchJSON } from "./stream.ts";

/**
 * Adapter for every OpenAI-compatible chat completions endpoint.
 *
 * This one class is the reason wandey stays light: Ollama, LM Studio, llama.cpp,
 * vLLM, OpenRouter, Groq, DeepSeek, xAI, Moonshot and friends all speak this
 * dialect, including its streaming tool-call delta format.
 */
export interface OpenAIProviderOptions {
  id: string;
  baseUrl: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
  models?: string[];
  local?: boolean;
  /** Discover local and cloud models from Ollama's native catalog. */
  ollama?: boolean;
}

export class OpenAIProvider implements ProviderAdapter {
  readonly kind = "openai" as const;
  readonly baseUrl: string;
  readonly authenticated: boolean;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.authenticated = Boolean(options.apiKey) || Boolean(options.local);
  }

  get id(): string {
    return this.options.id;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(this.options.headers ?? {}),
    };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    if (/openrouter\.ai/.test(this.baseUrl)) {
      headers["HTTP-Referer"] ??= "https://github.com/wandey/wandey";
      headers["X-Title"] ??= "wandey";
    }
    return headers;
  }

  async listModels(): Promise<ModelInfo[]> {
    const extra = this.options.models ?? [];
    let fetched: ModelInfo[] = [];
    let listError: Error | null = null;
    try {
      const json = await fetchJSON<unknown>(
        joinURL(this.baseUrl, "/models"),
        { headers: this.headers() },
        { provider: this.options.id, timeoutMs: 6000 },
      );
      const data = Array.isArray(json) ? json : asArray(asRecord(json).data);
      fetched = data.flatMap((item) => {
        const row = asRecord(item);
        const id = asString(row.id) || asString(row.name);
        if (!id) return [];
        const pricing = asRecord(row.pricing);
        const promptPrice = Number(pricing.prompt);
        const completionPrice = Number(pricing.completion);
        const inputCost = Number.isFinite(promptPrice) ? promptPrice * 1_000_000 : undefined;
        const outputCost = Number.isFinite(completionPrice) ? completionPrice * 1_000_000 : undefined;
        const supported = asArray(row.supported_parameters).map((value) => asString(value));
        return [{
          id,
          name: asString(row.name) || id,
          provider: this.options.id,
          ref: `${this.options.id}/${id}`,
          contextWindow: asNumber(row.context_length) ?? asNumber(row.context_window) ?? asNumber(row.max_context_length),
          maxOutput: asNumber(row.max_completion_tokens) ?? asNumber(row.max_output_tokens),
          supportsTools: supported.length > 0 ? supported.includes("tools") : true,
          supportsReasoning: supported.includes("reasoning") || supported.includes("include_reasoning"),
          supportsVision: supported.includes("vision") || /vision|vl/i.test(id),
          free: (inputCost === 0 && outputCost === 0) || isOpenCodeFreeModel(this.options.id, id),
          costPerMTok: inputCost !== undefined || outputCost !== undefined
            ? { input: inputCost, output: outputCost }
            : undefined,
        } satisfies ModelInfo];
      });
    } catch (err) {
      // A dead port or a rejected key is useful information for the provider
      // screen. Keep it, but do not fail when curated fallback models exist.
      listError = err instanceof Error ? err : new Error(String(err));
    }

    if (this.options.ollama) {
      let discovered: ModelInfo[] = [];
      try {
        discovered = await this.listOllamaCatalog();
      } catch (err) {
        if (listError && fetched.length === 0 && extra.length === 0) throw listError;
        if (fetched.length === 0 && extra.length === 0) throw err;
      }
      const ids = new Set(fetched.map((model) => model.id));
      for (const model of discovered) {
        if (ids.has(model.id)) continue;
        ids.add(model.id);
        fetched.push(model);
      }
    }

    if (listError && fetched.length === 0 && extra.length === 0) throw listError;

    const known = new Set(fetched.map((model) => model.id));
    for (const id of extra) {
      if (known.has(id)) continue;
      fetched.push({
        id,
        name: id,
        provider: this.options.id,
        ref: `${this.options.id}/${id}`,
        supportsTools: true,
      });
    }
    return fetched;
  }

  /**
   * Ollama's OpenAI-compatible /models endpoint only lists downloaded local
   * models. Its native tag endpoint also knows cloud models, which a signed-in
   * local Ollama can run. Add those to the picker so users do not have to
   * remember that e.g. minimax-m3.1-flash:cloud exists.
   */
  private async listOllamaCatalog(): Promise<ModelInfo[]> {
    const origin = new URL(this.baseUrl).origin;
    // No local Ollama server: let the registry surface the connection error.
    const localTags = await fetchJSON<unknown>(
      `${origin}/api/tags`,
      { headers: this.headers() },
      { provider: this.options.id, timeoutMs: 6000 },
    );

    const cloudTags = await fetchJSON<unknown>(
      "https://ollama.com/api/tags",
      {},
      { provider: `${this.options.id} cloud`, timeoutMs: 5000 },
    ).catch(() => null);

    const models = new Map<string, ModelInfo>();
    const add = (row: unknown, isCloud: boolean) => {
      const record = asRecord(row);
      const raw = asString(record.name) || asString(record.model);
      if (!raw) return;
      const id = isCloud ? ollamaCloudID(raw) : raw;
      const capabilities = asArray(record.capabilities).map((value) => asString(value));
      const model: ModelInfo = {
        id,
        name: id,
        provider: this.options.id,
        ref: `${this.options.id}/${id}`,
      };
      if (capabilities.length > 0) {
        model.supportsTools = capabilities.includes("tools");
        model.supportsReasoning = capabilities.includes("thinking");
        model.supportsVision = capabilities.includes("vision");
      }
      if (isCloud && isFreeOllamaCloud(id)) model.free = true;
      models.set(id, model);
    };

    for (const row of asArray(asRecord(localTags).models)) add(row, false);
    if (cloudTags !== null) {
      for (const row of asArray(asRecord(cloudTags).models)) add(row, true);
    }
    return [...models.values()];
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.tools?.length) {
      body.tools = req.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      body.tool_choice = "auto";
    }
    // Only ask for usage on gateways that are known to support the flag; strict
    // local servers reject unknown fields.
    if (/api\.openai\.com|openrouter\.ai/.test(this.baseUrl)) {
      body.stream_options = { include_usage: true };
    }

    const { body: stream } = await openStream(
      joinURL(this.baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      },
      { provider: this.options.id, signal: req.signal },
    );

    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: FinishReason = "stop";
    let sawToolCall = false;

    for await (const message of parseSSE(stream, `${this.options.id} stream`, { idleTimeoutMs: 120_000 })) {
      if (!message.data || message.data === "[DONE]") continue;

      let json: unknown;
      try {
        json = JSON.parse(message.data);
      } catch {
        continue;
      }
      const chunk = asRecord(json);

      const error = asRecord(chunk.error);
      if (Object.keys(error).length > 0) {
        throw new ProviderError(
          `${this.options.id}: ${asString(error.message) || "stream error"}`,
          { provider: this.options.id, body: message.data },
        );
      }

      const usage = asRecord(chunk.usage);
      if (Object.keys(usage).length > 0) {
        yield { type: "usage", usage: toUsage(usage) };
      }

      const choice = asRecord(asArray(chunk.choices)[0]);
      const delta = asRecord(choice.delta);

      const text = textFromContent(delta.content);
      if (text) yield { type: "text", delta: text };

      const reasoning = reasoningFromDelta(delta);
      if (reasoning) yield { type: "reasoning", delta: reasoning };

      for (const raw of asArray(delta.tool_calls)) {
        const call = asRecord(raw);
        const index = asNumber(call.index) ?? 0;
        const fn = asRecord(call.function);
        let entry = toolCalls.get(index);
        if (!entry) {
          entry = { id: "", name: "", args: "" };
          toolCalls.set(index, entry);
        }
        if (asString(call.id)) entry.id = asString(call.id);
        if (asString(fn.name)) entry.name = asString(fn.name);
        if (typeof fn.arguments === "string") entry.args += fn.arguments;
        sawToolCall = true;
      }

      const rawFinish = asString(choice.finish_reason);
      if (rawFinish) finishReason = mapFinish(rawFinish);
    }

    for (const [index, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.name) continue;
      const parsed = parseArgs(call.args);
      yield {
        type: "tool_call",
        id: call.id || `call_${index}_${Date.now().toString(36)}`,
        name: call.name,
        args: parsed.args,
        raw: parsed.raw,
      };
    }
    if (sawToolCall) finishReason = "tool_calls";

    yield { type: "finish", reason: finishReason };
  }
}

export function ollamaCloudID(name: string): string {
  if (name.endsWith("-cloud") || name.endsWith(":cloud")) return name;
  const colon = name.indexOf(":");
  if (colon === -1) return `${name}:cloud`;
  const base = name.slice(0, colon);
  const tag = name.slice(colon + 1);
  // Ollama uses size-suffixed cloud tags such as gpt-oss:20b-cloud. Digest-like
  // variant tags (e.g. :1017) are just catalog builds; use the family name.
  if (/^\d+[bB]$/.test(tag)) return `${base}:${tag}-cloud`;
  return `${base}:cloud`;
}

function isFreeOllamaCloud(id: string): boolean {
  if (id === "beam:cloud") return true;
  // Ollama's M3.1 Flash launch promotion runs through 2026-10-22 23:59 UTC.
  if (id === "minimax-m3.1-flash:cloud" && Date.now() < Date.parse("2026-10-23T00:00:00Z")) {
    return true;
  }
  return false;
}

export function toOpenAIMessages(system: string | undefined, messages: ChatMessage[]): unknown[] {
  const output: unknown[] = [];
  if (system?.trim()) output.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
      const toolCalls = message.content
        .filter((block): block is ToolCallBlock => block.type === "tool_call")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.args) },
        }));

      const assistant: Record<string, unknown> = { role: "assistant" };
      if (text) assistant.content = text;
      else assistant.content = null;
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      output.push(assistant);
      continue;
    }

    // A user turn can contain text, tool results, or both. OpenAI encodes tool
    // results as separate role:"tool" messages.
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (text) output.push({ role: "user", content: text });

    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      output.push({
        role: "tool",
        tool_call_id: block.id,
        content: block.output || (block.isError ? "Tool failed with no output." : "(empty)"),
      });
    }
  }
  return output;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const row = asRecord(part);
      if (asString(row.type) === "text") return asString(row.text);
      return "";
    })
    .join("");
}

/**
 * OpenCode's model endpoint does not expose pricing. Its free-tier models are
 * named with a `-free` suffix, plus the aliased `big-pickle`.
 */
export function isOpenCodeFreeModel(providerID: string, modelID: string): boolean {
  return providerID === "opencode" && (modelID === "big-pickle" || /-free$/i.test(modelID));
}

function reasoningFromDelta(delta: Record<string, unknown>): string {
  const direct = asString(delta.reasoning_content) || asString(delta.reasoning);
  if (direct) return direct;

  const details = asArray(delta.reasoning_details);
  if (details.length > 0) {
    return details
      .map((detail) => {
        const row = asRecord(detail);
        return asString(row.text) || asString(row.summary);
      })
      .join("");
  }
  return "";
}

function parseArgs(raw: string): { args: Record<string, unknown>; raw?: string } {
  if (!raw.trim()) return { args: {} };
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { args: value as Record<string, unknown> };
    }
    return { args: {}, raw };
  } catch {
    return { args: {}, raw };
  }
}

function mapFinish(reason: string): FinishReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "stop";
    case "error":
      return "error";
    default:
      return "stop";
  }
}

function toUsage(raw: Record<string, unknown>): Usage {
  const promptDetails = asRecord(raw.prompt_tokens_details);
  const completionDetails = asRecord(raw.completion_tokens_details);
  return {
    input: asNumber(raw.prompt_tokens),
    output: asNumber(raw.completion_tokens),
    total: asNumber(raw.total_tokens),
    reasoning: asNumber(completionDetails.reasoning_tokens),
    cacheRead: asNumber(promptDetails.cached_tokens) ?? asNumber(raw.cache_read_input_tokens),
    cacheWrite: asNumber(raw.cache_creation_input_tokens),
    cost: asNumber(raw.cost),
  };
}
