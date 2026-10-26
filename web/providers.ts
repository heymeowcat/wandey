import type { ProviderCatalogEntry, ProviderInfo, ProvidersResponse, ProviderUpsert } from "./api.ts";
import { api } from "./api.ts";
import { clear, el, openModal, showToast, type ModalHandle } from "./components.ts";
import { icon } from "./icons.ts";

/**
 * Provider connections.
 *
 * The list answers three questions at a glance: what is ready, what needs
 * attention, and what can I add? Connecting is an inline form so credentials
 * never appear in the list and failures stay next to the field that caused
 * them.
 */

export interface ProviderModalOptions {
  onChange: () => Promise<void>;
}

type View =
  | { kind: "list" }
  | { kind: "form"; entry?: ProviderCatalogEntry; custom?: boolean }
  | { kind: "confirm"; entry: ProviderCatalogEntry };

export function openProviderModal(options: ProviderModalOptions): ModalHandle {
  const modal = openModal({
    title: "Providers",
    subtitle: "Connect the accounts and local servers that supply Wandey's models.",
    className: "providers-modal",
  });

  let snapshot: ProvidersResponse | null = null;
  let view: View = { kind: "list" };
  let formError = "";
  let draft: { name: string; baseUrl: string; kind: string; apiKey: string; models: string } | null = null;
  let loading = true;
  let loadError = "";
  let refreshing = false;
  let busy = false;
  let focusAfterRender: string | null = null;

  void load();

  async function load(): Promise<void> {
    loading = true;
    loadError = "";
    render();
    try {
      snapshot = await api.providers();
      loading = false;
      focusAfterRender = ".provider-card .button, .provider-custom";
      render();
    } catch (err) {
      loading = false;
      loadError = (err as Error).message;
      render();
    }
  }

  function render(): void {
    clear(modal.body);
    if (loading) {
      const state = el("div", { class: "loading-state" });
      state.append(el("span", { class: "spinner" }), el("span", { text: "Checking providers…" }));
      modal.body.append(state);
      return;
    }
    if (loadError) {
      const state = el("div", { class: "provider-load-error" });
      state.append(icon("alert", 18));
      state.append(el("h3", { text: "Could not check providers" }));
      state.append(el("p", { text: loadError }));
      const retry = el("button", { class: "button", type: "button" });
      retry.append(icon("refresh", 14), document.createTextNode("Try again"));
      retry.addEventListener("click", () => void load());
      state.append(retry);
      modal.body.append(state);
      return;
    }
    if (!snapshot) return;

    if (view.kind === "form") renderForm(view.entry, Boolean(view.custom));
    else if (view.kind === "confirm") renderConfirm(view.entry);
    else renderList();

    if (focusAfterRender) {
      const selector = focusAfterRender;
      focusAfterRender = null;
      queueMicrotask(() => modal.focus(selector));
    }
  }

  function renderList(): void {
    if (!snapshot) return;
    const catalog = snapshot.catalog;
    const opencodeLocalStatus = snapshot.providers.find((entry) => entry.id === "opencode-local");
    const opencodeLocalReady =
      snapshot.opencodeLocal && (opencodeLocalStatus?.modelCount ?? 0) > 0;
    const connected = catalog.filter((entry) => entry.connected);
    const disconnected = catalog.filter((entry) => entry.disabled);
    // Auto-discovered local servers are simply not running yet; that is not a
    // configuration problem. Explicitly configured providers still are.
    const attention = catalog.filter(
      (entry) => entry.configured && !entry.connected && !entry.disabled && entry.auto !== "local",
    );
    const available = catalog.filter(
      (entry) => !entry.disabled && (!entry.configured || (entry.auto === "local" && !entry.connected)),
    );
    const localAvailable = available.filter((entry) => entry.local);
    const cloudAvailable = available.filter((entry) => !entry.local);
    const readyCount = connected.length + (opencodeLocalReady ? 1 : 0);
    const modelCount =
      connected.reduce((sum, entry) => sum + entry.modelCount, 0) +
      (opencodeLocalReady ? (opencodeLocalStatus?.modelCount ?? 0) : 0);

    const root = el("div", { class: "providers-view" });
    const summary = el("div", { class: "providers-summary" });
    const summaryCopy = el("div", { class: "providers-summary-copy" });
    summaryCopy.append(
      el("strong", { text: readyCount === 0 ? "No providers ready" : `${readyCount} provider${readyCount === 1 ? "" : "s"} ready` }),
    );
    summaryCopy.append(
      el("span", {
        text:
          readyCount === 0
            ? "Connect a cloud API or start a local model server to begin."
            : `${modelCount} models available across your connections.`,
      }),
    );
    summary.append(summaryCopy);
    const refresh = el("button", {
      class: "button button-ghost button-small provider-refresh",
      type: "button",
      disabled: refreshing,
    });
    refresh.append(icon("refresh", 14), document.createTextNode(refreshing ? "Checking…" : "Refresh all"));
    if (refreshing) refresh.classList.add("spinning");
    refresh.addEventListener("click", () => void refreshAll());
    summary.append(refresh);
    root.append(summary);

    if (readyCount === 0 && attention.length === 0 && disconnected.length === 0) {
      const guide = el("div", { class: "provider-guide" });
      const mark = el("div", { class: "provider-guide-mark" });
      mark.append(icon("key", 20));
      guide.append(mark);
      const copy = el("div", {});
      copy.append(el("h3", { text: "Start with one connection" }));
      copy.append(
        el("p", {
          text: "Cloud providers need an API key. Local servers only need to be running. Or enable the OpenCode local runtime for free models.",
        }),
      );
      guide.append(copy);
      root.append(guide);
    }

    if (connected.length > 0) {
      root.append(section("Connected", "These providers are returning models right now."));
      const grid = el("div", { class: "provider-grid" });
      for (const entry of connected) grid.append(providerCard(entry));
      root.append(grid);
    }

    if (attention.length > 0) {
      root.append(section("Needs attention", "Configured, but no models are available yet."));
      const grid = el("div", { class: "provider-grid" });
      for (const entry of attention) grid.append(providerCard(entry));
      root.append(grid);
    }

    if (disconnected.length > 0) {
      root.append(section("Disconnected", "Stored connections that are hidden from the model picker."));
      const grid = el("div", { class: "provider-grid" });
      for (const entry of disconnected) grid.append(providerCard(entry));
      root.append(grid);
    }

    if (localAvailable.length > 0) {
      root.append(section("Local servers", "Already running one? Connect it without an API key."));
      const grid = el("div", { class: "provider-grid" });
      for (const entry of localAvailable) grid.append(providerCard(entry));
      root.append(grid);
    }

    root.append(section("Local runtime", "Optional integrations that run through software already on this machine."));
    const runtimeGrid = el("div", { class: "provider-grid" });
    runtimeGrid.append(opencodeLocalCard(opencodeLocalStatus));
    root.append(runtimeGrid);

    if (cloudAvailable.length > 0) {
      root.append(section("Cloud providers", "Bring a key from the provider. It stays on this machine."));
      const grid = el("div", { class: "provider-grid" });
      for (const entry of cloudAvailable) grid.append(providerCard(entry));
      root.append(grid);
    }

    const custom = el("button", { class: "provider-custom", type: "button" });
    const customMark = el("span", { class: "provider-custom-mark" });
    customMark.append(icon("plus", 16));
    const customCopy = el("span", { class: "provider-custom-copy" });
    customCopy.append(el("strong", { text: "Add a custom endpoint" }));
    customCopy.append(el("span", { text: "Any OpenAI-compatible, Anthropic, or Gemini API." }));
    custom.append(customMark, customCopy, icon("chevron", 15));
    custom.addEventListener("click", () => openForm(undefined, true));
    root.append(custom);

    modal.body.append(root);
  }

  function section(title: string, subtitle: string): HTMLElement {
    const head = el("div", { class: "providers-section-head" });
    head.append(el("h3", { text: title }), el("p", { text: subtitle }));
    return head;
  }

  function providerCard(entry: ProviderCatalogEntry): HTMLElement {
    const card = el("article", {
      class: `provider-card${entry.connected ? " provider-ready" : entry.disabled ? " provider-disconnected" : entry.configured ? " provider-attention" : ""}`,
    });

    const top = el("div", { class: "provider-card-top" });
    const mark = el("span", { class: "provider-mark provider-mark-large", "aria-hidden": "true" });
    mark.style.setProperty("--provider-hue", providerHue(entry.id));
    mark.textContent = entry.name.slice(0, 1).toUpperCase();
    top.append(mark);

    const titles = el("div", { class: "provider-card-titles" });
    const titleRow = el("div", { class: "provider-title-row" });
    titleRow.append(el("h3", { text: entry.name }));
    for (const badge of providerBadges(entry)) titleRow.append(el("span", { class: `provider-badge ${badge.class}`, text: badge.label }));
    titles.append(titleRow);
    titles.append(el("p", { class: "provider-description", text: entry.description }));
    top.append(titles);

    const action = el("button", {
      class: `button button-small${entry.connected ? " button-ghost" : " button-primary"}`,
      type: "button",
      text: entry.connected ? "Manage" : entry.disabled ? "Reconnect" : entry.configured ? "Review" : "Connect",
    });
    action.addEventListener("click", () => openForm(entry));
    top.append(action);
    card.append(top);

    const meta = el("div", { class: "provider-card-meta" });
    if (entry.connected) meta.append(el("span", { class: "provider-count", text: `${entry.modelCount} model${entry.modelCount === 1 ? "" : "s"}` }));
    if (entry.baseUrl) meta.append(el("code", { class: "provider-url", text: shortURL(entry.baseUrl), title: entry.baseUrl }));
    const source = sourceLabel(entry);
    if (source) meta.append(el("span", { text: source }));
    card.append(meta);

    if (entry.error) {
      const error = el("div", { class: "provider-error" });
      error.append(icon("alert", 14), el("span", { text: friendlyError(entry) }));
      card.append(error);
    }

    return card;
  }

  function providerBadges(entry: ProviderCatalogEntry): Array<{ label: string; class: string }> {
    const badges: Array<{ label: string; class: string }> = [];
    if (entry.disabled) badges.push({ label: "Disconnected", class: "badge-soft" });
    if (entry.local) badges.push({ label: "Local", class: "badge-local" });
    if (entry.source === "env") badges.push({ label: "Environment", class: "badge-soft" });
    if (entry.source === "opencode") badges.push({ label: "OpenCode", class: "badge-soft" });
    if (entry.source === "opencode-local") badges.push({ label: "OpenCode local", class: "badge-soft" });
    if (entry.auto === "local" && !entry.connected) badges.push({ label: "Not running", class: "badge-soft" });
    return badges;
  }

  function opencodeLocalCard(status?: ProviderInfo): HTMLElement {
    if (!snapshot) return el("div", {});
    const enabled = snapshot.opencodeLocal;
    const ready = enabled && (status?.modelCount ?? 0) > 0;
    const card = el("article", {
      class: `provider-card${ready ? " provider-ready" : enabled ? " provider-attention" : ""}`,
    });

    const top = el("div", { class: "provider-card-top" });
    const mark = el("span", { class: "provider-mark provider-mark-large", "aria-hidden": "true" });
    mark.style.setProperty("--provider-hue", providerHue("opencode-local"));
    mark.textContent = "O";
    top.append(mark);

    const titles = el("div", { class: "provider-card-titles" });
    const titleRow = el("div", { class: "provider-title-row" });
    titleRow.append(el("h3", { text: "OpenCode local" }));
    titleRow.append(el("span", { class: "provider-badge badge-local", text: "Local" }));
    titleRow.append(el("span", { class: "provider-badge badge-soft", text: "Free models" }));
    titleRow.append(el("span", { class: "provider-badge badge-soft", text: "Text only" }));
    titles.append(titleRow);
    titles.append(
      el("p", {
        class: "provider-description",
        text: enabled
          ? "Free models through the OpenCode CLI. Isolated from your project and text-only."
          : "Use OpenCode's free models through the local CLI. Opt-in, isolated, and text-only.",
      }),
    );
    top.append(titles);

    const action = el("button", {
      class: `button button-small provider-integration-toggle${enabled ? " button-ghost" : " button-primary"}`,
      type: "button",
      disabled: busy,
      text: busy ? "Updating…" : enabled ? "Disable" : "Enable",
    });
    action.addEventListener("click", () => void toggleOpenCodeLocal(!enabled));
    top.append(action);
    card.append(top);

    const meta = el("div", { class: "provider-card-meta" });
    if (enabled) {
      const count = status?.modelCount ?? 0;
      meta.append(el("span", { class: "provider-count", text: `${count} model${count === 1 ? "" : "s"}` }));
    }
    meta.append(el("span", { text: enabled ? "local runtime" : "opt-in" }));
    card.append(meta);

    if (status?.error) {
      const error = el("div", { class: "provider-error" });
      const message = status.error.length > 240 ? `${status.error.slice(0, 240)}…` : status.error;
      error.append(icon("alert", 14), el("span", { text: message }));
      card.append(error);
    }

    return card;
  }

  async function toggleOpenCodeLocal(enabled: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    try {
      const result = await api.setOpenCodeLocal(enabled);
      if (snapshot) {
        snapshot.providers = result.providers;
        snapshot.catalog = result.catalog;
        snapshot.opencodeLocal = result.enabled;
      }
      await options.onChange();
      const status = result.providers.find((entry) => entry.id === "opencode-local");
      const count = status?.modelCount ?? 0;
      if (enabled && count === 0) {
        showToast(
          "info",
          status?.error
            ? `OpenCode local is enabled, but the runtime is not ready: ${status.error}`
            : "OpenCode local is enabled, but no free models are available yet.",
        );
      } else {
        showToast(
          enabled ? "success" : "info",
          enabled ? `OpenCode local enabled · ${count} free model${count === 1 ? "" : "s"}` : "OpenCode local disabled",
        );
      }
      busy = false;
      focusAfterRender = ".provider-integration-toggle";
      render();
    } catch (err) {
      busy = false;
      showToast("error", `Could not update OpenCode local: ${(err as Error).message}`);
      render();
    }
  }

  function openForm(entry?: ProviderCatalogEntry, custom = false): void {
    formError = "";
    draft = {
      name: entry?.name ?? "",
      baseUrl: entry?.baseUrl ?? "",
      kind: entry?.kind === "anthropic" || entry?.kind === "gemini" ? entry.kind : "openai",
      apiKey: "",
      models: entry?.models?.join(", ") ?? "",
    };
    view = { kind: "form", entry, custom: custom || Boolean(entry?.custom) };
    focusAfterRender = 'input[name="name"], input[name="baseUrl"]';
    render();
  }

  function renderForm(entry?: ProviderCatalogEntry, custom = false): void {
    if (!snapshot) return;
    custom = custom || Boolean(entry?.custom);
    if (!draft) {
      draft = {
        name: entry?.name ?? "",
        baseUrl: entry?.baseUrl ?? "",
        kind: entry?.kind ?? "openai",
        apiKey: "",
        models: entry?.models?.join(", ") ?? "",
      };
    }
    const existing = Boolean(entry?.configured);
    const disconnected = Boolean(entry?.disabled);
    const root = el("div", { class: "providers-view provider-form-view" });

    const back = el("button", { class: "provider-back", type: "button" });
    back.append(icon("arrow-left", 15), document.createTextNode("All providers"));
    back.addEventListener("click", () => {
      formError = "";
      draft = null;
      view = { kind: "list" };
      focusAfterRender = ".provider-card .button, .provider-custom";
      render();
    });
    root.append(back);

    const head = el("div", { class: "provider-form-head" });
    const mark = el("span", { class: "provider-mark provider-mark-large", "aria-hidden": "true" });
    mark.style.setProperty("--provider-hue", providerHue(entry?.id ?? "custom"));
    mark.textContent = (entry?.name ?? "C").slice(0, 1).toUpperCase();
    head.append(mark);
    const titles = el("div", {});
    titles.append(
      el("h3", {
        text: custom && !existing ? "Add a custom endpoint" : existing ? `Manage ${entry!.name}` : `Connect ${entry!.name}`,
      }),
    );
    titles.append(
      el("p", {
        text: custom
          ? "Point Wandey at any compatible API, including a proxy or a server on your network."
          : entry!.description,
      }),
    );
    head.append(titles);
    if (entry?.docs) {
      const docs = el("a", {
        class: "button button-ghost button-small",
        href: entry.docs,
        target: "_blank",
        rel: "noopener noreferrer",
      });
      docs.append(document.createTextNode("Get a key"), icon("external", 13));
      head.append(docs);
    }
    root.append(head);

    if (formError) {
      const alert = el("div", { class: "provider-alert alert-error", role: "alert", tabindex: "-1" });
      alert.append(icon("alert", 16), el("span", { text: formError }));
      root.append(alert);
    } else if (entry?.error) {
      const alert = el("div", { class: "provider-alert alert-warning", role: "status", tabindex: "-1" });
      alert.append(icon("alert", 16), el("span", { text: friendlyError(entry) }));
      root.append(alert);
    }

    const form = el("form", { class: "provider-form" });

    let nameInput: HTMLInputElement | null = null;
    if (custom) {
      const field = el("label", { class: "provider-field" });
      field.append(el("span", { class: "provider-field-label", text: "Display name" }));
      nameInput = el("input", {
        type: "text",
        name: "name",
        placeholder: "My endpoint",
        value: draft.name,
        required: true,
        autocomplete: "off",
      });
      nameInput.addEventListener("input", () => {
        if (draft) draft.name = nameInput!.value;
      });
      field.append(nameInput);
      field.append(el("span", { class: "provider-field-hint", text: "A short name shown in the model picker." }));
      form.append(field);
    }

    let kindSelect: HTMLSelectElement | null = null;
    if (custom) {
      const field = el("label", { class: "provider-field" });
      field.append(el("span", { class: "provider-field-label", text: "API format" }));
      kindSelect = el("select", { name: "kind" }) as HTMLSelectElement;
      for (const [value, label] of [
        ["openai", "OpenAI-compatible"],
        ["anthropic", "Anthropic Messages"],
        ["gemini", "Google Gemini"],
      ] as const) {
        kindSelect.append(el("option", { value, text: label }));
      }
      kindSelect.value = draft.kind;
      kindSelect.addEventListener("change", () => {
        if (draft) draft.kind = kindSelect!.value;
      });
      field.append(kindSelect);
      form.append(field);
    }

    const baseField = el("label", { class: "provider-field" });
    baseField.append(el("span", { class: "provider-field-label", text: "Base URL" }));
    const baseInput = el("input", {
      type: "url",
      name: "baseUrl",
      placeholder: "https://api.example.com/v1",
      value: draft.baseUrl,
      required: true,
      spellcheck: "false",
      autocomplete: "off",
    });
    baseInput.addEventListener("input", () => {
      if (draft) draft.baseUrl = baseInput.value;
    });
    baseField.append(baseInput);
    if (!custom) {
      baseField.append(
        el("span", {
          class: "provider-field-hint",
          text: entry?.local ? "Start the server, then connect. No API key is needed." : "Usually no change is needed.",
        }),
      );
    }
    form.append(baseField);

    let keyInput: HTMLInputElement | null = null;
    const needsKey = custom || !entry?.local;
    if (needsKey) {
      const keyField = el("label", { class: "provider-field" });
      keyField.append(
        el("span", {
          class: "provider-field-label",
          text: custom ? "API key (if required)" : "API key",
        }),
      );
      const keyWrap = el("span", { class: "provider-key-wrap" });
      keyInput = el("input", {
        type: "password",
        name: "apiKey",
        value: draft.apiKey,
        placeholder:
          existing && entry?.keyStored
            ? "Leave blank to keep the saved key"
            : custom
              ? "Optional for OpenAI-compatible endpoints"
              : "Paste your API key",
        autocomplete: "off",
        spellcheck: "false",
      });
      keyInput.addEventListener("input", () => {
        if (draft) draft.apiKey = keyInput!.value;
      });
      keyWrap.append(keyInput);
      const reveal = el("button", {
        class: "provider-reveal",
        type: "button",
        title: "Show API key",
        "aria-label": "Show API key",
      });
      reveal.append(icon("eye", 15));
      reveal.addEventListener("click", () => {
        if (!keyInput) return;
        const showing = keyInput.type === "text";
        keyInput.type = showing ? "password" : "text";
        reveal.replaceChildren(icon(showing ? "eye" : "eye-off", 15));
        reveal.title = showing ? "Show API key" : "Hide API key";
        reveal.setAttribute("aria-label", reveal.title);
      });
      keyWrap.append(reveal);
      keyField.append(keyWrap);

      const hint = el("span", { class: "provider-field-hint provider-key-hint" });
      hint.append(icon("lock", 12));
      if (entry?.source === "env" && entry.env[0]) {
        hint.append(document.createTextNode(`Using ${entry.env[0]} from the environment. Leave blank to keep it.`));
      } else if (entry?.source === "opencode") {
        hint.append(document.createTextNode("Using the key imported from OpenCode. Leave blank to keep it."));
      } else if (entry?.keyStored) {
        hint.append(document.createTextNode(`Stored locally in ${snapshot.configFile}. Leave blank to keep it.`));
      } else if (existing) {
        hint.append(
          document.createTextNode(
            `Stored locally in ${snapshot.configFile}. Add a key only if this endpoint requires one.`,
          ),
        );
      } else {
        hint.append(document.createTextNode(`Stored locally in ${snapshot.configFile}. Never sent anywhere else.`));
      }
      keyField.append(hint);
      form.append(keyField);
    } else {
      const note = el("div", { class: "provider-local-note" });
      note.append(icon("server", 16));
      note.append(
        el("span", {
          text: `No key needed. Start ${entry?.name ?? "the server"} on this machine, then connect.`,
        }),
      );
      form.append(note);
    }

    const advanced = el("details", { class: "provider-advanced", open: custom });
    advanced.append(el("summary", { text: "Advanced" }));
    const extraField = el("label", { class: "provider-field" });
    extraField.append(el("span", { class: "provider-field-label", text: "Extra model IDs (optional)" }));
    const extraInput = el("input", {
      type: "text",
      name: "models",
      placeholder: "model-a, model-b",
      value: draft.models,
      spellcheck: "false",
      autocomplete: "off",
    });
    extraInput.addEventListener("input", () => {
      if (draft) draft.models = extraInput.value;
    });
    extraField.append(extraInput);
    extraField.append(
      el("span", {
        class: "provider-field-hint",
        text: "Use this when the endpoint has no model list, or to pin models you want to keep visible.",
      }),
    );
    advanced.append(extraField);
    form.append(advanced);

    const envHint = entry && !entry.local && entry.env.length > 0 && entry.source !== "env";
    if (envHint) {
      const hint = el("p", { class: "provider-env-hint" });
      hint.append(icon("key", 13));
      hint.append(
        el("span", {
          text: `Prefer environment variables? Set ${entry!.env[0]} instead of saving a key here.`,
        }),
      );
      form.append(hint);
    }

    const actions = el("div", { class: "provider-form-actions" });
    if (existing && !disconnected) {
      const remove = el("button", { class: "button button-ghost provider-disconnect", type: "button", text: "Disconnect" });
      remove.addEventListener("click", () => {
        formError = "";
        view = { kind: "confirm", entry: entry! };
        focusAfterRender = ".provider-back";
        render();
      });
      actions.append(remove);
    }
    const actionsRight = el("div", { class: "provider-form-actions-right" });
    const cancel = el("button", { class: "button button-ghost", type: "button", text: "Cancel" });
    cancel.addEventListener("click", () => {
      formError = "";
      draft = null;
      view = { kind: "list" };
      focusAfterRender = ".provider-card .button, .provider-custom";
      render();
    });
    const submit = el("button", {
      class: "button button-primary",
      type: "submit",
      text: disconnected ? "Reconnect" : existing ? "Save & test" : custom ? "Add endpoint" : "Connect",
    });
    actionsRight.append(cancel, submit);
    actions.append(actionsRight);
    form.append(actions);
    root.append(form);
    modal.body.append(root);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy) return;
      const baseUrl = baseInput.value.trim();
      if (!baseUrl) {
        formError = "A base URL is required.";
        focusAfterRender = '[role="alert"]';
        render();
        return;
      }
      if (custom && !nameInput?.value.trim()) {
        formError = "Give this endpoint a display name.";
        focusAfterRender = '[role="alert"]';
        render();
        return;
      }

      const payload: ProviderUpsert = {
        ...(entry ? { id: entry.id } : {}),
        ...(custom ? { name: nameInput!.value.trim() } : {}),
        ...(kindSelect ? { kind: kindSelect.value as ProviderUpsert["kind"] } : {}),
        baseUrl,
        ...(keyInput?.value.trim() ? { apiKey: keyInput.value.trim() } : {}),
        models: extraInput.value
          .split(/[\n,]+/)
          .map((value) => value.trim())
          .filter(Boolean),
      };

      busy = true;
      submit.disabled = true;
      submit.classList.add("loading");
      submit.replaceChildren(el("span", { class: "spinner" }), document.createTextNode("Testing connection…"));
      void (async () => {
        try {
          const result = await api.connectProvider(payload);
          if (snapshot) {
            snapshot.providers = result.providers;
            snapshot.catalog = result.catalog;
          }
          await options.onChange();
          const savedID = result.provider?.id ?? result.id ?? entry?.id;
          const updated = result.catalog.find((item) => item.id === savedID);
          const found = result.provider;
          if (!found || found.modelCount === 0) {
            formError = found?.error
              ? `Saved, but the connection failed: ${updated ? friendlyError(updated) : found.error}`
              : "Saved, but the provider did not return any models. Check the endpoint or add model IDs under Advanced.";
            if (updated) view = { kind: "form", entry: updated, custom: custom || updated.custom };
            focusAfterRender = '[role="alert"]';
            busy = false;
            render();
            return;
          }
          showToast("success", `${found.name} connected · ${found.modelCount} models`);
          formError = "";
          draft = null;
          view = { kind: "list" };
          focusAfterRender = ".provider-card .button, .provider-custom";
          busy = false;
          render();
        } catch (err) {
          formError = (err as Error).message;
          focusAfterRender = '[role="alert"]';
          busy = false;
          render();
        }
      })();
    });
  }

  function renderConfirm(entry: ProviderCatalogEntry): void {
    if (!snapshot) return;
    const root = el("div", { class: "providers-view provider-confirm-view" });
    const back = el("button", { class: "provider-back", type: "button" });
    back.append(icon("arrow-left", 15), document.createTextNode("All providers"));
    back.addEventListener("click", () => {
      formError = "";
      view = { kind: "form", entry, custom: entry.custom };
      focusAfterRender = 'input[name="baseUrl"]';
      render();
    });
    root.append(back);

    const box = el("div", { class: "provider-confirm" });
    const mark = el("div", { class: "provider-confirm-mark" });
    mark.append(icon("alert", 22));
    box.append(mark);
    box.append(el("h3", { text: `Disconnect ${entry.name}?` }));
    box.append(
      el("p", {
        text: "Its models will disappear from the picker. Existing sessions keep their history, but they will need another model before they can continue.",
      }),
    );
    if (entry.source === "env" || entry.source === "opencode" || entry.keyStored) {
      box.append(
        el("p", {
          class: "provider-confirm-note",
          text:
            entry.source === "env"
              ? "This hides the provider in Wandey. Your environment variable is left untouched."
              : entry.source === "opencode"
                ? "This hides the provider in Wandey. Your OpenCode credentials are left untouched."
                : "The API key saved in Wandey will be removed. You can reconnect with a new key later.",
        }),
      );
    }
    if (formError) {
      const alert = el("div", { class: "provider-alert alert-error", role: "alert", tabindex: "-1" });
      alert.append(icon("alert", 16), el("span", { text: formError }));
      box.append(alert);
    }
    const actions = el("div", { class: "provider-confirm-actions" });
    const cancel = el("button", { class: "button button-ghost", type: "button", text: "Keep connected" });
    cancel.addEventListener("click", () => {
      formError = "";
      view = { kind: "list" };
      focusAfterRender = ".provider-card .button, .provider-custom";
      render();
    });
    const confirm = el("button", { class: "button button-danger", type: "button", text: "Disconnect" });
    confirm.disabled = busy;
    confirm.addEventListener("click", () => {
      if (busy) return;
      busy = true;
      confirm.disabled = true;
      confirm.textContent = "Disconnecting…";
      void (async () => {
        try {
          const result = await api.disconnectProvider(entry.id);
          if (snapshot) {
            snapshot.providers = result.providers;
            snapshot.catalog = result.catalog;
          }
          await options.onChange();
          showToast("info", `${entry.name} disconnected`);
          formError = "";
          draft = null;
          busy = false;
          view = { kind: "list" };
          focusAfterRender = ".provider-card .button, .provider-custom";
          render();
        } catch (err) {
          busy = false;
          formError = (err as Error).message;
          focusAfterRender = '[role="alert"]';
          render();
        }
      })();
    });
    actions.append(cancel, confirm);
    box.append(actions);
    root.append(box);
    modal.body.append(root);
  }

  async function refreshAll(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    render();
    try {
      const result = await api.refreshProviders();
      if (snapshot) {
        snapshot.providers = result.providers;
        snapshot.catalog = result.catalog;
      }
      await options.onChange();
      const ready = result.providers.filter((provider) => provider.modelCount > 0).length;
      showToast(
        ready > 0 ? "success" : "info",
        ready > 0 ? `Providers refreshed · ${result.models.length} models ready` : "No models found. Check a connection below.",
      );
    } catch (err) {
      showToast("error", `Could not refresh providers: ${(err as Error).message}`);
    } finally {
      refreshing = false;
      focusAfterRender = ".provider-refresh";
      render();
    }
  }

  return modal;
}

function sourceLabel(entry: ProviderCatalogEntry): string {
  if (entry.disabled) return "disconnected";
  if (entry.custom) return "saved in config";
  switch (entry.source) {
    case "env":
      return "from environment";
    case "opencode":
      return "from OpenCode";
    case "opencode-local":
      return "local runtime";
    case "local":
      return "local discovery";
    case "config":
      if (!entry.configured) return "";
      return entry.keyStored ? "saved in config" : "configured";
    default:
      return "";
  }
}

function friendlyError(entry: ProviderCatalogEntry): string {
  const error = entry.error ?? "";
  if (!error) return "No models were returned. Check the endpoint and try again.";
  if (entry.local && /could not reach|fetch failed|ECONNREFUSED|timed out|timed? ?out/i.test(error)) {
    return `No server answered at ${shortURL(entry.baseUrl ?? "this endpoint")}. Start it, then try again.`;
  }
  if (/\b401\b|\b403\b|unauthor|invalid.*(api )?key|incorrect.*key/i.test(error)) {
    return "The provider rejected this API key. Check it and try again.";
  }
  return error.length > 240 ? `${error.slice(0, 240)}…` : error;
}

function shortURL(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function providerHue(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) % 360;
  return String(hash);
}
