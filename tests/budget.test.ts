import { describe, expect, test } from "bun:test";
import {
  BudgetExceededError,
  RunBudgetController,
} from "../src/agent/budget.ts";
import { emptyRunUsage, normalizeRunBudget } from "../src/core/run-usage.ts";
import type { ModelInfo } from "../src/core/types.ts";

/**
 * Unit tests for live budget accounting. Agent-level stop/resume behavior is
 * covered in tests/runs.test.ts.
 */

function controller(
  patch: Partial<ReturnType<typeof normalizeRunBudget>> = {},
  usage = emptyRunUsage(),
): { budget: RunBudgetController; errors: BudgetExceededError[] } {
  const errors: BudgetExceededError[] = [];
  const budget = new RunBudgetController({
    budget: normalizeRunBudget({ ...patch }),
    usage,
    onExceeded: (error) => errors.push(error),
  });
  return { budget, errors };
}

const info: ModelInfo = {
  id: "model",
  name: "Model",
  provider: "test",
  ref: "test/model",
  costPerMTok: { input: 1, output: 2 },
};

describe("RunBudgetController", () => {
  test("counts cumulative usage events as deltas", () => {
    const { budget } = controller({ maxTokens: 100 });
    budget.beginModelAttempt();
    budget.addUsage("test/model", { input: 10, output: 2 }, null);
    budget.addUsage("test/model", { input: 10, output: 5, total: 15 }, null);

    expect(budget.snapshot().inputTokens).toBe(10);
    expect(budget.snapshot().outputTokens).toBe(5);
    expect(budget.snapshot().totalTokens).toBe(15);
  });

  test("prices usage from the catalog when the provider omits cost", () => {
    const { budget } = controller({ maxCostUsd: 10 });
    budget.beginModelAttempt();
    budget.addUsage("test/model", { input: 1_000_000, output: 1_000_000 }, info);

    expect(budget.snapshot().costUsd).toBe(3);
  });

  test("estimates tokens when a provider reports no usage", () => {
    const { budget } = controller({ maxTokens: 1_000 });
    budget.addEstimatedUsage(400, 40, null);

    const usage = budget.snapshot();
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(10);
    expect(usage.totalTokens).toBe(110);
    expect(usage.estimated).toBe(true);
  });

  test("counts a tool call once per step key", () => {
    const { budget } = controller({ maxToolCalls: 10 });
    budget.addToolCall("tool:0:0:call_1");
    budget.addToolCall("tool:0:0:call_1");
    budget.addToolCall("tool:0:1:call_2");

    expect(budget.snapshot().toolCalls).toBe(2);
  });

  test("throws before starting work that would exceed a limit", () => {
    const { budget, errors } = controller({ maxToolCalls: 1 });
    budget.addToolCall("one");
    expect(() => budget.check()).toThrow(BudgetExceededError);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.dimension).toBe("tools");
  });

  test("stops after the page limit is exceeded", () => {
    const { budget, errors } = controller({ maxCrawlPages: 1 });
    budget.addCrawlPages(1);
    expect(() => budget.addCrawlPages(1)).toThrow(BudgetExceededError);
    expect(errors[0]!.dimension).toBe("pages");
    expect(budget.snapshot().crawlPages).toBe(2);
  });

  test("fires the wall-clock timer once", async () => {
    const { budget, errors } = controller({ maxSeconds: 0.02 });
    const stop = budget.start();
    await Bun.sleep(50);
    stop();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.dimension).toBe("time");
    expect(budget.snapshot().elapsedMs).toBeGreaterThanOrEqual(20);
  });
});
