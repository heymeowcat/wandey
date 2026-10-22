import type {
  Message,
  Part,
  QuestionPartData,
  ResearchPartData,
  Session,
  SessionDetail,
  SourcePartData,
  ToolPartData,
} from "../src/core/types.ts";
import { formatDateTime, formatNumber, formatRelative, usageLabel } from "./format.ts";
import { icon } from "./icons.ts";
import { setMarkdown } from "./markdown.ts";

/** DOM helpers and the visual vocabulary of the chat. No framework, no vdom. */

type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key === "dataset") {
      for (const [name, entry] of Object.entries(value as Record<string, string>)) node.dataset[name] = entry;
    } else if (key === "style" && typeof value === "object") {
      Object.assign(node.style, value as Partial<CSSStyleDeclaration>);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "value" || key === "checked" || key === "disabled" || key === "hidden" || key === "open") {
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" || typeof child === "number" ? String(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export function renderConversation(detail: SessionDetail, running: boolean): DocumentFragment {
  const fragment = document.createDocumentFragment();
  detail.messages.forEach((entry, index) => {
    const live = running && index === detail.messages.length - 1 && entry.message.role === "assistant";
    fragment.append(renderMessage(entry.message, entry.parts, live, running));
  });
  return fragment;
}

export function renderMessage(message: Message, parts: Part[], live = false, sessionRunning = false): HTMLElement {
  const article = el("article", {
    class: `message ${message.role === "user" ? "message-user" : "message-assistant"}`,
    dataset: { messageId: message.id },
  });

  const meta = el("div", { class: "message-meta" });
  if (message.role === "user") {
    meta.append(el("span", { class: "role-badge role-user", text: "You" }));
    meta.append(el("span", { class: "message-time", text: formatDateTime(message.createdAt) }));
  } else {
    const badge = el("span", { class: "role-badge role-assistant" });
    badge.append(icon("spark", 13), document.createTextNode("Wandey"));
    meta.append(badge);
    if (message.model) meta.append(el("span", { class: "message-model", text: shortModel(message.model) }));
    const usage = usageLabel(message.usage);
    if (usage) meta.append(el("span", { class: "message-usage", text: usage }));
    if (message.finishReason === "length") meta.append(el("span", { class: "message-warning", text: "truncated" }));
  }
  article.append(meta);

  const body = el("div", { class: "message-body" });
  const sources: SourcePartData[] = [];
  for (const part of parts) {
    if (part.type === "source") {
      sources.push(part.data);
      continue;
    }
    body.append(renderPart(part, live, sessionRunning));
  }
  if (sources.length > 0) body.append(renderSourceStrip(sources));
  article.append(body);
  return article;
}

export function renderPart(part: Part, live = false, sessionRunning = false): HTMLElement {
  switch (part.type) {
    case "text":
      return renderTextPart(part.id, part.data.text);
    case "reasoning":
      return renderReasoningPart(part.id, part.data.text, live);
    case "tool":
      return renderToolPart(part.id, part.data);
    case "question":
      return renderQuestionPart(part.id, part.data, sessionRunning);
    case "research":
      return renderResearchPart(part.id, part.data);
    case "source":
      return sourceChip(part.data);
    case "error":
      return el("div", { class: "part error-part" }, icon("alert", 16), el("span", { text: part.data.message }));
  }
}

function renderTextPart(id: string, text: string): HTMLElement {
  const part = el("div", { class: "part text-part", dataset: { partId: id } });
  const markdown = el("div", { class: "markdown" });
  setMarkdown(markdown, text);
  part.append(markdown);
  return part;
}

function renderReasoningPart(id: string, text: string, live: boolean): HTMLElement {
  const details = el("details", { class: "part reasoning-part", dataset: { partId: id }, open: live });
  const summary = el("summary");
  summary.append(icon("spark", 14), el("span", { text: "Reasoning" }), el("span", { class: "reasoning-count", text: `${formatNumber(text.length)} chars` }));
  details.append(summary);
  const markdown = el("div", { class: "markdown reasoning-body" });
  setMarkdown(markdown, text);
  details.append(markdown);
  return details;
}

