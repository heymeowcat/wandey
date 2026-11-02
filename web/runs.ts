import type { Run, RunCheckpoint, RunStep } from "../src/core/types.ts";
import { api } from "./api.ts";
import { clear, el, openModal, showToast, type ModalHandle } from "./components.ts";
import { formatCost, formatDateTime, formatNumber, formatRelative } from "./format.ts";
import { icon } from "./icons.ts";

/**
 * Durable-run chrome: a compact strip above the conversation and an on-demand
 * trace. Both read the same ledger that the agent persisted, so a reload or a
 * server restart never loses the story of a run.
 */

export interface RunStripHandlers {
  onTrace: (runID: string) => void;
  onResume: (runID: string) => void;
  onDismiss: (runID: string) => void;
}

export interface RunTraceHandle {
  runID: string;
  update(run: Run, steps?: RunStep[]): void;
  addStep(step: RunStep): void;
  close(): void;
}

interface BudgetDimension {
  label: string;
  used: number;
  limit: number;
  value: string;
}

const ACTIVE_STATUSES = new Set(["running", "waiting"]);

export function isActiveRun(run: Run): boolean {
  return ACTIVE_STATUSES.has(run.status);
}

export function isResumableRun(run: Run): boolean {
  if (run.dismissedAt || isActiveRun(run) || run.status === "completed") return false;
  // A budget stop is terminal on purpose. Starting a new prompt gets a fresh
  // budget instead of resuming something that will immediately stop again.
  return run.stopReason !== "budget";
}

/**
 * Pick the run the strip should describe. An active run wins; otherwise the
 * newest resumable run stays visible; otherwise show the newest run so a
 * completed trace remains one click away.
 */
export function selectRun(runs: Run[]): Run | null {
  if (runs.length === 0) return null;
  const active = runs.find(isActiveRun);
  if (active) return active;
  const resumable = runs.find((run) => !run.dismissedAt && isResumableRun(run));
  return resumable ?? runs[0] ?? null;
}

