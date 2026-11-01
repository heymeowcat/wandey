import type { ChatMessage, Usage } from "../core/types.ts";
import { estimateTokens } from "../core/run-usage.ts";
import { extractJson, retry } from "../core/util.ts";
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
  /** Called at the start of every retry attempt, so budgets can reset deltas. */
  onAttempt?: () => void;
  /** Receives provider usage, or an estimate when the provider reports none. */
  onUsage?: (usage: Usage, estimated: boolean) => void;
}

export class ResearchModel {
  constructor(
    private readonly registry: ProviderRegistry,
    readonly ref: string,
  ) {}

  async text(request: CompletionRequest): Promise<string> {
    if (!this.ref.trim()) throw new Error("No model is available for research");

    const messages: ChatMessage[] =
      request.messages ??
      (request.prompt
        ? [{ role: "user", content: [{ type: "text", text: request.prompt }] }]
        : []);
    if (messages.length === 0) throw new Error("Research model call had no input");

    return retry(
      async () => {
        request.onAttempt?.();
        let output = "";
        let finishError: string | undefined;
        const usage: Usage = {};
        let reportedUsage = false;
        const report = () => {
          if (reportedUsage) {
            request.onUsage?.(usage, false);
            return;
          }
          const input = estimateTokens(request.system?.length ?? 0) + estimateTokens(messageChars(messages));
          const outputTokens = estimateTokens(output.length);
          request.onUsage?.({ input, output: outputTokens, total: input + outputTokens }, true);
        };
        try {
          for await (const event of this.registry.stream(this.ref, {
            system: request.system,
            messages,
            temperature: request.temperature ?? 0.2,
            maxTokens: request.maxTokens,
            signal: request.signal,
          })) {
            if (event.type === "text") output += event.delta;
            else if (event.type === "usage") {
              reportedUsage = true;
              mergeUsage(usage, event.usage);
            } else if (event.type === "finish" && event.error) finishError = event.error;
          }
        } catch (err) {
          report();
          throw err;
        }
        report();
        if (finishError) throw new Error(finishError);
        if (!output.trim()) throw new Error("The model returned an empty response");
        return output;
      },
      { attempts: 3, baseDelayMs: 700, signal: request.signal },
    );
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