function renderToolPart(id: string, data: ToolPartData): HTMLElement {
  const card = el("section", {
    class: `part tool-card tool-${data.status}`,
    dataset: { partId: id, toolName: data.name },
  });

  const head = el("div", { class: "tool-head" });
  const glyph = el("span", { class: "tool-glyph" });
  glyph.append(icon(toolIcon(data.name), 15));
  head.append(glyph);

  const titles = el("div", { class: "tool-titles" });
  titles.append(el("div", { class: "tool-title", text: data.title || humanize(data.name) }));
  const bits = [data.name];
  if (data.endedAt) bits.push(`${((data.endedAt - data.startedAt) / 1000).toFixed(1)}s`);
  titles.append(el("div", { class: "tool-subtitle", text: bits.join(" · ") }));
  head.append(titles);
  head.append(el("span", { class: `status-pill status-${data.status}`, text: data.status }));
  card.append(head);

  const hasArgs = data.args && Object.keys(data.args).length > 0;
  if (hasArgs) {
    const details = el("details", { class: "tool-details" });
    details.append(el("summary", { text: "Arguments" }));
    const pre = el("pre", { class: "tool-raw" });
    pre.textContent = JSON.stringify(data.args, null, 2);
    details.append(pre);
    card.append(details);
  }

  if (data.output) {
    const details = el("details", { class: "tool-details tool-output" });
    const label = data.status === "error" ? "Error" : "Output";
    details.append(el("summary", { text: `${label} · ${formatNumber(data.output.length)} chars` }));
    const pre = el("pre", { class: "tool-raw" });
    pre.textContent = data.output;
    details.append(pre);
    card.append(details);
  }
  return card;
}

function renderQuestionPart(id: string, data: QuestionPartData, sessionRunning: boolean): HTMLElement {
  const card = el("section", { class: "part question-card", dataset: { partId: id, questionId: data.questionID } });
  const head = el("div", { class: "question-head" });
  head.append(icon("spark", 15));
  head.append(el("span", { class: "question-header", text: data.header || "A question for you" }));
  head.append(el("span", { class: `status-pill status-${data.status ?? "pending"}`, text: data.status ?? "pending" }));
  card.append(head);
  card.append(el("p", { class: "question-text", text: data.question }));

  if (data.answer && data.answer.length > 0) {
    const answers = el("div", { class: "answer-chips" });
    for (const answer of data.answer) answers.append(el("span", { class: "answer-chip", text: answer }));
    if (data.custom) answers.append(el("span", { class: "answer-chip answer-custom", text: data.custom }));
    card.append(answers);
  } else if (data.custom) {
    card.append(el("div", { class: "answer-chips" }, el("span", { class: "answer-chip answer-custom", text: data.custom })));
  } else if (data.status === "pending" && sessionRunning) {
    const actions = el("div", { class: "question-actions" });
    actions.append(el("span", { class: "question-hint", text: "The agent is waiting for your input." }));
    const button = el("button", { class: "button button-small", type: "button", dataset: { answerQuestion: data.questionID } });
    button.append(icon("check", 14), document.createTextNode("Answer"));
    actions.append(button);
    card.append(actions);
  } else if (data.status === "pending") {
    card.append(el("p", { class: "muted", text: "This question expired while Wandey was offline." }));
  } else if (data.status === "expired") {
    card.append(el("p", { class: "muted", text: "This question expired." }));
  }
  return card;
}

function renderResearchPart(id: string, data: ResearchPartData): HTMLElement {
  const card = el("section", {
    class: `part research-card research-${data.status}`,
    dataset: { partId: id, researchJob: data.jobID },
  });

  const head = el("div", { class: "research-head" });
  const badge = el("span", { class: "research-badge" });
  badge.append(icon("spark", 15), document.createTextNode("Deep research"));
  head.append(badge);
  head.append(el("span", { class: `status-pill status-${data.status}`, text: data.status }));
  card.append(head);

  const progress = data.progress;
  const percent = researchPercent(data);
  const stageNames: Record<string, string> = {
    planning: "Planning",
    searching: "Searching",
    crawling: "Reading sources",
    extracting: "Extracting evidence",
    analyzing: "Finding gaps",
    synthesizing: "Writing report",
    done: "Complete",
    error: "Failed",
  };
  card.append(el("div", { class: "research-stage", text: stageNames[progress.stage] ?? progress.stage }));

  const track = el("div", { class: "progress-track", role: "progressbar", "aria-valuenow": percent });
  track.append(el("div", { class: "progress-fill", style: { width: `${percent}%` } }));
  card.append(track);

  const stats = el("div", { class: "research-stats" });
  if (progress.subQuestionsTotal > 0) stats.append(el("span", { text: `${progress.subQuestionsDone}/${progress.subQuestionsTotal} questions` }));
  stats.append(el("span", { text: `${progress.pagesFetched} pages` }));
  stats.append(el("span", { text: `${progress.sourcesFound} found` }));
  if (progress.round > 0) stats.append(el("span", { text: `round ${progress.round}/${progress.roundTotal}` }));
  card.append(stats);

  card.append(el("div", { class: "research-message", text: progress.message }));
  if (progress.current.length > 0) {
    const current = el("div", { class: "current-chips" });
    for (const label of progress.current.slice(0, 4)) current.append(el("span", { class: "current-chip", text: label }));
    if (progress.current.length > 4) current.append(el("span", { class: "current-chip", text: `+${progress.current.length - 4}` }));
    card.append(current);
  }

  if (data.error) card.append(el("div", { class: "research-error", text: data.error }));

  if (data.status === "error" && data.jobID) {
    const actions = el("div", { class: "research-actions" });
    const button = el("button", {
      class: "button button-small",
      type: "button",
      dataset: { resumeJob: data.jobID },
    });
    button.append(icon("clock", 14), document.createTextNode("Resume from saved work"));
    actions.append(button);
    card.append(actions);
  }

  if (data.report) {
    const details = el("details", { class: "research-report" });
    details.append(el("summary", { text: `Full report · ${formatNumber(data.report.length)} chars` }));
    const markdown = el("div", { class: "markdown report-body" });
    setMarkdown(markdown, data.report);
    details.append(markdown);
    card.append(details);
  }
  return card;
}

