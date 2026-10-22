import type { ChatMessage } from "../core/types.ts";
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
        let output = "";
        let finishError: string | undefined;
        for await (const event of this.registry.stream(this.ref, {
          system: request.system,
          messages,
          temperature: request.temperature ?? 0.2,
          maxTokens: request.maxTokens,
          signal: request.signal,
        })) {
          if (event.type === "text") output += event.delta;
          else if (event.type === "finish" && event.error) finishError = event.error;
        }
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
