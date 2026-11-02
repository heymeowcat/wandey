import { describe, expect, test } from "bun:test";
import type { ProviderEvent } from "../src/core/types.ts";
import {
  MidStreamError,
  isRetryableProviderError,
  streamWithFallback,
} from "../src/providers/retry.ts";

/**
 * Retry and fallback are pure stream policy, so these tests use scripted
 * generators instead of a provider or the agent loop.
 */

async function* events(list: ProviderEvent[]): AsyncGenerator<ProviderEvent> {
  for (const event of list) yield event;
}

async function* failAfter(delta: string, error: Error): AsyncGenerator<ProviderEvent> {
  yield { type: "text", delta };
  throw error;
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`provider: HTTP ${status}`), { status });
}

describe("isRetryableProviderError", () => {
  test("retries transient HTTP statuses and network failures", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableProviderError(httpError(status))).toBe(true);
    }
    expect(isRetryableProviderError(Object.assign(new Error("nope"), { options: { status: 503 } }))).toBe(true);
    expect(isRetryableProviderError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableProviderError(new Error("socket hang up"))).toBe(true);
  });

  test("does not retry client, configuration, or abort errors", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableProviderError(httpError(status))).toBe(false);
    }
    expect(isRetryableProviderError(new Error('Unknown provider "missing"'))).toBe(false);
    const abort = new DOMException("Aborted", "AbortError");
    expect(isRetryableProviderError(abort)).toBe(false);
  });
});