export function renderRunStrip(run: Run, handlers: RunStripHandlers): HTMLElement {
  const strip = el("div", { class: `run-strip-inner run-${statusTone(run)}` });

  const main = el("div", { class: "run-strip-main" });
  const dot = el("span", { class: `run-status-dot run-${statusTone(run)}`, "aria-hidden": "true" });
  const copy = el("div", { class: "run-strip-copy" });
  const title = el("div", { class: "run-strip-title" });
  title.append(
    el("span", { class: `run-status-label run-${statusTone(run)}`, text: runStatusLabel(run) }),
    el("span", { class: "run-strip-sep", text: "·" }),
    el("span", { class: "run-strip-model", text: run.model ? shortModel(run.model) : "no model" }),
  );
  copy.append(title);
  copy.append(
    el("div", {
      class: "run-strip-meta",
      text: [
        formatRelative(run.startedAt),
        duration(run.usage.elapsedMs),
        `${run.usage.estimated ? "~" : ""}${formatNumber(run.usage.totalTokens)} tokens`,
        formatCost(run.usage.costUsd),
        run.usage.toolCalls > 0 ? `${run.usage.toolCalls} tool${run.usage.toolCalls === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    }),
  );
  main.append(dot, copy);

  const budget = el("div", { class: "run-budget", "aria-label": "Run budget" });
  for (const dimension of budgetDimensions(run)) budget.append(renderBudgetRow(dimension));

  const actions = el("div", { class: "run-strip-actions" });
  actions.append(
    actionButton("Trace", "layers", () => handlers.onTrace(run.id)),
  );
  if (isResumableRun(run)) {
    actions.append(actionButton("Resume", "refresh", () => handlers.onResume(run.id), "button-primary"));
  }
  if (!isActiveRun(run)) {
    actions.append(actionButton("Dismiss", "close", () => handlers.onDismiss(run.id), "button-ghost"));
  }

  strip.append(main, budget, actions);
  if (run.error) strip.append(el("div", { class: "run-strip-error", text: run.error, title: run.error }));
  return strip;
}

export async function openRunTrace(options: {
  runID: string;
  onClose?: () => void;
}): Promise<RunTraceHandle | null> {
  let modal: ModalHandle | null = null;
  let currentRun: Run | null = null;
  let currentSteps: RunStep[] = [];

  const handle: RunTraceHandle = {
    runID: options.runID,
    update(run, steps) {
      currentRun = run;
      if (steps) currentSteps = steps;
      if (modal) renderTrace(modal, currentRun, currentSteps);
    },
    addStep(step) {
      const index = currentSteps.findIndex((entry) => entry.id === step.id);
      if (index === -1) currentSteps.push(step);
      else currentSteps[index] = step;
      if (modal && currentRun) renderTrace(modal, currentRun, currentSteps);
    },
    close() {
      modal?.close();
    },
  };

  modal = openModal({
    title: "Run trace",
    subtitle: options.runID,
    className: "trace-modal",
    onClose: () => {
      modal = null;
      options.onClose?.();
    },
  });
  modal.body.append(el("p", { class: "trace-loading", text: "Loading the run ledger…" }));

  try {
    const detail = await api.run(options.runID);
    currentRun = detail.run;
    currentSteps = detail.steps;
    renderTrace(modal, currentRun, currentSteps, detail.checkpoints);
    return handle;
  } catch (err) {
    if (modal) {
      clear(modal.body);
      modal.body.append(
        el("p", { class: "trace-error", text: `Could not load the trace: ${(err as Error).message}` }),
      );
    }
    showToast("error", `Could not load the run trace: ${(err as Error).message}`);
    return null;
  }
}

function renderTrace(modal: ModalHandle, run: Run, steps: RunStep[], checkpoints?: RunCheckpoint[]): void {
  const scrollTop = modal.body.scrollTop;
  clear(modal.body);

  modal.body.append(renderTraceSummary(run));

  const budget = el("section", { class: "trace-section" });
  budget.append(el("h3", { text: "Budget" }));
  const rows = budgetDimensions(run);
  if (rows.length === 0) {
    budget.append(el("p", { class: "trace-empty", text: "No budget limits configured." }));
  } else {
    const list = el("div", { class: "trace-budget" });
    for (const dimension of rows) list.append(renderBudgetRow(dimension, true));
    budget.append(list);
  }
  modal.body.append(budget);

  const stepsSection = el("section", { class: "trace-section" });
  stepsSection.append(
    el("h3", {
      text: `Steps (${steps.length})`,
    }),
  );
  if (steps.length === 0) {
    stepsSection.append(el("p", { class: "trace-empty", text: "No steps recorded yet." }));
  } else {
    const list = el("div", { class: "trace-steps" });
    for (const step of steps) list.append(renderTraceStep(step));
    stepsSection.append(list);
  }
  modal.body.append(stepsSection);

  if (checkpoints && checkpoints.length > 0) {
    const last = checkpoints[checkpoints.length - 1]!;
    const footer = el("p", {
      class: "trace-footnote",
      text: `Checkpoint ${checkpoints.length} · loop ${last.state.loopStep} · ${last.state.phase}`,
    });
    modal.body.append(footer);
  }
  if (run.usage.estimated) {
    modal.body.append(
      el("p", {
        class: "trace-footnote",
        text: "Some token counts were estimated because the provider did not report usage.",
      }),
    );
  }

  modal.body.scrollTop = scrollTop;
}

function renderTraceSummary(run: Run): HTMLElement {
  const section = el("section", { class: "trace-section trace-summary" });
  const header = el("div", { class: "trace-summary-head" });
  header.append(
    el("span", { class: `run-status-label run-${statusTone(run)}`, text: runStatusLabel(run) }),
    el("span", { class: "trace-summary-time", text: formatDateTime(run.startedAt) }),
  );
  section.append(header);
  if (run.prompt) section.append(el("p", { class: "trace-prompt", text: run.prompt }));
  if (run.error) section.append(el("p", { class: "trace-error", text: run.error }));

  const grid = el("div", { class: "trace-facts" });
  const facts: Array<[string, string]> = [
    ["Model", run.model ?? "—"],
    ["Stop reason", run.stopReason ?? "—"],
    ["Active time", duration(run.usage.elapsedMs)],
    ["Tokens", `${run.usage.estimated ? "~" : ""}${formatNumber(run.usage.totalTokens)}`],
    ["Cost", formatCost(run.usage.costUsd) || "—"],
    ["Tool calls", String(run.usage.toolCalls)],
    ["Crawl pages", String(run.usage.crawlPages)],
    ["Resumes", String(run.resumeCount)],
  ];
  for (const [label, value] of facts) {
    const item = el("div", { class: "trace-fact" });
    item.append(el("span", { class: "trace-fact-label", text: label }), el("span", { class: "trace-fact-value", text: value }));
    grid.append(item);
  }
  section.append(grid);
  return section;
}

function renderTraceStep(step: RunStep): HTMLElement {
  const details = el("details", { class: `trace-step step-${step.status}` });
  const summary = el("summary", { class: "trace-step-summary" });
  summary.append(
    el("span", { class: "trace-step-ordinal", text: `#${step.ordinal}` }),
    el("span", { class: "trace-step-kind", text: step.kind }),
    el("span", { class: "trace-step-name", text: step.title || step.name }),
    el("span", { class: "trace-step-status", text: step.status }),
    el("span", { class: "trace-step-meta", text: stepMeta(step) }),
  );
  details.append(summary);

  const body = el("div", { class: "trace-step-body" });
  if (step.error) body.append(el("p", { class: "trace-step-error", text: step.error }));
  if (step.refID) {
    body.append(el("p", { class: "trace-step-ref", text: `Research job: ${step.refID}` }));
  }
  if (step.input) body.append(payload("Input", step.input));
  if (step.output) body.append(payload("Output", step.output));
  if (step.usage?.estimated) body.append(el("p", { class: "trace-footnote", text: "Usage estimated." }));
  if (!step.error && !step.input && !step.output && !step.refID) {
    body.append(el("p", { class: "trace-empty", text: "No captured payload." }));
  }
  details.append(body);
  return details;
}

function payload(label: string, text: string): HTMLElement {
  const block = el("div", { class: "trace-payload" });
  block.append(
    el("div", { class: "trace-payload-label", text: label }),
    el("pre", { class: "trace-payload-text", text }),
  );
  return block;
}

function renderBudgetRow(dimension: BudgetDimension, detailed = false): HTMLElement {
  const ratio = dimension.limit > 0 ? dimension.used / dimension.limit : 0;
  const percent = Math.max(0, Math.min(100, ratio * 100));
  const over = dimension.limit > 0 && dimension.used > dimension.limit;
  const row = el("div", { class: `run-budget-row${over ? " is-over" : ""}${detailed ? " run-budget-row-detail" : ""}` });
  const head = el("div", { class: "run-budget-head" });
  head.append(
    el("span", { class: "run-budget-label", text: dimension.label }),
    el("span", { class: "run-budget-value", text: dimension.value }),
  );
  const meter = el("div", { class: "run-budget-meter", role: "progressbar", "aria-label": dimension.label });
  const fill = el("span", { class: "run-budget-fill" });
  fill.style.width = `${percent}%`;
  meter.append(fill);
  row.append(head, meter);
  return row;
}

function budgetDimensions(run: Run): BudgetDimension[] {
  const { budget, usage } = run;
  const dimensions: BudgetDimension[] = [];
  const add = (label: string, used: number, limit: number, format: (value: number) => string) => {
    if (limit <= 0 && used <= 0) return;
    dimensions.push({
      label,
      used,
      limit,
      value: limit > 0 ? `${format(used)} / ${format(limit)}` : format(used),
    });
  };
  const tokenFormat = (value: number) => `${usage.estimated ? "~" : ""}${formatNumber(value)}`;
  add("Tokens", usage.totalTokens, budget.maxTokens, tokenFormat);
  add("Cost", usage.costUsd, budget.maxCostUsd, money);
  add("Time", Math.round(usage.elapsedMs / 1000), budget.maxSeconds, (value) => `${value}s`);
  add("Tool calls", usage.toolCalls, budget.maxToolCalls, String);
  add("Crawl pages", usage.crawlPages, budget.maxCrawlPages, String);
  return dimensions;
}

function actionButton(
  label: string,
  iconName: string,
  onClick: () => void,
  variant = "button-ghost",
): HTMLButtonElement {
  const button = el("button", {
    class: `button button-small run-action ${variant}`,
    type: "button",
    title: label,
    onClick,
  });
  button.append(icon(iconName, 14), el("span", { text: label }));
  return button;
}

function stepMeta(step: RunStep): string {
  const bits: string[] = [];
  if (step.model) bits.push(shortModel(step.model));
  if (step.attempt > 1) bits.push(`attempt ${step.attempt}`);
  if (step.endedAt) bits.push(duration(step.endedAt - step.startedAt));
  else bits.push("running");
  const total = (step.usage?.input ?? 0) + (step.usage?.output ?? 0);
  if (total > 0) bits.push(`${step.usage?.estimated ? "~" : ""}${formatNumber(total)} tokens`);
  if (step.usage?.cost) bits.push(formatCost(step.usage.cost));
  if (step.crawlPages > 0) bits.push(`${step.crawlPages} pages`);
  return bits.join(" · ");
}

function runStatusLabel(run: Run): string {
  if (run.status === "running") return "Running";
  if (run.status === "waiting") return "Waiting for you";
  if (run.status === "interrupted") return "Interrupted";
  if (run.status === "completed") return "Complete";
  if (run.stopReason === "budget") return "Budget stopped";
  if (run.status === "aborted") return "Stopped";
  return "Failed";
}

function statusTone(run: Run): string {
  if (run.status === "completed") return "success";
  if (run.status === "running") return "active";
  if (run.status === "waiting") return "waiting";
  if (run.status === "interrupted") return "warning";
  if (run.stopReason === "budget" || run.status === "failed") return "danger";
  return "muted";
}

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function money(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function shortModel(ref: string): string {
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : ref.slice(slash + 1);
}
