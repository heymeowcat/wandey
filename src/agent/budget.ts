import { estimateTokens, normalizeRunUsage } from "../core/run-usage.ts";
import type { ModelInfo, RunBudget, RunUsage, Usage } from "../core/types.ts";

/**
 * Live budget accounting for one active run.
 *
 * `run_step` remains the durable record. This controller mirrors the same
 * numbers while a step is streaming so a token or cost overrun can stop the
 * model before the step is persisted.
 */

export type BudgetDimension = "tokens" | "cost" | "time" | "tools" | "pages";

export class BudgetExceededError extends Error {
  constructor(
    readonly dimension: BudgetDimension,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export interface RunBudgetControllerOptions {
  budget: RunBudget;
  usage: RunUsage;
  onExceeded: (error: BudgetExceededError) => void;
  onChange?: (usage: RunUsage) => void;
  /** Completed tool step keys, so a resumed run does not recount them. */
  toolKeys?: Iterable<string>;
}

export class RunBudgetController {
  private usage: RunUsage;
  private lastUsage: Usage = {};
  private readonly toolKeys: Set<string>;
  private startedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failure: BudgetExceededError | null = null;

  constructor(private readonly options: RunBudgetControllerOptions) {
    this.usage = normalizeRunUsage(options.usage);
    this.toolKeys = new Set(options.toolKeys ?? []);
  }

  /** Start the wall-clock timer. Returns a stop function for the run's finally block. */
  start(): () => void {
    if (this.startedAt === null) {
      this.startedAt = Date.now();
      const maxMs = this.options.budget.maxSeconds * 1000;
      if (maxMs > 0) {
        const remaining = Math.max(0, maxMs - this.usage.elapsedMs);
        this.timer = setTimeout(() => {
          try {
            this.fail(this.timeError());
          } catch {
            // `onExceeded` already aborted the run; timers cannot throw.
          }
        }, remaining);
        // A budget timer alone must not keep the process alive.
        (this.timer as { unref?: () => void }).unref?.();
      }
    }
    return () => this.stop();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.startedAt !== null) {
      const total = this.elapsedMs();
      this.startedAt = null;
      this.usage.elapsedMs = total;
    }
  }

  elapsedMs(): number {
    return this.usage.elapsedMs + (this.startedAt === null ? 0 : Date.now() - this.startedAt);
  }

  /** Reset the per-attempt usage snapshot before a new provider stream. */
  beginModelAttempt(): void {
    this.lastUsage = {};
  }

  /** Pre-flight check for any next operation. */
  check(): void {
    this.throwIfFailed();
    this.assertBefore(["tokens", "cost", "time", "tools", "pages"]);
  }

  /** Pre-flight check for a model attempt. Tools and pages are not relevant yet. */
  checkModel(): void {
    this.throwIfFailed();
    this.assertBefore(["tokens", "cost", "time"]);
  }

  /**
   * Pre-flight check for a tool call. Page limits are enforced as pages are
   * actually fetched, not when an unrelated tool starts.
   */
  checkTool(): void {
    this.throwIfFailed();
    this.assertBefore(["tokens", "cost", "time", "tools"]);
  }

  /**
   * Add a provider usage event. Events within one attempt are cumulative
   * snapshots, so only positive deltas reach the run totals.
   */
  addUsage(model: string, usage: Usage, info: ModelInfo | null, estimated = false): void {
    const previous = this.lastUsage;
    const next: Usage = { ...previous };
    for (const key of Object.keys(usage) as Array<keyof Usage>) {
      const value = usage[key];
      if (value !== undefined) next[key] = value;
    }

    const input = Math.max(0, (next.input ?? 0) - (previous.input ?? 0));
    const output = Math.max(0, (next.output ?? 0) - (previous.output ?? 0));
    const nextTotal = next.total ?? (next.input ?? 0) + (next.output ?? 0);
    const previousTotal = previous.total ?? (previous.input ?? 0) + (previous.output ?? 0);
    const total = Math.max(0, nextTotal - previousTotal);
    const cost = usage.cost !== undefined
      ? Math.max(0, usage.cost - (previous.cost ?? 0))
      : tokenCost(input, output, info);

    this.lastUsage = next;
    this.usage.inputTokens += input;
    this.usage.outputTokens += output;
    this.usage.totalTokens += total;
    this.usage.costUsd += cost;
    this.usage.estimated = this.usage.estimated || estimated;
    this.changed();
    this.assertAfter(["tokens", "cost"], model);
  }

  /** Estimate a step that produced output without any provider usage events. */
  addEstimatedUsage(inputChars: number, outputChars: number, info: ModelInfo | null): void {
    const input = estimateTokens(inputChars);
    const output = estimateTokens(outputChars);
    this.usage.inputTokens += input;
    this.usage.outputTokens += output;
    this.usage.totalTokens += input + output;
    this.usage.costUsd += tokenCost(input, output, info);
    this.usage.estimated = true;
    this.changed();
    this.assertAfter(["tokens", "cost"]);
  }

  /** Count a top-level tool call once per step key. */
  addToolCall(key?: string): void {
    if (key) {
      if (this.toolKeys.has(key)) return;
      this.toolKeys.add(key);
    }
    this.usage.toolCalls += 1;
    this.changed();
    this.assertAfter(["tools"]);
  }

  addCrawlPages(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.usage.crawlPages += delta;
    this.changed();
    this.assertAfter(["pages"]);
  }

  snapshot(): RunUsage {
    return { ...this.usage, elapsedMs: this.elapsedMs() };
  }

  private assertBefore(dimensions: BudgetDimension[]): void {
    this.assert(dimensions, true);
  }

  private assertAfter(dimensions: BudgetDimension[], model?: string): void {
    this.assert(dimensions, false, model);
  }

  private assert(dimensions: BudgetDimension[], inclusive: boolean, model?: string): void {
    const budget = this.options.budget;
    const used = this.usage;
    const at = (value: number, max: number) => max > 0 && (inclusive ? value >= max : value > max);

    if (dimensions.includes("tokens") && at(used.totalTokens, budget.maxTokens)) {
      this.fail(
        new BudgetExceededError(
          "tokens",
          `Run budget exceeded: max ${formatNumber(budget.maxTokens)} tokens (used ${formatNumber(used.totalTokens)}).`,
        ),
      );
    }
    if (dimensions.includes("cost") && at(used.costUsd, budget.maxCostUsd)) {
      this.fail(
        new BudgetExceededError(
          "cost",
          `Run budget exceeded: max $${budget.maxCostUsd.toFixed(2)} (used $${used.costUsd.toFixed(4)}).`,
        ),
      );
    }
    if (dimensions.includes("time") && at(this.elapsedMs(), budget.maxSeconds * 1000)) {
      this.fail(this.timeError());
    }
    if (dimensions.includes("tools") && at(used.toolCalls, budget.maxToolCalls)) {
      this.fail(
        new BudgetExceededError(
          "tools",
          `Run budget exceeded: max ${formatNumber(budget.maxToolCalls)} tool calls (used ${formatNumber(used.toolCalls)}).`,
        ),
      );
    }
    if (dimensions.includes("pages") && at(used.crawlPages, budget.maxCrawlPages)) {
      this.fail(
        new BudgetExceededError(
          "pages",
          `Run budget exceeded: max ${formatNumber(budget.maxCrawlPages)} crawled pages (used ${formatNumber(used.crawlPages)}).`,
        ),
      );
    }
    // `model` is part of the public signature for future per-model limits.
    void model;
  }

  private timeError(): BudgetExceededError {
    const max = this.options.budget.maxSeconds;
    const used = Math.round(this.elapsedMs() / 1000);
    return new BudgetExceededError(
      "time",
      `Run budget exceeded: max ${formatNumber(max)}s (used ${formatNumber(used)}s).`,
    );
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  private fail(error: BudgetExceededError): never {
    if (!this.failure) {
      this.failure = error;
      this.options.onExceeded(error);
    }
    throw this.failure;
  }

  private changed(): void {
    this.options.onChange?.(this.snapshot());
  }
}

function tokenCost(input: number, output: number, info: ModelInfo | null): number {
  const inputCost = info?.costPerMTok?.input ?? 0;
  const outputCost = info?.costPerMTok?.output ?? 0;
  return (input / 1_000_000) * inputCost + (output / 1_000_000) * outputCost;
}

/** Price a usage record using provider cost when present, catalog rates otherwise. */
export function usageCost(usage: Usage, info: ModelInfo | null): number {
  if (usage.cost !== undefined) return usage.cost;
  return tokenCost(usage.input ?? 0, usage.output ?? 0, info);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