describe("streamWithFallback", () => {
  test("retries before the first content event", async () => {
    const attempts: number[] = [];
    const ended: Array<{ attempt: number; error?: unknown }> = [];
    const response = async function* (ref: string, call: number): AsyncGenerator<ProviderEvent> {
      if (call === 1) throw httpError(429);
      yield { type: "text", delta: "ok" };
      yield { type: "finish", reason: "stop" };
    };
    let calls = 0;

    const seen: ProviderEvent[] = [];
    for await (const event of streamWithFallback({
      candidates: ["test/model"],
      attempts: 3,
      baseDelayMs: 0,
      supportsTools: async () => true,
      open: (ref) => response(ref, ++calls),
      onAttempt: (info) => attempts.push(info.attempt),
      onAttemptEnd: (info) => ended.push({ attempt: info.attempt, error: info.error }),
    })) {
      seen.push(event);
    }

    expect(calls).toBe(2);
    expect(attempts).toEqual([1, 2]);
    expect(ended.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(ended[0]!.error).toBeDefined();
    expect(ended[1]!.error).toBeUndefined();
    expect(seen.filter((event) => event.type === "text")).toHaveLength(1);
    expect(seen.find((event) => event.type === "text")).toMatchObject({
      delta: "ok",
      model: "test/model",
      attempt: 2,
    });
  });

  test("moves to the next candidate after exhausting the primary", async () => {
    const attempts: Array<{ ref: string; attempt: number }> = [];
    const response = async function* (ref: string): AsyncGenerator<ProviderEvent> {
      if (ref === "primary/model") throw httpError(429);
      yield { type: "text", delta: "backup" };
    };

    const seen: ProviderEvent[] = [];
    for await (const event of streamWithFallback({
      candidates: ["primary/model", "backup/model"],
      attempts: 2,
      baseDelayMs: 0,
      supportsTools: async () => true,
      open: (ref) => response(ref),
      onAttempt: (info) => attempts.push({ ref: info.ref, attempt: info.attempt }),
    })) {
      seen.push(event);
    }

    expect(attempts).toEqual([
      { ref: "primary/model", attempt: 1 },
      { ref: "primary/model", attempt: 2 },
      { ref: "backup/model", attempt: 3 },
    ]);
    expect(seen.find((event) => event.type === "text")).toMatchObject({
      delta: "backup",
      model: "backup/model",
      attempt: 3,
    });
  });

  test("does not retry or fall back after content has streamed", async () => {
    let calls = 0;
    const promise = (async () => {
      for await (const _event of streamWithFallback({
        candidates: ["primary/model", "backup/model"],
        attempts: 3,
        baseDelayMs: 0,
        supportsTools: async () => true,
        open: () => failAfter("partial", httpError(500)),
        onAttempt: () => {
          calls += 1;
        },
      })) {
        // consume
      }
    })();

    await expect(promise).rejects.toBeInstanceOf(MidStreamError);
    expect(calls).toBe(1);
  });

  test("runs a fallback text-only when it cannot use tools", async () => {
    const opened: Array<{ ref: string; toolsEnabled: boolean }> = [];
    const response = async function* (ref: string): AsyncGenerator<ProviderEvent> {
      if (ref === "primary/model") throw httpError(429);
      yield { type: "text", delta: "text only" };
    };

    for await (const _event of streamWithFallback({
      candidates: ["primary/model", "backup/model"],
      attempts: 1,
      baseDelayMs: 0,
      supportsTools: async (ref) => ref !== "backup/model",
      open: (ref, toolsEnabled) => {
        opened.push({ ref, toolsEnabled });
        return response(ref);
      },
    })) {
      // consume
    }

    expect(opened).toEqual([
      { ref: "primary/model", toolsEnabled: true },
      { ref: "backup/model", toolsEnabled: false },
    ]);
  });

  test("reports cumulative usage and output size for every attempt", async () => {
    const ended: Array<{ ref: string; attempt: number; usage: unknown; outputChars: number; error?: unknown }> = [];
    const response = async function* (ref: string, call: number): AsyncGenerator<ProviderEvent> {
      if (call === 1) {
        yield { type: "usage", usage: { input: 10, output: 2, total: 12 } };
        throw httpError(429);
      }
      yield { type: "text", delta: "ok" };
      yield { type: "usage", usage: { input: 20, output: 3, total: 23 } };
    };
    let calls = 0;

    for await (const _event of streamWithFallback({
      candidates: ["test/model"],
      attempts: 2,
      baseDelayMs: 0,
      supportsTools: async () => true,
      open: (ref) => response(ref, ++calls),
      onAttemptEnd: (info) => ended.push(info),
    })) {
      // consume
    }

    expect(ended).toHaveLength(2);
    expect(ended[0]).toMatchObject({ attempt: 1, usage: { input: 10, output: 2, total: 12 }, outputChars: 0 });
    expect(ended[0]!.error).toBeDefined();
    expect(ended[1]).toMatchObject({ attempt: 2, usage: { input: 20, output: 3, total: 23 }, outputChars: 2 });
    expect(ended[1]!.error).toBeUndefined();
  });

  test("keeps attempt numbers unique when resuming", async () => {
    const attempts: number[] = [];
    for await (const _event of streamWithFallback({
      candidates: ["test/model"],
      attempts: 2,
      baseDelayMs: 0,
      startAttempt: 4,
      supportsTools: async () => true,
      open: () => events([{ type: "text", delta: "ok" }]),
      onAttempt: (info) => attempts.push(info.attempt),
    })) {
      // consume
    }

    expect(attempts).toEqual([5]);
  });

  test("skips an invalid candidate without retrying it", async () => {
    const refs: string[] = [];
    const response = async function* (ref: string): AsyncGenerator<ProviderEvent> {
      if (ref === "missing/model") throw new Error('Unknown provider "missing"');
      yield { type: "text", delta: "fallback" };
    };

    for await (const _event of streamWithFallback({
      candidates: ["missing/model", "backup/model"],
      attempts: 3,
      baseDelayMs: 0,
      supportsTools: async () => true,
      open: (ref) => {
        refs.push(ref);
        return response(ref);
      },
    })) {
      // consume
    }

    expect(refs).toEqual(["missing/model", "backup/model"]);
  });
});
