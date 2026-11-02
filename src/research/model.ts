import type { ChatMessage, Usage } from "../core/types.ts";
import { estimateTokens } from "../core/run-usage.ts";
import { extractJson } from "../core/util.ts";
import { streamWithFallback } from "../providers/retry.ts";
import type { ProviderRegistry } from "../providers/registry.ts";

/**
 * A tiny non-streaming model client used by the research pipeline.
 *
 * Research calls are batch jobs (plan, extract, synthesize), not chat turns, so
 * the UI does not need token deltas. Everything still flows through the normal
 * provider registry, which means any configured model works.
 */
export interface CompletionRequest {
  system?: string;
  messages?: ChatMessage[];
  /** Convenience for the common single-user-message case. */
  prompt?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called at the start of every attempt, so budgets can reset deltas. */
  onAttempt?: (model: string, attempt: number) => void;
  /** Receives usage for every attempt, including failed ones. */
  onUsage?: (model: string, usage: Usage, estimated: boolean) => void;
}

export interface ResearchModelOptions {
  attempts: number;
  baseDelayMs: number;
  /** Ordered fallbacks, tried after the primary is exhausted. */
  fallback: string[];
}

export interface CompletionResult {
  text: string;
  usage: Usage;
  model: string;
}

export class ResearchModel {
  constructor(
    private readonly registry: ProviderRegistry,
    readonly ref: string,
    private readonly options: ResearchModelOptions = {
      attempts: 3,
      baseDelayMs: 700,
      fallback: [],
    },
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.ref.trim()) throw new Error("No model is available for research");

    const messages: ChatMessage[] =
      request.messages ??
      (request.prompt
        ? [{ role: "user", content: [{ type: "text", text: request.prompt }] }]
        : []);
    if (messages.length === 0) throw new Error("Research model call had no input");

    const inputChars = (request.system?.length ?? 0) + messageChars(messages);
    // A completely empty completion is retryable once. This is separate from
    // provider failures, which the shared helper already retries.
    for (let emptyAttempt = 0; emptyAttempt < 2; emptyAttempt++) {
      let text = "";
      let usage: Usage = {};
      let model = this.ref;

      for await (const event of streamWithFallback({
        candidates: [this.ref, ...this.options.fallback],
        attempts: this.options.attempts,
        baseDelayMs: this.options.baseDelayMs,
        signal: request.signal,
        supportsTools: async () => false,
        open: (ref) =>
          this.registry.stream(ref, {
            system: request.system,
            messages,
            temperature: request.temperature ?? 0.2,
            maxTokens: request.maxTokens,
            signal: request.signal,
          }),
        onAttempt: (info) => request.onAttempt?.(info.ref, info.attempt),
        onAttemptEnd: (info) => {
          const reported = info.usage;
          if (reported) {
            request.onUsage?.(info.ref, reported, false);
            return;
          }
          // A rejected request with no output may not have consumed tokens;
          // only estimate successes and partial attempts.
          if (info.error && info.outputChars === 0) return;
          const input = estimateTokens(inputChars);
          const output = estimateTokens(info.outputChars);
          request.onUsage?.(
            info.ref,
            { input, output, total: input + output },
            true,
          );
        },
      })) {
        model = event.model;
        if (event.type === "text") text += event.delta;
        else if (event.type === "usage") mergeUsage(usage, event.usage);
      }

      if (text.trim()) return { text, usage, model };
      // The helper already retried provider failures. Retry an empty response
      // once, then surface the same error callers handled before.
    }

    throw new Error("The model returned an empty response");
  }

  async text(request: CompletionRequest): Promise<string> {
    return (await this.complete(request)).text;
  }

  /** Ask for JSON and tolerate prose/code fences around the object. */
  async json<T>(request: CompletionRequest): Promise<T | null> {
    const raw = await this.text(request);
    return extractJson<T>(raw);
  }
}

function mergeUsage(target: Usage, source: Usage): void {
  for (const key of Object.keys(source) as Array<keyof Usage>) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
  if (target.total === undefined && target.input !== undefined && target.output !== undefined) {
    target.total = target.input + target.output;
  }
}

function messageChars(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) {
      switch (block.type) {
        case "text":
        case "reasoning":
          total += block.text.length;
          break;
        case "tool_call":
          total += block.name.length + JSON.stringify(block.args).length;
          break;
        case "tool_result":
          total += block.output.length;
          break;
      }
    }
  }
  return total;
}
