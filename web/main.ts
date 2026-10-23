import type {
  ClientEvent,
  Message,
  ModelInfo,
  Part,
  QuestionPartData,
  ResearchJob,
  ServerEvent,
  Session,
  SessionMode,
} from "../src/core/types.ts";
import { api, ApiError, type LoadedSessionDetail, type ProviderInfo } from "./api.ts";
import {
  clear,
  el,
  openModal,
  renderConversation,
  renderEmptyState,
  renderSessionList,
  renderPart,
  showToast,
  sourceChip,
  type ModalHandle,
} from "./components.ts";
import { formatDateTime, formatNumber } from "./format.ts";
import { icon } from "./icons.ts";
import { setMarkdown } from "./markdown.ts";
import { openModelPicker } from "./model-picker.ts";
import { openProviderModal } from "./providers.ts";

/**
 * The browser controller.
 *
 * State lives in one object. Structural events (new message, new part) re-render
 * the conversation; token deltas patch only the affected text part on a short
 * timer. That keeps streaming cheap without introducing a framework.
 */

interface AppState {
  sessions: Session[];
  detail: LoadedSessionDetail | null;
  models: ModelInfo[];
  providers: ProviderInfo[];
  selectedModel: string;
  running: boolean;
  status: "idle" | "streaming" | "tool" | "waiting";
  connected: boolean;
}

const state: AppState = {
  sessions: [],
  detail: null,
  models: [],
  providers: [],
  selectedModel: localStorage.getItem("wandey.model") ?? "",
  running: false,
  status: "idle",
  connected: false,
};

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const els = {
  app: $("app"),
  sidebar: $("sidebar"),
  sessionList: $("session-list"),
  newSession: $<HTMLButtonElement>("new-session"),
  providerSummary: $<HTMLButtonElement>("provider-summary"),
  dashboardButton: $<HTMLButtonElement>("dashboard-button"),
  toggleSidebar: $<HTMLButtonElement>("toggle-sidebar"),
  sessionTitle: $("session-title"),
  sessionMeta: $("session-meta"),
  connection: $("connection"),
  modelButton: $<HTMLButtonElement>("model-button"),
  modelButtonMark: $("model-button-mark"),
  modelButtonName: $("model-button-name"),
  modelButtonMeta: $("model-button-meta"),
  modelButtonBadges: $("model-button-badges"),
  themeToggle: $<HTMLButtonElement>("theme-toggle"),
  chat: $("chat"),
  composerInput: $<HTMLTextAreaElement>("composer-input"),
  sendButton: $<HTMLButtonElement>("send-button"),
  stopButton: $<HTMLButtonElement>("stop-button"),
  researchMode: $<HTMLInputElement>("research-mode"),
  composerHint: $("composer-hint"),
};

let socket: WebSocket | null = null;
let reconnectAttempt = 0;
let pollTimer: number | undefined;
let activeQuestion: { sessionID: string; part: QuestionPartData } | null = null;
let questionModal: ModalHandle | null = null;
const partTimers = new Map<string, number>();
const notifiedJobs = new Set<string>();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

void boot();

async function boot(): Promise<void> {
  applyTheme();
  bindEvents();
  connectSocket();
  await loadModels();
  await refreshSessions();

  const preferred = localStorage.getItem("wandey.session");
  const session = state.sessions.find((item) => item.id === preferred) ?? state.sessions[0];
  if (session) await loadSession(session.id);
  else await createSession();
}

async function loadModels(options: { quiet?: boolean } = {}): Promise<{ models: ModelInfo[]; providers: ProviderInfo[] } | null> {
  try {
    const data = await api.models();
    state.models = data.models;
    state.providers = data.providers;
    if (!state.selectedModel && state.models.length > 0) {
      state.selectedModel = state.models.find((model) => model.supportsTools !== false)?.ref ?? state.models[0]!.ref;
    }
    renderModelButton();
    renderProviderSummary();
    renderHeader();
    renderComposer();
    if (state.models.length === 0 && !options.quiet) {
      showToast("info", "No models yet. Connect a provider to get started.");
    }
    return data;
  } catch (err) {
    showToast("error", `Could not load models: ${(err as Error).message}`);
    return null;
  }
}

async function refreshModelsData(): Promise<{ models: ModelInfo[]; providers: ProviderInfo[] }> {
  const data = await api.refreshProviders();
  state.models = data.models;
  state.providers = data.providers;
  if (!state.selectedModel && state.models.length > 0) {
    state.selectedModel = state.models.find((model) => model.supportsTools !== false)?.ref ?? state.models[0]!.ref;
  }
  renderModelButton();
  renderProviderSummary();
  renderHeader();
  renderComposer();
  return { models: data.models, providers: data.providers };
}

