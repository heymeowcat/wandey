import type { RunBudget, RunUsage } from "./types.ts";

/**
 * Run accounting helpers shared by the store and the agent.
 *
 * Budgets are snapshotted per run, so every entry point normalizes them the
 * same way. `0` always means "unlimited".
 */

export const EMPTY_RUN_BUDGET: RunBudget = {
  maxTokens: 0,
  maxCostUsd: 0,
  maxSeconds: 0,
  maxToolCalls: 0,
  maxCrawlPages: 0,
};

export function emptyRunUsage(): RunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    toolCalls: 0,
    crawlPages: 0,
    elapsedMs: 0,
    estimated: false,
  };
}

export function normalizeRunBudget(budget: Partial<RunBudget> | null | undefined): RunBudget {
  return {
    maxTokens: nonNegative(budget?.maxTokens),
    maxCostUsd: nonNegative(budget?.maxCostUsd),
    maxSeconds: nonNegative(budget?.maxSeconds),
    maxToolCalls: nonNegative(budget?.maxToolCalls),
    maxCrawlPages: nonNegative(budget?.maxCrawlPages),
  };
}

export function normalizeRunUsage(usage: Partial<RunUsage> | null | undefined): RunUsage {
  const base = emptyRunUsage();
  if (!usage) return base;
  return {
    inputTokens: nonNegative(usage.inputTokens),
    outputTokens: nonNegative(usage.outputTokens),
    totalTokens: nonNegative(usage.totalTokens),
    costUsd: nonNegative(usage.costUsd),
    toolCalls: nonNegative(usage.toolCalls),
    crawlPages: nonNegative(usage.crawlPages),
    elapsedMs: nonNegative(usage.elapsedMs),
    estimated: Boolean(usage.estimated),
  };
}

/** Providers do not always report usage; this is the documented fallback. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