export function renderSourceStrip(sources: SourcePartData[]): HTMLElement {
  const strip = el("div", { class: "source-strip" });
  strip.append(el("span", { class: "source-strip-label" }, icon("book", 13), document.createTextNode(`Sources · ${sources.length}`)));
  const list = el("div", { class: "source-chips" });
  for (const source of sources) list.append(sourceChip(source));
  strip.append(list);
  return strip;
}

export function sourceChip(source: SourcePartData): HTMLButtonElement {
  const button = el("button", {
    class: "source-chip",
    type: "button",
    dataset: { sourceId: source.sourceID },
    title: source.title,
  });
  button.append(el("span", { class: "source-id", text: source.sourceID.toUpperCase() }));
  button.append(el("span", { class: "source-title", text: source.title }));
  return button;
}

// ---------------------------------------------------------------------------
// Empty state and sidebar
// ---------------------------------------------------------------------------

const SUGGESTIONS = [
  {
    title: "Compare local-first databases",
    prompt: "Compare SQLite and PostgreSQL for a local-first desktop app in 2026. Focus on embedding, concurrency, sync, and operational cost.",
  },
  {
    title: "Map a new field",
    prompt: "What are the most credible open-source web crawling projects in 2026, and how do their architectures differ?",
  },
  {
    title: "Stress-test a claim",
    prompt: "Is the recent excitement around small language models justified? Find the strongest evidence for and against, with sources.",
  },
];

export function renderEmptyState(): HTMLElement {
  const wrap = el("div", { class: "empty-state" });
  const mark = el("div", { class: "empty-mark" });
  mark.append(icon("spark", 28));
  wrap.append(mark);
  wrap.append(el("h2", { text: "What should we investigate?" }));
  wrap.append(
    el("p", {
      class: "empty-sub",
      text: "Ask a question, or switch on Deep research to let Wandey plan, read, and cite across the web.",
    }),
  );
  const grid = el("div", { class: "suggestion-grid" });
  for (const suggestion of SUGGESTIONS) {
    const card = el("button", {
      class: "suggestion",
      type: "button",
      dataset: { prompt: suggestion.prompt },
    });
    card.append(el("span", { class: "suggestion-title", text: suggestion.title }));
    card.append(el("span", { class: "suggestion-prompt", text: suggestion.prompt }));
    grid.append(card);
  }
  wrap.append(grid);
  return wrap;
}

export function renderSessionList(sessions: Session[], activeID: string | null): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (sessions.length === 0) {
    fragment.append(el("p", { class: "sidebar-empty", text: "No sessions yet." }));
    return fragment;
  }
  for (const session of sessions) {
    const item = el("div", {
      class: `session-item${session.id === activeID ? " active" : ""}`,
      dataset: { sessionId: session.id },
      role: "button",
      tabindex: "0",
    });
    const info = el("div", { class: "session-info" });
    info.append(el("span", { class: "session-title", text: session.title }));
    const meta = el("span", { class: "session-meta" });
    meta.append(el("span", { class: "session-mode", text: session.mode === "research" ? "research" : "chat" }));
    meta.append(el("span", { text: formatRelative(session.updatedAt) }));
    info.append(meta);
    item.append(info);
    const remove = el("button", {
      class: "session-delete",
      type: "button",
      title: "Delete session",
      "aria-label": `Delete ${session.title}`,
      dataset: { deleteSession: session.id },
    });
    remove.append(icon("trash", 14));
    item.append(remove);
    fragment.append(item);
  }
  return fragment;
}

