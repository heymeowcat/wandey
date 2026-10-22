import type {
  ChatMessage,
  ChatRequest,
  FinishReason,
  ModelInfo,
  ProviderAdapter,
  ProviderEvent,
  Usage,
} from "../core/types.ts";
import { joinURL, openStream, parseSSE, ProviderError, asArray, asNumber, asRecord, asString, fetchJSON } from "./stream.ts";

/**
 * Native Google Gemini adapter (generateContent).
 *
 * Gemini has no tool-call ids and no separate tool role; function responses go
 * back inside a user turn. Tool results are matched by function name, which is
 * enough for the sequential tool loop wandey runs.
 */
export interface GeminiProviderOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  models?: string[];
}

export class GeminiProvider implements ProviderAdapter {
  readonly kind = "gemini" as const;
  readonly authenticated = true;

  constructor(private readonly options: GeminiProviderOptions) {}

  get id(): string {
    return this.options.id;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  async listModels(): Promise<ModelInfo[]> {
    const extra = this.options.models ?? [];
    let models: ModelInfo[] = [];
    try {
      const url = `${joinURL(this.baseUrl, "/models")}?pageSize=200&key=${encodeURIComponent(this.options.apiKey)}`;
      const json = await fetchJSON<unknown>(url, { headers: { "content-type": "application/json" } }, {
        provider: this.id,
        timeoutMs: 8000,
      });
      const rows = asArray(asRecord(json).models);
      models = rows.flatMap((row) => {
        const data = asRecord(row);
        const rawName = asString(data.name).replace(/^models\//, "");
        const methods = asArray(data.supportedGenerationMethods).map((value) => asString(value));
        if (!rawName || !methods.includes("generateContent")) return [];
        return [{
          id: rawName,
          name: asString(data.displayName) || rawName,
          provider: this.id,
          ref: `${this.id}/${rawName}`,
          contextWindow: asNumber(data.inputTokenLimit),
          maxOutput: asNumber(data.outputTokenLimit),
          supportsTools: true,
          supportsReasoning: /thinking|2\.5|3/i.test(rawName),
          supportsVision: true,
        } satisfies ModelInfo];
      });
    } catch {
      // A key with no list permission can still generate; configured models fix it.
    }

    const known = new Set(models.map((model) => model.id));
    for (const id of extra) {
      if (known.has(id)) continue;
      models.push({ id, name: id, provider: this.id, ref: `${this.id}/${id}`, supportsTools: true });
    }
    return models;
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    const body: Record<string, unknown> = {
      contents: toGeminiContents(req.messages),
    };
    if (req.system?.trim()) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.tools?.length) {
      body.tools = [{
        functionDeclarations: req.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      }];
    }
    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    const model = req.model.replace(/^models\//, "");
    const url = `${joinURL(this.baseUrl, `/models/${encodeURIComponent(model)}:streamGenerateContent`)}?alt=sse&key=${encodeURIComponent(this.options.apiKey)}`;
    const { body: stream } = await openStream(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      { provider: this.id, signal: req.signal },
    );

    let finishReason: FinishReason = "stop";
    let usage: Usage = {};
    let sawToolCall = false;
    let callCounter = 0;

    for await (const message of parseSSE(stream, `${this.id} stream`, { idleTimeoutMs: 120_000 })) {
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
        throw new ProviderError(`${this.id}: ${asString(error.message) || "stream error"}`, {
          provider: this.id,
          body: message.data,
        });
      }

      const promptFeedback = asRecord(chunk.promptFeedback);
      if (asString(promptFeedback.blockReason)) {
        yield { type: "finish", reason: "error", error: `Blocked: ${asString(promptFeedback.blockReason)}` };
        return;
      }

      const meta = asRecord(chunk.usageMetadata);
      if (Object.keys(meta).length > 0) {
        usage = {
          input: asNumber(meta.promptTokenCount),
          output: asNumber(meta.candidatesTokenCount),
          reasoning: asNumber(meta.thoughtsTokenCount),
          total: asNumber(meta.totalTokenCount),
        };
      }

      const candidate = asRecord(asArray(chunk.candidates)[0]);
      const parts = asArray(asRecord(candidate.content).parts);
      for (const rawPart of parts) {
        const part = asRecord(rawPart);
        const text = asString(part.text);
        if (text) {
          if (part.thought === true) yield { type: "reasoning", delta: text };
          else yield { type: "text", delta: text };
        }
        const call = asRecord(part.functionCall);
        const name = asString(call.name);
        if (name) {
          sawToolCall = true;
          callCounter += 1;
          yield {
            type: "tool_call",
            id: `call_${callCounter}_${Date.now().toString(36)}`,
            name,
            args: asRecord(call.args),
          };
        }
      }

      const rawFinish = asString(candidate.finishReason);
      if (rawFinish) finishReason = mapFinish(rawFinish);
    }

    if (Object.keys(usage).length > 0) yield { type: "usage", usage };
    if (sawToolCall) finishReason = "tool_calls";
    yield { type: "finish", reason: finishReason };
  }
}

export function toGeminiContents(messages: ChatMessage[]): unknown[] {
  type Row = { role: "user" | "model"; parts: unknown[] };
  const rows: Row[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const parts: unknown[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text) parts.push({ text: block.text });
        else if (block.type === "tool_call") {
          parts.push({ functionCall: { name: block.name, args: block.args } });
        }
      }
      if (parts.length > 0) appendMerged(rows, "model", parts);
      continue;
    }

    const parts: unknown[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        parts.push({ text: block.text });
      } else if (block.type === "tool_result") {
        parts.push({
          functionResponse: {
            name: block.name,
            response: { result: block.output || (block.isError ? "Tool failed with no output." : "(empty)") },
          },
        });
      }
    }
    if (parts.length > 0) appendMerged(rows, "user", parts);
  }
  return rows;
}

function appendMerged(rows: Array<{ role: "user" | "model"; parts: unknown[] }>, role: "user" | "model", parts: unknown[]): void {
  const last = rows[rows.length - 1];
  if (last && last.role === role) {
    last.parts.push(...parts);
    return;
  }
  rows.push({ role, parts });
}

function mapFinish(reason: string): FinishReason {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
      return "stop";
    default:
      return "stop";
  }
}
