import { describe, expect, test } from "bun:test";
import type { ProviderEvent, Usage } from "../src/core/types.ts";
import { ResearchModel } from "../src/research/model.ts";
import type { ProviderRegistry } from "../src/providers/registry.ts";

/**
 * Research calls share the provider retry/fallback policy but are not streamed
 * to the UI. These tests keep that batch path honest without a network call.
 */

function registryWith(
  responder: (ref: string, call: number) => AsyncGenerator<ProviderEvent>,
): ProviderRegistry {
  const counts = new Map<string, number>();
  return {
    stream: async function* (ref: string) {
      const call = (counts.get(ref) ?? 0) + 1;
      counts.set(ref, call);
      yield* responder(ref, call);
    },
  } as unknown as ProviderRegistry;
}

function error(status: number): Error & { status: number } {
  return Object.assign(new Error(`provider: HTTP ${status}`), { status });
}

async function* text(value: string, usage?: Usage): AsyncGenerator<ProviderEvent> {
  if (value) yield { type: "text", delta: value };
  if (usage) yield { type: "usage", usage };
  yield { type: "finish", reason: "stop" };
}

describe("ResearchModel retry and fallback", () => {
  test("retries a transient failure before content", async () => {
    const attempts: number[] = [];
    const model = new ResearchModel(
      registryWith((_ref, call) => {
        if (call === 1) throw error(429);
        return text("recovered");
      }),
      "fake/primary",
      { attempts: 2, baseDelayMs: 0, fallback: [] },
    );

    const result = await model.complete({
      prompt: "Summarize the evidence",
      onAttempt: (_ref, attempt) => attempts.push(attempt),
    });

    expect(result.text).toBe("recovered");
    expect(result.model).toBe("fake/primary");
    expect(attempts).toEqual([1, 2]);
  });

  test("falls back to the next candidate", async () => {
    const seen: string[] = [];
    const model = new ResearchModel(
      registryWith((ref) => {
        seen.push(ref);
        if (ref === "fake/primary") throw error(503);
        return text("backup research");
      }),
      "fake/primary",
      { attempts: 1, baseDelayMs: 0, fallback: ["fake/backup"] },
    );

    const result = await model.complete({ prompt: "Question" });

    expect(result.text).toBe("backup research");
    expect(result.model).toBe("fake/backup");
    expect(seen).toEqual(["fake/primary", "fake/backup"]);
  });

  test("retries an empty completion once", async () => {
    let calls = 0;
    const model = new ResearchModel(
      registryWith(() => {
        calls += 1;
        return text(calls === 1 ? "" : "eventual");
      }),
      "fake/primary",
      { attempts: 1, baseDelayMs: 0, fallback: [] },
    );

    const result = await model.complete({ prompt: "Question" });

    expect(result.text).toBe("eventual");
    expect(calls).toBe(2);
  });

  test("reports provider usage and estimates when it is missing", async () => {
    const reported: Array<{ model: string; usage: Usage; estimated: boolean }> = [];
    const model = new ResearchModel(
      registryWith(() => text("answer", { input: 10, output: 2, total: 12 })),
      "fake/primary",
      { attempts: 1, baseDelayMs: 0, fallback: [] },
    );

    const result = await model.complete({
      prompt: "Question",
      onUsage: (ref, usage, estimated) => reported.push({ model: ref, usage, estimated }),
    });

    expect(result.usage.total).toBe(12);
    expect(reported).toEqual([
      { model: "fake/primary", usage: { input: 10, output: 2, total: 12 }, estimated: false },
    ]);
  });
});