// ---------------------------------------------------------------------------
// Modals and toasts
// ---------------------------------------------------------------------------

export interface ModalHandle {
  backdrop: HTMLElement;
  dialog: HTMLElement;
  body: HTMLElement;
  close: () => void;
}

export interface ModalOptions {
  title?: string;
  subtitle?: string;
  className?: string;
  dismissible?: boolean;
  onClose?: () => void;
}

export function openModal(options: ModalOptions = {}): ModalHandle {
  const root = document.getElementById("modal-root");
  if (!root) throw new Error("modal-root missing");

  let closed = false;
  const backdrop = el("div", { class: "modal-backdrop" });
  const dialog = el("section", {
    class: `modal ${options.className ?? ""}`.trim(),
    role: "dialog",
    "aria-modal": "true",
    "aria-label": options.title ?? "Dialog",
  });

  if (options.title || options.subtitle) {
    const head = el("header", { class: "modal-head" });
    const titles = el("div", { class: "modal-titles" });
    if (options.title) titles.append(el("h2", { text: options.title }));
    if (options.subtitle) titles.append(el("p", { text: options.subtitle }));
    head.append(titles);
    if (options.dismissible !== false) {
      const closeButton = el("button", { class: "icon-button", type: "button", title: "Close", "aria-label": "Close" });
      closeButton.append(icon("close", 18));
      closeButton.addEventListener("click", () => close());
      head.append(closeButton);
    }
    dialog.append(head);
  }

  const body = el("div", { class: "modal-body" });
  dialog.append(body);
  backdrop.append(dialog);
  root.append(backdrop);

  const previousFocus = document.activeElement as HTMLElement | null;

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && options.dismissible !== false) close();
  }
  document.addEventListener("keydown", onKeydown);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop && options.dismissible !== false) close();
  });

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown);
    backdrop.classList.add("modal-leaving");
    setTimeout(() => backdrop.remove(), 120);
    previousFocus?.focus();
    options.onClose?.();
  }

  setTimeout(() => {
    const target = dialog.querySelector<HTMLElement>("input, textarea, button");
    target?.focus();
  }, 30);

  return { backdrop, dialog, body, close };
}

export function showToast(level: "info" | "error" | "success", message: string): void {
  const root = document.getElementById("toast-root");
  if (!root) return;
  while (root.children.length >= 4) root.firstElementChild?.remove();

  const toast = el("div", { class: `toast toast-${level}`, role: "status" });
  toast.append(icon(level === "error" ? "alert" : level === "success" ? "check" : "globe", 16));
  toast.append(el("span", { class: "toast-text", text: message }));
  const closeButton = el("button", { class: "toast-close", type: "button", "aria-label": "Dismiss" });
  closeButton.append(icon("close", 14));
  closeButton.addEventListener("click", () => toast.remove());
  toast.append(closeButton);
  root.append(toast);

  setTimeout(() => {
    toast.classList.add("toast-leaving");
    setTimeout(() => toast.remove(), 180);
  }, level === "error" ? 9_000 : 4_500);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function researchPercent(data: ResearchPartData): number {
  if (data.status === "done" || data.status === "error") return 100;
  const progress = data.progress;
  if (progress.subQuestionsTotal > 0 && progress.subQuestionsDone > 0) {
    return Math.min(97, 62 + (progress.subQuestionsDone / progress.subQuestionsTotal) * 26);
  }
  const floor: Record<string, number> = {
    planning: 4,
    searching: 18,
    crawling: 38,
    extracting: 58,
    analyzing: 72,
    synthesizing: 88,
  };
  return floor[progress.stage] ?? 5;
}

function toolIcon(name: string): string {
  switch (name) {
    case "web_search":
      return "search";
    case "fetch_url":
      return "globe";
    case "crawl_site":
    case "list_sources":
      return "layers";
    case "read_source":
      return "book";
    case "save_report":
      return "doc";
    case "deep_research":
      return "spark";
    case "ask_user":
      return "spark";
    default:
      return "globe";
  }
}

function humanize(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortModel(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1] ?? ref;
}