async function refreshSessions(): Promise<void> {
  try {
    const { sessions } = await api.sessions();
    state.sessions = sessions;
    renderSidebar();
  } catch (err) {
    showToast("error", `Could not load sessions: ${(err as Error).message}`);
  }
}

async function loadSession(id: string): Promise<void> {
  try {
    const detail = await api.session(id);
    closeQuestionModal();
    state.detail = detail;
    state.running = Boolean(detail.running);
    state.status = state.running ? "streaming" : "idle";
    state.selectedModel = detail.session.model ?? state.selectedModel;
    localStorage.setItem("wandey.session", id);
    if (state.selectedModel) localStorage.setItem("wandey.model", state.selectedModel);
    renderModelButton();
    subscribe(id);
    renderAll();

    if (state.running) {
      const pending = findPendingQuestion(detail);
      if (pending) showQuestion(pending, id);
      else startPolling();
    }
    closeMobileSidebar();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      await refreshSessions();
      const next = state.sessions[0];
      if (next) await loadSession(next.id);
    } else {
      showToast("error", `Could not open session: ${(err as Error).message}`);
    }
  }
}

async function createSession(): Promise<void> {
  try {
    const mode: SessionMode = els.researchMode.checked ? "research" : "chat";
    const { session } = await api.createSession({ mode, model: state.selectedModel || null });
    state.sessions.unshift(session);
    renderSidebar();
    await loadSession(session.id);
    els.composerInput.focus();
  } catch (err) {
    showToast("error", `Could not create a session: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll(): void {
  renderSidebar();
  renderHeader();
  renderModelButton();
  renderChat();
  renderComposer();
}

function renderHeader(): void {
  const session = state.detail?.session;
  els.sessionTitle.textContent = session?.title ?? "New research";
  document.title = session ? `${session.title} · wandey` : "wandey";

  const bits: string[] = [];
  if (session) bits.push(session.mode === "research" ? "Deep research" : "Chat");
  if (state.selectedModel) bits.push(shortModel(state.selectedModel));
  if (state.running) {
    bits.push(state.status === "waiting" ? "waiting for you" : state.status === "tool" ? "running tools" : "working");
  }
  els.sessionMeta.textContent = bits.join(" · ");
  els.connection.className = `connection-dot ${state.connected ? "online" : "offline"}`;
  els.connection.title = state.connected ? "Connected to the local agent" : "Reconnecting…";
}

function renderSidebar(): void {
  clear(els.sessionList);
  els.sessionList.append(renderSessionList(state.sessions, state.detail?.session.id ?? null));
  renderProviderSummary();
}

function renderProviderSummary(): void {
  clear(els.providerSummary);
  const connected = state.providers.filter((provider) => provider.modelCount > 0);
  const attention = state.providers.filter(
    (provider) => provider.modelCount === 0 && provider.error && provider.auto !== "local",
  );
  const dot = el("span", { class: `provider-summary-dot${connected.length > 0 ? " ready" : ""}${attention.length > 0 ? " attention" : ""}` });
  const copy = el("span", { class: "provider-summary-copy" });
  const title = el("span", { class: "provider-summary-title" });
  const sub = el("span", { class: "provider-summary-sub" });

  if (connected.length === 0) {
    title.textContent = "Connect a provider";
    sub.textContent = attention.length > 0 ? "A configured provider needs attention" : "Add an API key or start a local server";
  } else {
    const names = connected.map((provider) => provider.name);
    title.textContent = names.length <= 2 ? names.join(" + ") : `${names[0]} + ${names.length - 1} more`;
    const count = connected.reduce((sum, provider) => sum + provider.modelCount, 0);
    sub.textContent = `${count} models${attention.length > 0 ? ` · ${attention.length} needs attention` : ""}`;
  }
  copy.append(title, sub);
  const chevron = el("span", { class: "provider-summary-chevron" });
  chevron.append(icon("chevron", 13));
  els.providerSummary.append(dot, copy, chevron);
  els.providerSummary.classList.toggle("attention", attention.length > 0);
  els.providerSummary.title = "Manage provider connections";
}

function renderModelButton(): void {
  const ref = state.detail?.session.model ?? state.selectedModel;
  const model = ref ? state.models.find((entry) => entry.ref === ref) : undefined;
  const provider = model ? state.providers.find((entry) => entry.id === model.provider) : undefined;

  clear(els.modelButtonBadges);
  els.modelButton.classList.toggle("is-empty", !ref);
  els.modelButton.classList.toggle("is-missing", Boolean(ref) && !model);

  if (!ref) {
    els.modelButtonMark.textContent = "?";
    els.modelButtonMark.style.removeProperty("--provider-hue");
    els.modelButtonName.textContent = "Choose a model";
    els.modelButtonMeta.textContent = state.models.length > 0 ? "Select a model to start" : "No models connected";
    els.modelButton.title = "Choose a model";
    return;
  }

  const name = model?.name ?? shortModel(ref);
  els.modelButtonMark.textContent = (provider?.name ?? ref).slice(0, 1).toUpperCase();
  els.modelButtonMark.style.setProperty("--provider-hue", providerHue(provider?.id ?? ref.split("/")[0] ?? ref));
  els.modelButtonName.textContent = name;
  els.modelButtonMeta.textContent = model
    ? `${provider?.name ?? model.provider}${model.free ? " · free" : ""}`
    : "Not available right now";
  els.modelButton.title = model ? `Change model · ${ref}` : `Current model is unavailable · ${ref}`;

  if (model?.free) els.modelButtonBadges.append(el("span", { class: "model-badge badge-free", text: "Free" }));
  if (provider?.local) els.modelButtonBadges.append(el("span", { class: "model-badge badge-local", text: "Local" }));
}

function renderChat(forceBottom = false): void {
  const near = isNearBottom();
  const previousScroll = els.chat.scrollTop;
  clear(els.chat);

  if (!state.detail || state.detail.messages.length === 0) {
    els.chat.append(renderEmptyState());
  } else {
    els.chat.append(renderConversation(state.detail, state.running));
  }

  if (forceBottom || near) scrollToBottom();
  else els.chat.scrollTop = previousScroll;
}

function renderComposer(): void {
  const session = state.detail?.session;
  const mode = session?.mode ?? "chat";
  els.researchMode.checked = mode === "research";
  els.researchMode.disabled = state.running || !session;
  els.sendButton.disabled = state.running || !session || state.models.length === 0;
  els.sendButton.title = state.models.length === 0 ? "Connect a provider before sending a message" : "Send";
  els.stopButton.hidden = !state.running;
  els.modelButton.disabled = state.models.length === 0 && state.providers.length === 0;
  els.composerHint.textContent =
    state.models.length === 0
      ? "Connect a provider to start chatting"
      : state.running
        ? state.status === "waiting"
          ? "Answer the question above to continue"
          : "Wandey is working…"
        : "Enter to send · Shift+Enter for a new line";
  resizeComposer();
}

function applySessionUpdate(session: Session): void {
  const index = state.sessions.findIndex((item) => item.id === session.id);
  if (index === -1) state.sessions.unshift(session);
  else state.sessions[index] = session;
  state.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  if (state.detail?.session.id === session.id) {
    state.detail.session = session;
    if (session.model) {
      state.selectedModel = session.model;
      renderModelButton();
    }
  }
  renderSidebar();
  renderHeader();
  renderComposer();
}

// ---------------------------------------------------------------------------
// Composer and session actions
// ---------------------------------------------------------------------------

async function sendPrompt(): Promise<void> {
  const text = els.composerInput.value.trim();
  const session = state.detail?.session;
  if (!text || !session || state.running) return;

  els.composerInput.value = "";
  resizeComposer();
  state.running = true;
  state.status = "streaming";
  renderHeader();
  renderComposer();

  try {
    await api.prompt(session.id, text, {
      model: state.selectedModel || undefined,
      mode: els.researchMode.checked ? "research" : "chat",
    });
    if (!state.connected) startPolling();
  } catch (err) {
    state.running = false;
    state.status = "idle";
    els.composerInput.value = text;
    renderHeader();
    renderComposer();
    showToast("error", (err as Error).message);
  }
}

async function stopRun(): Promise<void> {
  const session = state.detail?.session;
  if (!session) return;
  try {
    await api.abort(session.id);
    showToast("info", "Stopping…");
  } catch (err) {
    showToast("error", `Could not stop: ${(err as Error).message}`);
  }
}

async function resumeResearch(jobID: string): Promise<void> {
  if (!state.detail?.session) {
    showToast("info", "Open the research session first.");
    return;
  }
  try {
    await api.resumeResearch(jobID);
    state.running = true;
    state.status = "streaming";
    renderHeader();
    renderComposer();
    showToast("info", "Resuming from the saved checkpoint…");
    await reloadCurrent();
    if (!state.connected) startPolling();
  } catch (err) {
    showToast("error", `Could not resume: ${(err as Error).message}`);
  }
}

async function selectModel(ref: string): Promise<void> {
  if (!ref) return;
  const session = state.detail?.session;
  const previousSelected = state.selectedModel;
  const previousSessionModel = session?.model ?? null;

  state.selectedModel = ref;
  localStorage.setItem("wandey.model", ref);
  if (session) session.model = ref;
  renderModelButton();
  renderHeader();
  renderComposer();

  if (!session) return;
  try {
    const { session: updated } = await api.updateSession(session.id, { model: ref });
    applySessionUpdate(updated);
  } catch (err) {
    state.selectedModel = previousSelected;
    if (session) session.model = previousSessionModel;
    if (previousSelected) localStorage.setItem("wandey.model", previousSelected);
    renderModelButton();
    renderHeader();
    renderComposer();
    showToast("error", `Could not change model: ${(err as Error).message}`);
  }
}

function openModelPickerModal(): void {
  openModelPicker({
    models: state.models,
    providers: state.providers,
    selected: state.detail?.session.model ?? state.selectedModel,
    running: state.running,
    onSelect: (ref) => void selectModel(ref),
    onManageProviders: () => openProvidersModal(),
    onRefresh: refreshModelsData,
  });
}

function openProvidersModal(): void {
  openProviderModal({
    onChange: async () => {
      await loadModels({ quiet: true });
    },
  });
}

async function changeMode(): Promise<void> {
  if (!state.detail) return;
  const mode: SessionMode = els.researchMode.checked ? "research" : "chat";
  try {
    const { session } = await api.updateSession(state.detail.session.id, { mode });
    applySessionUpdate(session);
  } catch (err) {
    els.researchMode.checked = state.detail.session.mode === "research";
    showToast("error", `Could not change mode: ${(err as Error).message}`);
  }
}

async function renameSession(): Promise<void> {
  const session = state.detail?.session;
  if (!session) return;
  const next = window.prompt("Rename session", session.title)?.trim();
  if (!next || next === session.title) return;
  try {
    const { session: updated } = await api.updateSession(session.id, { title: next });
    applySessionUpdate(updated);
  } catch (err) {
    showToast("error", `Could not rename: ${(err as Error).message}`);
  }
}

async function deleteSession(id: string): Promise<void> {
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  if (!window.confirm(`Delete "${session.title}" and its sources?`)) return;
  try {
    await api.deleteSession(id);
    state.sessions = state.sessions.filter((item) => item.id !== id);
    if (state.detail?.session.id === id) {
      state.detail = null;
      closeQuestionModal();
      const next = state.sessions[0];
      if (next) await loadSession(next.id);
      else await createSession();
    } else {
      renderSidebar();
    }
  } catch (err) {
    showToast("error", `Could not delete: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function connectSocket(): void {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/ws`);

  socket.addEventListener("open", () => {
    state.connected = true;
    reconnectAttempt = 0;
    renderHeader();
    stopPolling();
    const id = state.detail?.session.id;
    if (id) subscribe(id);
    if (document.readyState === "complete") void resync();
  });

  socket.addEventListener("message", (message) => {
    let event: ServerEvent;
    try {
      event = JSON.parse(String(message.data)) as ServerEvent;
    } catch {
      return;
    }
    applyEvent(event);
  });

  socket.addEventListener("close", () => {
    state.connected = false;
    renderHeader();
    const delay = Math.min(1_000 * 2 ** reconnectAttempt++, 10_000);
    setTimeout(connectSocket, delay);
    if (state.running) startPolling();
  });

  socket.addEventListener("error", () => socket?.close());
}

function subscribe(sessionID: string): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const event: ClientEvent = { type: "subscribe", sessionID };
  socket.send(JSON.stringify(event));
}

async function resync(): Promise<void> {
  await refreshSessions();
  if (state.detail) await loadSession(state.detail.session.id);
}

function applyEvent(event: ServerEvent): void {
  if (event.type === "hello") return;
  if (event.type === "toast") {
    showToast(event.level, event.message);
    return;
  }

  const currentID = state.detail?.session.id;

  if (event.type === "session.updated") {
    applySessionUpdate(event.session);
    return;
  }

  if (event.type === "session.deleted") {
    state.sessions = state.sessions.filter((session) => session.id !== event.sessionID);
    if (currentID === event.sessionID) {
      state.detail = null;
      const next = state.sessions[0];
      if (next) void loadSession(next.id);
    }
    renderSidebar();
    return;
  }

  if (!currentID || !("sessionID" in event) || event.sessionID !== currentID) return;

  switch (event.type) {
    case "message.created": {
      if (!state.detail) return;
      if (state.detail.messages.some((entry) => entry.message.id === event.message.id)) return;
      state.detail.messages.push({ message: event.message, parts: [] });
      if (event.message.role === "assistant") {
        state.running = true;
        state.status = "streaming";
        renderComposer();
        renderHeader();
      }
      renderChat(event.message.role === "user");
      break;
    }

    case "part.created": {
      const entry = findEntry(event.messageID);
      if (!entry) {
        void reloadCurrent();
        return;
      }
      if (!entry.parts.some((part) => part.id === event.part.id)) entry.parts.push(event.part);
      renderChat();
      break;
    }

    case "part.delta": {
      const part = findPart(event.partID);
      if (!part || (part.type !== "text" && part.type !== "reasoning")) return;
      part.data.text += event.delta;
      schedulePartRender(part.id);
      break;
    }

    case "part.updated": {
      upsertPart(event.part);
      break;
    }

    case "research.progress": {
      upsertPart(event.part);
      break;
    }

    case "message.updated": {
      const entry = findEntry(event.message.id);
      if (entry) entry.message = event.message;
      renderChat();
      break;
    }

    case "session.status": {
      state.running = event.status !== "idle";
      state.status = event.status;
      renderHeader();
      renderComposer();
      if (event.status === "idle") {
        stopPolling();
        // A pending question is no longer live once the run has ended. Re-render
        // so it reads as expired instead of offering a button that cannot work.
        renderChat();
      } else if (event.status === "waiting") {
        const pending = state.detail ? findPendingQuestion(state.detail) : null;
        if (pending) showQuestion(pending, currentID);
      }
      break;
    }

    case "session.error": {
      showToast("error", event.message);
      break;
    }

    case "question": {
      if (event.part.type === "question") showQuestion(event.part.data, event.sessionID);
      break;
    }

    case "question.done": {
      if (event.part.type === "question" && activeQuestion?.part.questionID === event.part.data.questionID) {
        closeQuestionModal();
      }
      break;
    }

    case "crawl.progress":
      break;
  }
}

function findEntry(messageID: string): { message: Message; parts: Part[] } | null {
  return state.detail?.messages.find((entry) => entry.message.id === messageID) ?? null;
}

function findPart(partID: string): Part | null {
  if (!state.detail) return null;
  for (const entry of state.detail.messages) {
    const part = entry.parts.find((item) => item.id === partID);
    if (part) return part;
  }
  return null;
}

function findPendingQuestion(detail: LoadedSessionDetail): QuestionPartData | null {
  for (const entry of [...detail.messages].reverse()) {
    for (const part of [...entry.parts].reverse()) {
      if (part.type === "question" && part.data.status === "pending") return part.data;
    }
  }
  return null;
}

function upsertPart(part: Part): void {
  const entry = findEntry(part.messageID);
  if (!entry) {
    void reloadCurrent();
    return;
  }
  const index = entry.parts.findIndex((item) => item.id === part.id);
  if (index === -1) entry.parts.push(part);
  else entry.parts[index] = part;

  if (part.type === "source") {
    renderChat();
    return;
  }
  replacePartNode(part);
}

function replacePartNode(part: Part): void {
  const node = els.chat.querySelector<HTMLElement>(`[data-part-id="${part.id}"]`);
  if (!node) {
    renderChat();
    return;
  }
  const near = isNearBottom();
  node.replaceWith(renderPart(part, state.running, state.running));
  if (near) scrollToBottom();
}

function schedulePartRender(partID: string): void {
  if (partTimers.has(partID)) return;
  const timer = window.setTimeout(() => {
    partTimers.delete(partID);
    const part = findPart(partID);
    if (!part) return;
    replacePartNode(part);
  }, 70);
  partTimers.set(partID, timer);
}

async function reloadCurrent(): Promise<void> {
  const id = state.detail?.session.id;
  if (!id) return;
  try {
    const detail = await api.session(id);
    state.detail = detail;
    state.running = Boolean(detail.running);
    renderAll();
  } catch {
    // The session probably disappeared; the next navigation will resync.
  }
}

// ---------------------------------------------------------------------------
// Question modal
// ---------------------------------------------------------------------------

function showQuestion(part: QuestionPartData, sessionID: string): void {
  if (activeQuestion?.part.questionID === part.questionID && questionModal) return;
  closeQuestionModal();
  activeQuestion = { sessionID, part };

  const modal = openModal({
    title: part.header || "A decision is needed",
    subtitle: "Wandey is paused until you answer.",
    className: "question-modal",
    dismissible: false,
    onClose: () => {
      if (questionModal === modal) questionModal = null;
    },
  });
  questionModal = modal;

  const form = el("form", { class: "question-form" });
  form.append(el("p", { class: "question-prompt", text: part.question }));

  if (part.options.length > 0) {
    const options = el("div", { class: "question-options" });
    for (const option of part.options) {
      const label = el("label", { class: "question-option" });
      const input = el("input", {
        type: part.multiple ? "checkbox" : "radio",
        name: "q-option",
        value: option.label,
      });
      label.append(input);
      const body = el("span", { class: "option-body" });
      body.append(el("span", { class: "option-label", text: option.label }));
      if (option.description) body.append(el("span", { class: "option-description", text: option.description }));
      label.append(body);
      options.append(label);
    }
    form.append(options);
  }

  let custom: HTMLTextAreaElement | null = null;
  if (part.allowCustom) {
    custom = el("textarea", {
      class: "question-custom",
      name: "custom",
      rows: "3",
      placeholder: "Or type a custom answer…",
    });
    form.append(custom);
  }

  const footer = el("div", { class: "modal-actions" });
  const skip = el("button", { class: "button button-ghost", type: "button", text: "Skip" });
  const submit = el("button", { class: "button button-primary", type: "submit", text: "Answer" });
  footer.append(skip, submit);
  form.append(footer);

  const finish = async (answer: string[], customText?: string): Promise<void> => {
    submit.disabled = true;
    skip.disabled = true;
    try {
      const result = await api.answer(sessionID, part.questionID, answer, customText);
      if (!result.ok) throw new ApiError("That question is no longer open.", 409);
      activeQuestion = null;
      closeQuestionModal();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        closeQuestionModal();
        renderChat();
        showToast("error", "That question is no longer open. The run may have stopped or another tab answered it.");
        return;
      }
      submit.disabled = false;
      skip.disabled = false;
      showToast("error", `Could not answer: ${(err as Error).message}`);
    }
  };

  skip.addEventListener("click", () => void finish([]));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const answer = data.getAll("q-option").map(String);
    const customText = custom?.value.trim() || undefined;
    if (answer.length === 0 && !customText) {
      showToast("info", "Choose an option or type an answer, or press Skip.");
      return;
    }
    void finish(answer, customText);
  });

  modal.body.append(form);
}

function closeQuestionModal(): void {
  if (questionModal) {
    const modal = questionModal;
    questionModal = null;
    modal.close();
  }
  activeQuestion = null;
}

// ---------------------------------------------------------------------------
// Source viewer
// ---------------------------------------------------------------------------

async function openSource(sessionID: string, sourceID: string): Promise<void> {
  const modal = openModal({
    title: `Source ${sourceID.toUpperCase()}`,
    subtitle: "Saved page content used by this research.",
    className: "source-modal",
  });
  const loading = el("div", { class: "loading-state" });
  loading.append(el("span", { class: "spinner" }), el("span", { text: "Loading source…" }));
  modal.body.append(loading);

  try {
    const { source } = await api.source(sessionID, sourceID);
    clear(modal.body);

    const head = el("div", { class: "source-detail-head" });
    const titles = el("div", {});
    titles.append(el("h3", { text: source.title }));
    titles.append(el("p", { class: "muted", text: `${source.site || host(source.url)} · fetched ${formatDateTime(source.fetchedAt)}` }));
    head.append(titles);
    const link = el("a", {
      class: "button button-ghost button-small",
      href: source.url,
      target: "_blank",
      rel: "noopener noreferrer",
    });
    link.append(icon("external", 14), document.createTextNode("Open original"));
    head.append(link);
    modal.body.append(head);

    const content = el("div", { class: "markdown source-content" });
    setMarkdown(content, source.content || source.text || "(empty page)");
    modal.body.append(content);
  } catch (err) {
    clear(modal.body);
    modal.body.append(el("p", { class: "error-text", text: (err as Error).message }));
  }
}

// ---------------------------------------------------------------------------
// Research dashboard
// ---------------------------------------------------------------------------

async function openDashboard(): Promise<void> {
  const session = state.detail?.session;
  if (!session) {
    showToast("info", "Open a session first.");
    return;
  }

  const modal = openModal({
    title: "Research dashboard",
    subtitle: session.title,
    className: "dashboard-modal",
  });
  const loading = el("div", { class: "loading-state" });
  loading.append(el("span", { class: "spinner" }), el("span", { text: "Loading research jobs…" }));
  modal.body.append(loading);

  let jobs: ResearchJob[];
  try {
    jobs = (await api.researchJobs(session.id)).jobs;
  } catch (err) {
    clear(modal.body);
    modal.body.append(el("p", { class: "error-text", text: (err as Error).message }));
    return;
  }

  clear(modal.body);
  if (jobs.length === 0) {
    modal.body.append(
      el(
        "div",
        { class: "dashboard-empty" },
        el("h3", { text: "No deep research yet" }),
        el("p", {
          class: "muted",
          text: "Switch on Deep research and ask a question. Plans, evidence notes, sources, and reports will appear here.",
        }),
      ),
    );
    return;
  }

  const grid = el("div", { class: "dashboard-grid" });
  const list = el("div", { class: "job-list" });
  const detail = el("div", { class: "job-detail" });
  grid.append(list, detail);
  modal.body.append(grid);

  let selectedID = "";
  const selectJob = async (job: ResearchJob): Promise<void> => {
    selectedID = job.id;
    for (const button of list.querySelectorAll<HTMLElement>("[data-job-id]")) {
      button.classList.toggle("active", button.dataset.jobId === job.id);
    }
    detail.replaceChildren(el("div", { class: "loading-state" }, el("span", { class: "spinner" }), el("span", { text: "Loading job…" })));
    try {
      const payload = await api.researchJob(job.id);
      if (selectedID !== job.id) return;
      renderJobDetail(detail, payload, session.id, () => {
        modal.close();
        void resumeResearch(job.id);
      });
    } catch (err) {
      if (selectedID !== job.id) return;
      detail.replaceChildren(el("p", { class: "error-text", text: (err as Error).message }));
    }
  };

  for (const job of jobs) {
    const button = el("button", { class: "job-item", type: "button", dataset: { jobId: job.id } });
    button.append(el("span", { class: `job-dot job-${job.status}` }));
    button.append(el("span", { class: "job-title", text: job.question }));
    button.append(
      el("span", {
        class: "job-meta",
        text: `${job.depth} · ${formatDateTime(job.createdAt)}`,
      }),
    );
    button.addEventListener("click", () => void selectJob(job));
    list.append(button);
  }

  detail.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-source-id]");
    if (target?.dataset.sourceId) void openSource(session.id, target.dataset.sourceId);
  });

  const first = jobs[0];
  if (first) await selectJob(first);
}

function renderJobDetail(
  root: HTMLElement,
  payload: Awaited<ReturnType<typeof api.researchJob>>,
  sessionID: string,
  onResume?: () => void,
): void {
  const { job, notes, sources } = payload;
  clear(root);

  const head = el("div", { class: "job-head" });
  head.append(el("h3", { text: job.question }));
  const chips = el("div", { class: "job-chips" });
  chips.append(el("span", { class: `status-pill status-${job.status}`, text: job.status }));
  chips.append(el("span", { class: "chip", text: job.depth }));
  chips.append(el("span", { class: "chip", text: formatDateTime(job.createdAt) }));
  chips.append(el("span", { class: "chip", text: `${notes.length} notes` }));
  chips.append(el("span", { class: "chip", text: `${sources.length} sources` }));
  head.append(chips);
  root.append(head);

  if (job.status !== "done" && job.plan && onResume) {
    const actions = el("div", { class: "job-actions" });
    const button = el("button", { class: "button button-small", type: "button" });
    button.append(icon("clock", 14), document.createTextNode("Resume from saved work"));
    button.addEventListener("click", onResume);
    actions.append(button);
    root.append(actions);
  }

  if (job.plan) {
    const plan = el("section", { class: "job-section" });
    plan.append(el("h4", { text: "Plan" }));
    plan.append(el("p", { class: "muted", text: job.plan.restatedQuestion }));
    plan.append(el("p", { class: "muted", text: job.plan.scope }));
    const list = el("ol", { class: "subquestion-list" });
    for (const question of job.plan.subQuestions) {
      list.append(el("li", { text: question.question }));
    }
    plan.append(list);
    root.append(plan);
  }

  if (notes.length > 0) {
    const section = el("section", { class: "job-section" });
    section.append(el("h4", { text: "Evidence notes" }));
    const list = el("div", { class: "note-list" });
    for (const note of notes.slice(0, 40)) {
      const row = el("div", { class: "note-row" });
      const text = el("div", { class: "note-text" });
      text.append(el("span", { class: "note-claim", text: note.claim }));
      if (note.quote) text.append(el("blockquote", { text: note.quote }));
      row.append(text);
      const chip = el("button", {
        class: "source-chip source-chip-tiny",
        type: "button",
        dataset: { sourceId: note.sourceID },
        title: note.sourceTitle,
      });
      chip.append(el("span", { class: "source-id", text: note.sourceID.toUpperCase() }));
      chip.append(el("span", { class: "confidence", text: note.confidence }));
      row.append(chip);
      list.append(row);
    }
    section.append(list);
    if (notes.length > 40) section.append(el("p", { class: "muted", text: `Showing 40 of ${notes.length} notes.` }));
    root.append(section);
  }

  if (sources.length > 0) {
    const section = el("section", { class: "job-section" });
    section.append(el("h4", { text: "Sources" }));
    const chips = el("div", { class: "source-chips" });
    for (const source of sources) chips.append(sourceChip(source));
    section.append(chips);
    root.append(section);
  }

  if (job.report) {
    const section = el("section", { class: "job-section" });
    section.append(el("h4", { text: "Report" }));
    const details = el("details", { class: "research-report", open: true });
    details.append(el("summary", { text: `${formatNumber(job.report.length)} chars` }));
    const markdown = el("div", { class: "markdown report-body" });
    setMarkdown(markdown, job.report);
    details.append(markdown);
    section.append(details);
    root.append(section);
  }

  if (job.error) root.append(el("p", { class: "error-text", text: job.error }));

  if (job.outputPath) {
    const pathRow = el("div", { class: "job-path" });
    pathRow.append(icon("doc", 14), el("code", { text: job.outputPath }));
    const copy = el("button", { class: "button button-ghost button-small", type: "button", text: "Copy path" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(job.outputPath!);
        copy.textContent = "Copied";
        setTimeout(() => {
          copy.textContent = "Copy path";
        }, 1_500);
      } catch {
        showToast("error", "Clipboard is unavailable.");
      }
    });
    pathRow.append(copy);
    root.append(pathRow);
  }
}

// ---------------------------------------------------------------------------
// Events, polling, and utilities
// ---------------------------------------------------------------------------

function bindEvents(): void {
  els.newSession.addEventListener("click", () => void createSession());
  els.sendButton.addEventListener("click", () => void sendPrompt());
  els.stopButton.addEventListener("click", () => void stopRun());
  els.modelButton.addEventListener("click", () => openModelPickerModal());
  els.providerSummary.addEventListener("click", () => openProvidersModal());
  els.researchMode.addEventListener("change", () => void changeMode());
  els.dashboardButton.addEventListener("click", () => void openDashboard());
  els.themeToggle.addEventListener("click", toggleTheme);
  els.sessionTitle.addEventListener("dblclick", () => void renameSession());

  els.toggleSidebar.addEventListener("click", () => {
    if (window.innerWidth <= 900) document.body.classList.toggle("sidebar-open");
    else els.app.classList.toggle("sidebar-collapsed");
  });

  els.composerInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendPrompt();
    }
  });
  els.composerInput.addEventListener("input", resizeComposer);

  els.sessionList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const remove = target.closest<HTMLElement>("[data-delete-session]");
    if (remove?.dataset.deleteSession) {
      event.stopPropagation();
      void deleteSession(remove.dataset.deleteSession);
      return;
    }
    const item = target.closest<HTMLElement>("[data-session-id]");
    if (item?.dataset.sessionId) void loadSession(item.dataset.sessionId);
  });

  els.sessionList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-session-id]");
    if (item?.dataset.sessionId) {
      event.preventDefault();
      void loadSession(item.dataset.sessionId);
    }
  });

  els.chat.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const citation = target.closest<HTMLElement>("[data-citation]");
    if (citation?.dataset.citation && state.detail) {
      void openSource(state.detail.session.id, citation.dataset.citation);
      return;
    }
    const source = target.closest<HTMLElement>("[data-source-id]");
    if (source?.dataset.sourceId && state.detail) {
      void openSource(state.detail.session.id, source.dataset.sourceId);
      return;
    }
    const answer = target.closest<HTMLElement>("[data-answer-question]");
    if (answer?.dataset.answerQuestion) {
      const part = findQuestionPart(answer.dataset.answerQuestion);
      if (part && state.detail) showQuestion(part, state.detail.session.id);
      return;
    }
    const resume = target.closest<HTMLElement>("[data-resume-job]");
    if (resume?.dataset.resumeJob) {
      void resumeResearch(resume.dataset.resumeJob);
      return;
    }
    const suggestion = target.closest<HTMLElement>("[data-prompt]");
    if (suggestion?.dataset.prompt) {
      els.composerInput.value = suggestion.dataset.prompt;
      resizeComposer();
      els.composerInput.focus();
      return;
    }
    const providers = target.closest<HTMLElement>("[data-open-providers]");
    if (providers) {
      openProvidersModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      void createSession();
    }
  });
}

function findQuestionPart(questionID: string): QuestionPartData | null {
  if (!state.detail) return null;
  for (const entry of state.detail.messages) {
    for (const part of entry.parts) {
      if (part.type === "question" && part.data.questionID === questionID) return part.data;
    }
  }
  return null;
}

function startPolling(): void {
  if (pollTimer) return;
  const id = state.detail?.session.id;
  if (!id) return;
  pollTimer = window.setInterval(() => {
    if (state.connected || !state.detail || state.detail.session.id !== id) {
      stopPolling();
      return;
    }
    void (async () => {
      try {
        const detail = await api.session(id);
        state.detail = detail;
        state.running = Boolean(detail.running);
        state.status = state.running ? "streaming" : "idle";
        renderAll();
        if (!state.running) stopPolling();
      } catch {
        stopPolling();
      }
    })();
  }, 1_600);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function resizeComposer(): void {
  els.composerInput.style.height = "auto";
  els.composerInput.style.height = `${Math.min(els.composerInput.scrollHeight, 220)}px`;
}

function scrollToBottom(): void {
  els.chat.scrollTop = els.chat.scrollHeight;
}

function isNearBottom(): boolean {
  return els.chat.scrollHeight - els.chat.scrollTop - els.chat.clientHeight < 180;
}

function closeMobileSidebar(): void {
  if (window.innerWidth <= 900) document.body.classList.remove("sidebar-open");
}

function applyTheme(): void {
  const stored = localStorage.getItem("wandey.theme");
  const theme = stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  document.documentElement.dataset.theme = theme;
  els.themeToggle.replaceChildren(icon(theme === "dark" ? "sun" : "moon", 17));
  els.themeToggle.title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
}

function toggleTheme(): void {
  const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("wandey.theme", next);
  els.themeToggle.replaceChildren(icon(next === "dark" ? "sun" : "moon", 17));
  els.themeToggle.title = next === "dark" ? "Switch to light theme" : "Switch to dark theme";
}

function shortModel(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1] ?? ref;
}

function providerHue(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) % 360;
  return String(hash);
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
