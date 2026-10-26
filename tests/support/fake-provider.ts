import type { ChatRequest, ModelInfo, ProviderAdapter, ProviderEvent, Usage } from "../../src/core/types.ts";
import type { ProviderRegistry } from "../../src/providers/registry.ts";
import type { Store } from "../../src/storage/store.ts";

/**
 * A deterministic stand-in for ProviderRegistry.
 *
 * Tests script the exact event sequence each model call produces. That keeps
 * retry, fallback, and resume tests independent of network access or a live
 * model's mood.
 */

export interface FakeModel {
  supportsTools?: boolean;
  costPerMTok?: { input?: number; output?: number };
}

export type Responder = (
  ref: string,
  request: ChatRequest,
  call: number,
) => AsyncIterable<ProviderEvent> | Promise<AsyncIterable<ProviderEvent>>;

export class FakeRegistry {
  readonly calls: Array<{ ref: string; request: ChatRequest }> = [];
  private counts = new Map<string, number>();

  constructor(
    readonly models: Record<string, FakeModel>,
    private readonly responder: Responder,
  ) {}

  private adapter(ref: string): ProviderAdapter {
    const provider = ref.split("/")[0] ?? "fake";
    const model = ref.slice(provider.length + 1);
    const info: ModelInfo = {
      id: model,
      name: model,
      provider,
      ref,
      supportsTools: this.models[ref]?.supportsTools ?? true,
      costPerMTok: this.models[ref]?.costPerMTok,
    };
    return {
      id: provider,
      kind: "openai",
      authenticated: true,
      listModels: async () => [info],
      async *stream() {
        throw new Error("The fake registry streams through FakeRegistry.stream, not the adapter.");
      },
    };
  }

  async resolve(ref: string): Promise<{ adapter: ProviderAdapter; model: string; ref: string }> {
    if (!this.models[ref]) throw new Error(`Unknown model "${ref}"`);
    const provider = ref.split("/")[0] ?? "fake";
    return { adapter: this.adapter(ref), model: ref.slice(provider.length + 1), ref };
  }

  async defaultModel(): Promise<string | null> {
    return Object.keys(this.models)[0] ?? null;
  }

  async supportsTools(ref: string): Promise<boolean> {
    return this.models[ref]?.supportsTools ?? true;
  }

  async modelInfo(ref: string): Promise<ModelInfo | null> {
    const model = this.models[ref];
    if (!model) return null;
    const provider = ref.split("/")[0] ?? "fake";
    return {
      id: ref.slice(provider.length + 1),
      name: ref,
      provider,
      ref,
      supportsTools: model.supportsTools ?? true,
      costPerMTok: model.costPerMTok,
    };
  }

  async *stream(ref: string, request: Omit<ChatRequest, "model">): AsyncGenerator<ProviderEvent> {
    const call = (this.counts.get(ref) ?? 0) + 1;
    this.counts.set(ref, call);
    this.calls.push({ ref, request: { ...request, model: ref } });
    yield* await this.responder(ref, { ...request, model: ref }, call);
  }

  asRegistry(): ProviderRegistry {
    return this as unknown as ProviderRegistry;
  }
}

export async function* textResponse(text: string, usage?: Usage): AsyncGenerator<ProviderEvent> {
  if (text) yield { type: "text", delta: text };
  if (usage) yield { type: "usage", usage };
  yield { type: "finish", reason: "stop" };
}

export async function* toolCallResponse(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  usage?: Usage,
): AsyncGenerator<ProviderEvent> {
  for (const call of calls) yield { type: "tool_call", ...call };
  if (usage) yield { type: "usage", usage };
  yield { type: "finish", reason: "tool_calls" };
}

export async function waitForRun(store: Store, runID: string, timeoutMs = 5_000): Promise<NonNullable<ReturnType<Store["getRun"]>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.getRun(runID);
    if (run && run.status !== "running" && run.status !== "waiting") return run;
    await Bun.sleep(5);
  }
  throw new Error(`Run ${runID} did not finish within ${timeoutMs}ms`);
}
