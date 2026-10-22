import type {
  ChatMessage,
  ChatRequest,
  FinishReason,
  ModelInfo,
  ProviderAdapter,
  ProviderEvent,
  ToolCallBlock,
  Usage,
} from "../core/types.ts";
import { joinURL, openStream, parseSSE, ProviderError, asArray, asNumber, asRecord, asString, fetchJSON } from "./stream.ts";

/**
 * Native Anthropic Messages API adapter.
 *
 * Streaming shapes differ from OpenAI in interesting ways: tool inputs arrive
 * as partial JSON, reasoning arrives as "thinking" deltas, and usage is split
 * across message_start / message_delta. All of that is normalized here.
 */
export interface AnthropicProviderOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  models?: string[];
  version?: string;
}

interface PendingToolUse {
  id: string;
  name: string;
  json: string;
  index: number;
}

export class AnthropicProvider implements ProviderAdapter {
  readonly kind = "anthropic" as const;
  readonly authenticated = true;

  constructor(private readonly options: AnthropicProviderOptions) {}

  get id(): string {
    return this.options.id;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": this.options.apiKey,
      "anthropic-version": this.options.version ?? "2023-06-01",
      ...(this.options.headers ?? {}),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const extra = this.options.models ?? [];
    let models: ModelInfo[] = [];
    try {
      const json = await fetchJSON<unknown>(
        joinURL(this.baseUrl, "/v1/models?limit=1000"),
        { headers: this.headers() },
        { provider: this.id, timeoutMs: 6000 },
      );
      const rows = asArray(asRecord(json).data);
      models = rows.flatMap((row) => {
        const data = asRecord(row);
        const id = asString(data.id);
        if (!id) return [];
        return [{
          id,
          name: asString(data.display_name) || id,
          provider: this.id,
          ref: `${this.id}/${id}`,
          contextWindow: asNumber(data.context_window),
          maxOutput: asNumber(data.max_output_tokens),
          supportsTools: true,
          supportsReasoning: true,
          supportsVision: true,
        } satisfies ModelInfo];
      });
    } catch {
      // Some proxies don't expose /v1/models; configured models still work.
    }

    const known = new Set(models.map((model) => model.id));
    for (const id of extra) {
      if (known.has(id)) continue;
      models.push({
        id,
        name: id,
        provider: this.id,
        ref: `${this.id}/${id}`,
        supportsTools: true,
        supportsReasoning: true,
        supportsVision: true,
      });
    }
    return models;
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      stream: true,
      messages: toAnthropicMessages(req.messages),
    };
    if (req.system?.trim()) body.system = req.system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    const { body: stream } = await openStream(
      joinURL(this.baseUrl, "/v1/messages"),
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      { provider: this.id, signal: req.signal },
    );

    const pending = new Map<number, PendingToolUse>();
    let usage: Usage = {};
    let finishReason: FinishReason = "stop";
    let sawToolCall = false;

    for await (const message of parseSSE(stream, `${this.id} stream`, { idleTimeoutMs: 120_000 })) {
      if (!message.data || message.data === "[DONE]") continue;
      let json: unknown;
      try {
        json = JSON.parse(message.data);
      } catch {
        continue;
      }
      const event = asRecord(json);
      const type = message.event || asString(event.type);

      if (type === "error") {
        const error = asRecord(event.error);
        throw new ProviderError(
          `${this.id}: ${asString(error.message) || "stream error"}`,
          { provider: this.id, body: message.data },
        );
      }

      if (type === "message_start") {
        const startUsage = asRecord(asRecord(event.message).usage);
        usage = {
          input: asNumber(startUsage.input_tokens),
          output: asNumber(startUsage.output_tokens),
          cacheRead: asNumber(startUsage.cache_read_input_tokens),
          cacheWrite: asNumber(startUsage.cache_creation_input_tokens),
        };
      }

      if (type === "content_block_start") {
        const block = asRecord(event.content_block);
        if (asString(block.type) === "tool_use") {
          pending.set(asNumber(event.index) ?? 0, {
            id: asString(block.id) || `call_${event.index}_${Date.now().toString(36)}`,
            name: asString(block.name),
            json: "",
            index: asNumber(event.index) ?? 0,
          });
        }
      }

      if (type === "content_block_delta") {
        const delta = asRecord(event.delta);
        const deltaType = asString(delta.type);
        if (deltaType === "text_delta" && asString(delta.text)) {
          yield { type: "text", delta: asString(delta.text) };
        } else if (deltaType === "thinking_delta" && asString(delta.thinking)) {
          yield { type: "reasoning", delta: asString(delta.thinking) };
        } else if (deltaType === "input_json_delta") {
          const entry = pending.get(asNumber(event.index) ?? 0);
          if (entry) entry.json += asString(delta.partial_json);
        }
      }

      if (type === "content_block_stop") {
        const index = asNumber(event.index) ?? 0;
        const entry = pending.get(index);
        if (entry) {
          pending.delete(index);
          const parsed = parseArgs(entry.json);
          sawToolCall = true;
          yield { type: "tool_call", id: entry.id, name: entry.name, args: parsed.args, raw: parsed.raw };
        }
      }

      if (type === "message_delta") {
        const delta = asRecord(event.delta);
        const stop = asString(delta.stop_reason);
        if (stop) finishReason = mapFinish(stop);
        const endUsage = asRecord(event.usage);
        usage = {
          ...usage,
          output: asNumber(endUsage.output_tokens) ?? usage.output,
        };
      }

      if (type === "message_stop") {
        if (sawToolCall) finishReason = "tool_calls";
        break;
      }
    }

    if (usage.input !== undefined || usage.output !== undefined) {
      yield { type: "usage", usage };
    }
    yield { type: "finish", reason: finishReason };
  }
}

export function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  type Row = { role: "user" | "assistant"; content: unknown[] };
  const rows: Row[] = [];

  for (const message of messages) {
    const blocks: unknown[] = [];
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "tool_call") {
          blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.args });
        }
      }
      if (blocks.length === 0) continue;
      appendMerged(rows, "assistant", blocks);
      continue;
    }

    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: block.output || (block.isError ? "Tool failed with no output." : "(empty)"),
          ...(block.isError ? { is_error: true } : {}),
        });
      }
    }
    if (blocks.length === 0) continue;
    appendMerged(rows, "user", blocks);
  }

  return rows;
}

function appendMerged(rows: Array<{ role: "user" | "assistant"; content: unknown[] }>, role: "user" | "assistant", blocks: unknown[]): void {
  const last = rows[rows.length - 1];
  if (last && last.role === role) {
    last.content.push(...blocks);
    return;
  }
  rows.push({ role, content: blocks });
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
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "stop";
    default:
      return "stop";
  }
}
