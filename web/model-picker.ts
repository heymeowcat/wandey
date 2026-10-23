import type { ModelInfo } from "../src/core/types.ts";
import type { ProviderInfo } from "./api.ts";
import { clear, el, openModal, showToast, type ModalHandle } from "./components.ts";
import { icon } from "./icons.ts";

/**
 * The model picker.
 *
 * A native <select> stops working once a provider returns hundreds of models.
 * This dialog adds search, quick filters, provider grouping, and keyboard
 * navigation while staying a plain DOM component.
 */

type ModelFilter = "all" | "free" | "local" | "tools";

export interface ModelPickerOptions {
  models: ModelInfo[];
  providers: ProviderInfo[];
  selected: string;
  running: boolean;
  onSelect: (ref: string) => void;
  onManageProviders: () => void;
  onRefresh: () => Promise<{ models: ModelInfo[]; providers: ProviderInfo[] }>;
}

export function openModelPicker(options: ModelPickerOptions): ModalHandle {
  let models = [...options.models];
  let providers = [...options.providers];
  let selected = options.selected;
  let query = "";
  let filter: ModelFilter = "all";
  let refreshing = false;
  let focusAfterRender: string | null = null;

  const modal = openModal({
    title: "Choose a model",
    subtitle: "Search across every provider connected to Wandey.",
    className: "model-picker-modal",
  });

  const providerByID = (): Map<string, ProviderInfo> => new Map(providers.map((provider) => [provider.id, provider]));
  const hasModel = (ref: string): boolean => models.some((model) => model.ref === ref);

  const toolbar = el("div", { class: "picker-toolbar" });
  const searchWrap = el("label", { class: "picker-search" });
  searchWrap.append(icon("search", 16));
  const search = el("input", {
    type: "search",
    placeholder: "Search models or providers",
    "aria-label": "Search models",
    autocomplete: "off",
    spellcheck: "false",
  });
  const clearSearch = el("button", {
    class: "picker-search-clear",
    type: "button",
    title: "Clear search",
    "aria-label": "Clear search",
    hidden: true,
  });
  clearSearch.append(icon("close", 14));
  searchWrap.append(search, clearSearch);
  const refreshButton = el("button", {
    class: "button button-ghost picker-refresh",
    type: "button",
    title: "Ask every provider for its current model list",
  });
  refreshButton.append(icon("refresh", 14), el("span", { text: "Refresh" }));
  toolbar.append(searchWrap, refreshButton);

  const filters = el("div", { class: "picker-filters", role: "group", "aria-label": "Filter models" });
  const resultCount = el("span", { class: "picker-result-count", "aria-live": "polite" });
  const filterBar = el("div", { class: "picker-filter-row" });
  filterBar.append(filters, resultCount);

  const list = el("div", { class: "picker-list", role: "listbox", "aria-label": "Models" });
  const status = el("div", { class: "picker-status", role: "alert", hidden: true });

  const footer = el("footer", { class: "picker-footer" });
  const footerInfo = el("div", { class: "picker-footer-info" });
  const manage = el("button", { class: "button button-ghost button-small", type: "button" });
  manage.append(icon("sliders", 14), document.createTextNode("Manage providers"));
  footer.append(footerInfo, manage);

  modal.body.append(toolbar, filterBar, status, list, footer);

  const filterLabels: Array<{ id: ModelFilter; label: string; count: number }> = [
    { id: "all", label: "All", count: models.length },
    { id: "free", label: "Free", count: models.filter((model) => model.free).length },
    {
      id: "local",
      label: "Local",
      count: models.filter((model) => providerByID().get(model.provider)?.local).length,
    },
    { id: "tools", label: "Tool use", count: models.filter((model) => model.supportsTools !== false).length },
  ];

  function renderFilters(): void {
    clear(filters);
    for (const entry of filterLabels) {
      const button = el("button", {
        class: `picker-filter${filter === entry.id ? " active" : ""}`,
        type: "button",
        "aria-pressed": filter === entry.id,
        dataset: { filter: entry.id },
      });
      button.append(el("span", { text: entry.label }), el("span", { class: "filter-count", text: String(entry.count) }));
      button.addEventListener("click", () => {
        filter = entry.id;
        focusAfterRender = `.picker-filter[data-filter="${entry.id}"]`;
        render();
      });
      filters.append(button);
    }
  }

  function matches(model: ModelInfo): boolean {
    const provider = providerByID().get(model.provider);
    if (filter === "free" && !model.free) return false;
    if (filter === "local" && !provider?.local) return false;
    if (filter === "tools" && model.supportsTools === false) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [model.name, model.id, model.ref, provider?.name ?? "", provider?.id ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  }

  function renderEmpty(): void {
    const empty = el("div", { class: "picker-empty" });
    const mark = el("div", { class: "picker-empty-mark" });
    mark.append(icon("key", 24));
    empty.append(mark);
    empty.append(el("h3", { text: models.length === 0 ? "No models yet" : "No models match" }));
    empty.append(
      el("p", {
        text:
          models.length === 0
            ? "Connect a provider, or start a local server such as Ollama or LM Studio. Wandey will discover its models automatically."
            : "Try a different search, or switch back to All models.",
      }),
    );
    const actions = el("div", { class: "picker-empty-actions" });
    if (models.length === 0) {
      const connect = el("button", { class: "button button-primary", type: "button" });
      connect.append(icon("plus", 14), document.createTextNode("Connect a provider"));
      connect.addEventListener("click", () => {
        modal.close();
        options.onManageProviders();
      });
      actions.append(connect);
      const retry = el("button", { class: "button button-ghost", type: "button" });
      retry.append(icon("refresh", 14), document.createTextNode("Check again"));
      retry.addEventListener("click", () => void refresh());
      actions.append(retry);
    } else {
      const reset = el("button", { class: "button", type: "button", text: "Clear search and filters" });
      reset.addEventListener("click", () => {
        query = "";
        filter = "all";
        search.value = "";
        clearSearch.hidden = true;
        focusAfterRender = 'input[type="search"]';
        render();
      });
      actions.append(reset);
    }
    empty.append(actions);
    list.append(empty);
  }

  function renderList(): void {
    clear(list);
    if (models.length === 0) {
      renderEmpty();
      return;
    }

    const visible = models.filter(matches);
    resultCount.textContent = query.trim() || filter !== "all"
      ? `${visible.length} of ${models.length} models`
      : `${models.length} models`;

    if (visible.length === 0) {
      renderEmpty();
      return;
    }

    const groups = new Map<string, ModelInfo[]>();
    for (const model of visible) {
      const group = groups.get(model.provider) ?? [];
      group.push(model);
      groups.set(model.provider, group);
    }

    const providerMap = providerByID();
    for (const [providerID, group] of groups) {
      const provider = providerMap.get(providerID);
      const section = el("section", { class: "picker-group" });
      const head = el("div", { class: "picker-group-head" });
      const mark = el("span", {
        class: "provider-mark",
        "aria-hidden": "true",
      });
      mark.style.setProperty("--provider-hue", providerHue(providerID));
      mark.textContent = (provider?.name ?? providerID).slice(0, 1).toUpperCase();
      const titles = el("div", { class: "picker-group-titles" });
      titles.append(el("h3", { text: provider?.name ?? providerID }));
      const bits: string[] = [`${group.length} model${group.length === 1 ? "" : "s"}`];
      if (provider?.local) bits.push("local");
      if (provider?.source === "opencode") bits.push("OpenCode");
      if (provider?.source === "env") bits.push("environment");
      if (provider?.error) bits.push("last check failed");
      titles.append(el("p", { text: bits.join(" · ") }));
      head.append(mark, titles);
      if (provider?.error) {
        const warn = el("span", { class: "picker-group-warning", title: provider.error });
        warn.append(icon("alert", 14));
        head.append(warn);
      }
      section.append(head);

      const rows = el("div", { class: "picker-group-rows" });
      for (const model of group) rows.append(modelRow(model, provider));
      section.append(rows);
      list.append(section);
    }
  }

  function modelRow(model: ModelInfo, provider?: ProviderInfo): HTMLButtonElement {
    const current = model.ref === selected;
    const row = el("button", {
      class: `model-option${current ? " selected" : ""}`,
      type: "button",
      role: "option",
      "aria-selected": current,
      dataset: { modelRef: model.ref },
      disabled: options.running,
      title: model.ref,
    });

    const body = el("span", { class: "model-option-body" });
    const line = el("span", { class: "model-option-line" });
    line.append(el("span", { class: "model-option-name", text: model.name }));
    if (model.free) line.append(el("span", { class: "model-badge badge-free", text: "Free" }));
    if (provider?.local) line.append(el("span", { class: "model-badge badge-local", text: "Local" }));
    if (model.supportsTools === false) line.append(el("span", { class: "model-badge badge-warn", text: "No tools" }));
    body.append(line);

    const meta = el("span", { class: "model-option-meta" });
    meta.append(el("span", { class: "model-option-ref", text: model.ref }));
    if (model.contextWindow) meta.append(el("span", { text: `${compact(model.contextWindow)} context` }));
    if (model.supportsReasoning) meta.append(el("span", { text: "reasoning" }));
    if (model.supportsVision) meta.append(el("span", { text: "vision" }));
    body.append(meta);
    row.append(body);

    const check = el("span", { class: "model-option-check", "aria-hidden": "true" });
    check.append(icon(current ? "check" : "chevron", current ? 16 : 14));
    row.append(check);

    row.addEventListener("click", () => {
      if (options.running) return;
      selected = model.ref;
      options.onSelect(model.ref);
      modal.close();
    });
    return row;
  }

  function renderFooter(): void {
    clear(footerInfo);
    const model = models.find((entry) => entry.ref === selected);
    const dot = el("span", { class: `footer-dot${model ? " ready" : ""}` });
    footerInfo.append(dot);
    if (model) {
      const copy = el("div", { class: "footer-copy" });
      copy.append(el("span", { class: "footer-title", text: model.name }));
      copy.append(el("span", { class: "footer-sub", text: `${model.provider}${model.free ? " · free" : ""}` }));
      footerInfo.append(copy);
    } else {
      const copy = el("div", { class: "footer-copy" });
      copy.append(el("span", { class: "footer-title", text: selected ? shortModel(selected) : "No model selected" }));
      copy.append(
        el("span", {
          class: "footer-sub warn",
          text: selected ? "Not currently available. Pick another model." : "Connect a provider to get started.",
        }),
      );
      footerInfo.append(copy);
    }
  }

  function render(): void {
    renderFilters();
    renderList();
    renderFooter();
    clearSearch.hidden = query.length === 0;
    if (focusAfterRender) {
      const selector = focusAfterRender;
      focusAfterRender = null;
      queueMicrotask(() => modal.focus(selector));
    }
  }

  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    refreshButton.disabled = true;
    refreshButton.classList.add("spinning");
    status.hidden = true;
    try {
      const data = await options.onRefresh();
      models = data.models;
      providers = data.providers;
      filterLabels[0]!.count = models.length;
      filterLabels[1]!.count = models.filter((model) => model.free).length;
      filterLabels[2]!.count = models.filter((model) => providerByID().get(model.provider)?.local).length;
      filterLabels[3]!.count = models.filter((model) => model.supportsTools !== false).length;
      render();
      showToast("success", models.length > 0 ? `Model list refreshed · ${models.length} models` : "No models found yet.");
    } catch (err) {
      status.hidden = false;
      clear(status);
      status.append(icon("alert", 15), el("span", { text: `Could not refresh: ${(err as Error).message}` }));
    } finally {
      refreshing = false;
      refreshButton.disabled = false;
      refreshButton.classList.remove("spinning");
    }
  }

  search.addEventListener("input", () => {
    query = search.value;
    render();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      const first = list.querySelector<HTMLButtonElement>(".model-option:not(:disabled)");
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  clearSearch.addEventListener("click", () => {
    query = "";
    search.value = "";
    render();
    search.focus();
  });

  list.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [...list.querySelectorAll<HTMLButtonElement>(".model-option:not(:disabled)")];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (rows.length === 0) return;
    event.preventDefault();
    let next = index;
    if (event.key === "ArrowDown") next = index < 0 ? 0 : Math.min(rows.length - 1, index + 1);
    if (event.key === "ArrowUp") next = index < 0 ? rows.length - 1 : Math.max(0, index - 1);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = rows.length - 1;
    rows[next]?.focus();
  });

  refreshButton.addEventListener("click", () => void refresh());
  manage.addEventListener("click", () => {
    modal.close();
    options.onManageProviders();
  });

  render();
  if (options.running) {
    status.hidden = false;
    status.className = "picker-status picker-notice";
    status.append(icon("clock", 15), el("span", { text: "Wait for the current run to finish before switching models." }));
  }

  return modal;
}

function providerHue(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) % 360;
  return String(hash);
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function shortModel(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1] ?? ref;
}
