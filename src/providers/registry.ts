import type { ChatRequest, ModelInfo, ProviderAdapter, ProviderEvent } from "../core/types.ts";
import type { Config, ProviderConfig } from "../core/config.ts";
import { getApiKey, resolveProviderConfig } from "../core/config.ts";
import { PROVIDER_TEMPLATES, templateFor } from "./catalog.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { GeminiProvider } from "./gemini.ts";
import { OpenAIProvider } from "./openai.ts";
import { OpenCodeLocalProvider, OPENCODE_LOCAL_PROVIDER_ID } from "./opencode-local.ts";
import { openCodeProviderConfigs } from "../integrations/opencode.ts";
import { parseModelRef } from "../core/util.ts";

export interface ProviderStatus {
  id: string;
  name: string;
  kind: string;
  baseUrl?: string;
  authenticated: boolean;
  local: boolean;
  source: "config" | "env" | "local" | "opencode" | "opencode-local";
  /** Where the provider record came from. Auto-local servers stay available. */
  auto?: "env" | "local" | "opencode";
  modelCount: number;
  /** Curated fallback model ids from config, if any. */
  models?: string[];
  error?: string;
}

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  kind: string;
  description: string;
  local: boolean;
  configured: boolean;
  /** True when the provider answered and returned at least one model. */
  connected: boolean;
  authenticated: boolean;
  /** True when Wandey has a key for this provider, whether saved or from the environment. */
  keyStored: boolean;
  source?: ProviderStatus["source"];
  /** True for a user-added endpoint with no catalog template. */
  custom: boolean;
  /** Disconnected providers remain visible so they can be re-enabled. */
  disabled: boolean;
  auto?: ProviderStatus["auto"];
  baseUrl?: string;
  modelCount: number;
  models?: string[];
  error?: string;
  env: string[];
  docs?: string;
}

interface Resolved {
  adapter: ProviderAdapter;
  model: string;
  ref: string;
}

/**
 * Owns every configured provider and presents a single namespaced model list.
 *
 * Model refs are always "provider/model". Listing is best-effort and cached:
 * a dead Ollama port or a key without list permission must never stop the app
 * from starting.
 */
export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();
  private statuses = new Map<string, ProviderStatus>();
  private cache: { at: number; models: ModelInfo[] } | null = null;
  private config: Config;
  private readonly importOpenCode: boolean;

  constructor(config: Config, options: { importOpenCode?: boolean } = {}) {
    this.config = structuredClone(config);
    this.importOpenCode = options.importOpenCode ?? config.integrations.opencode;
    this.reset();
  }

  /** Re-read providers after a connection is added, edited, or removed. */
  reload(config: Config): void {
    this.config = structuredClone(config);
    this.reset();
  }

  private reset(): void {
    for (const adapter of this.adapters.values()) adapter.dispose?.();
    this.adapters.clear();
    this.statuses.clear();
    this.cache = null;
    if (this.importOpenCode) this.mergeOpenCode();
    this.build();
    // This is an integration, not a provider record. Keep it out of the
    // provider CRUD catalog while still exposing its models to the picker.
    if (this.config.integrations.opencodeLocal) this.addOpenCodeLocal();
  }

  private addOpenCodeLocal(): void {
    const adapter = new OpenCodeLocalProvider();
    this.adapters.set(OPENCODE_LOCAL_PROVIDER_ID, adapter);
    this.statuses.set(OPENCODE_LOCAL_PROVIDER_ID, {
      id: OPENCODE_LOCAL_PROVIDER_ID,
      name: "OpenCode local",
      kind: "opencode",
      authenticated: true,
      local: true,
      source: "opencode-local",
      auto: "local",
      modelCount: 0,
    });
  }

  private mergeOpenCode(): void {
    let imported: Record<string, ProviderConfig> = {};
    try {
      imported = openCodeProviderConfigs();
    } catch {
      return;
    }
    for (const [id, provider] of Object.entries(imported)) {
      const existing = this.config.providers[id];
      if (existing?.enabled === false) continue;
      // Explicit keys and env keys win over imported ones.
      if (existing && (existing.apiKey || (existing.apiKeyEnv && getApiKey(id, existing)))) continue;
      this.config.providers[id] = {
        ...provider,
        ...(existing ?? {}),
        apiKey: provider.apiKey,
        kind: existing?.kind ?? provider.kind,
        baseUrl: existing?.baseUrl ?? provider.baseUrl,
        auto: "opencode",
      };
    }
  }

  private build(): void {
    for (const [id, raw] of Object.entries(this.config.providers)) {
      if (raw.enabled === false) continue;
      // Reserved for the opt-in integration above.
      if (id === OPENCODE_LOCAL_PROVIDER_ID) continue;
      const cfg = resolveProviderConfig(id, raw);
      const template = templateFor(id);
      const kind = cfg.kind ?? template?.kind ?? "openai";
      const baseUrl = (cfg.baseUrl ?? template?.baseUrl ?? "").replace(/\/+$/, "");
      const apiKey = getApiKey(id, cfg);
      const isLocal = Boolean(cfg.local || template?.local);
      // A remote provider with no key can't do anything useful. A custom
      // baseUrl is an explicit invitation to try, even without a key.
      if (kind !== "openai" && !apiKey && !isLocal) continue;
      if (kind === "openai" && !apiKey && !isLocal && !cfg.baseUrl) continue;
      if (!baseUrl) continue;

      let adapter: ProviderAdapter;
      if (kind === "anthropic") {
        adapter = new AnthropicProvider({
          id,
          baseUrl,
          apiKey: apiKey ?? "",
          headers: cfg.headers,
          models: cfg.models,
        });
      } else if (kind === "gemini") {
        adapter = new GeminiProvider({
          id,
          baseUrl,
          apiKey: apiKey ?? "",
          models: cfg.models,
        });
      } else {
        adapter = new OpenAIProvider({
          id,
          baseUrl,
          apiKey,
          headers: cfg.headers,
          models: cfg.models,
          local: isLocal,
          ollama: id === "ollama" || baseUrl.includes(":11434"),
        });
      }

      this.adapters.set(id, adapter);
      this.statuses.set(id, {
        id,
        name: cfg.name ?? template?.name ?? id,
        kind,
        baseUrl,
        authenticated: Boolean(apiKey) || isLocal,
        local: isLocal,
        source: cfg.auto === "env" ? "env" : cfg.auto === "opencode" ? "opencode" : isLocal ? "local" : "config",
        auto: cfg.auto,
        modelCount: 0,
        models: cfg.models?.length ? [...cfg.models] : undefined,
      });
    }
  }

  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  async listModels(refresh = false): Promise<ModelInfo[]> {
    if (!refresh && this.cache && Date.now() - this.cache.at < 60_000) {
      return this.cache.models;
    }

    const entries = [...this.adapters.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([id, adapter]) => ({ id, models: await adapter.listModels() })),
    );

    const models: ModelInfo[] = [];
    const seen = new Set<string>();
    results.forEach((result, index) => {
      const [id] = entries[index]!;
      const status = this.statuses.get(id);
      if (result.status === "rejected") {
        if (status) {
          status.error = (result.reason as Error)?.message ?? String(result.reason);
          status.modelCount = 0;
        }
        return;
      }
      if (status) {
        status.error = undefined;
        status.modelCount = result.value.models.length;
      }
      for (const model of result.value.models) {
        const normalized: ModelInfo = {
          ...model,
          provider: id,
          ref: model.ref || `${id}/${model.id}`,
        };
        if (seen.has(normalized.ref)) continue;
        seen.add(normalized.ref);
        models.push(normalized);
      }
    });

    models.sort((a, b) => {
      const order = this.ids().indexOf(a.provider) - this.ids().indexOf(b.provider);
      if (order !== 0) return order;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    this.cache = { at: Date.now(), models };
    return models;
  }

  async defaultModel(refresh = false): Promise<string | null> {
    const configured = this.config.agent.model.trim();
    if (configured) return configured;
    const models = await this.listModels(refresh);
    // Prefer a tool-capable model; all modern ones are, but local servers may
    // expose embedding models too.
    return models.find((model) => model.supportsTools !== false)?.ref ?? models[0]?.ref ?? null;
  }

  async resolve(ref: string, refresh = false): Promise<Resolved> {
    const { provider: providerID, model } = parseModelRef(ref.trim());
    if (!model) throw new Error("Model ref is empty. Use provider/model.");

    let id = providerID;
    if (!id || !this.adapters.has(id)) {
      // Tolerate refs that omit the provider when the model is unambiguous.
      const models = await this.listModels(refresh);
      const matches = models.filter((m) => m.id === ref || m.ref === ref);
      if (matches.length === 1) {
        const match = matches[0]!;
        return { adapter: this.adapters.get(match.provider)!, model: match.id, ref: match.ref };
      }
      if (this.adapters.size === 1 && !providerID) {
        const only = [...this.adapters.entries()][0]!;
        return { adapter: only[1], model: ref, ref: `${only[0]}/${ref}` };
      }
      const available = this.ids().join(", ") || "none";
      throw new Error(`Unknown provider "${id ?? "(none)"}". Configured providers: ${available}`);
    }

    const adapter = this.adapters.get(id)!;
    return { adapter, model, ref: `${id}/${model}` };
  }

  async *stream(ref: string, req: Omit<ChatRequest, "model">): AsyncGenerator<ProviderEvent, void, unknown> {
    const resolved = await this.resolve(ref);
    yield* resolved.adapter.stream({ ...req, model: resolved.model });
  }

  async statusesWithModels(): Promise<ProviderStatus[]> {
    await this.listModels();
    return [...this.statuses.values()];
  }

  /** Whether a model can receive Wandey's tool schemas. */
  async supportsTools(ref: string): Promise<boolean> {
    try {
      const resolved = await this.resolve(ref);
      return (await resolved.adapter.supportsTools?.(resolved.model)) ?? true;
    } catch {
      // Resolution failures are surfaced when the request starts; do not turn
      // a missing model into a prompt-shape decision here.
      return true;
    }
  }

  /** Stop child processes and release other adapter resources. */
  stop(): void {
    for (const adapter of this.adapters.values()) adapter.dispose?.();
    this.adapters.clear();
    this.statuses.clear();
    this.cache = null;
  }

  catalog(): ProviderCatalogEntry[] {
    const entries = new Map<string, ProviderCatalogEntry>();
    for (const template of Object.values(PROVIDER_TEMPLATES)) {
      const raw = this.config.providers[template.id];
      const cfg = raw ? resolveProviderConfig(template.id, raw) : undefined;
      const status = this.statuses.get(template.id);
      const disabled = raw?.enabled === false;
      const local = Boolean(status?.local ?? cfg?.local ?? template.local);
      const apiKey = cfg ? getApiKey(template.id, cfg) : null;
      entries.set(template.id, {
        id: template.id,
        name: status?.name ?? cfg?.name ?? template.name,
        kind: status?.kind ?? cfg?.kind ?? template.kind,
        description: cfg?.description ?? template.description,
        local,
        configured: Boolean(status || raw),
        connected: Boolean(status && status.modelCount > 0),
        authenticated: status?.authenticated ?? Boolean(apiKey || local),
        keyStored: Boolean(apiKey),
        source: status?.source ?? (raw?.auto === "env" ? "env" : raw?.auto === "opencode" ? "opencode" : "config"),
        custom: false,
        disabled,
        auto: status?.auto ?? cfg?.auto,
        baseUrl: status?.baseUrl ?? cfg?.baseUrl ?? template.baseUrl,
        modelCount: status?.modelCount ?? 0,
        models: status?.models ?? cfg?.models,
        error: status?.error,
        env: template.env,
        docs: template.docs,
      });
    }

    // Keep user-added endpoints, including disconnected ones, visible so they
    // can be edited or reconnected later. A disabled provider has no status.
    const customIDs = new Set([...Object.keys(this.config.providers), ...this.statuses.keys()]);
    for (const id of customIDs) {
      if (templateFor(id) || id === OPENCODE_LOCAL_PROVIDER_ID) continue;
      const raw = this.config.providers[id];
      const cfg = raw ? resolveProviderConfig(id, raw) : undefined;
      const status = this.statuses.get(id);
      if (!status && !raw) continue;
      const local = Boolean(status?.local ?? cfg?.local);
      const apiKey = cfg ? getApiKey(id, cfg) : null;
      entries.set(id, {
        id,
        name: status?.name ?? cfg?.name ?? id,
        kind: status?.kind ?? cfg?.kind ?? "openai",
        description: cfg?.description ?? "Custom endpoint",
        local,
        configured: Boolean(status || raw),
        connected: Boolean(status && status.modelCount > 0),
        authenticated: status?.authenticated ?? Boolean(apiKey || local),
        keyStored: Boolean(apiKey),
        source: status?.source ?? "config",
        custom: true,
        disabled: raw?.enabled === false,
        auto: status?.auto ?? cfg?.auto,
        baseUrl: status?.baseUrl ?? cfg?.baseUrl,
        modelCount: status?.modelCount ?? 0,
        models: status?.models ?? cfg?.models,
        error: status?.error,
        env: [],
      });
    }
    return [...entries.values()];
  }

  modelConfig(ref: string): { contextWindow?: number; maxOutput?: number } {
    const found = this.cache?.models.find((model) => model.ref === ref);
    return { contextWindow: found?.contextWindow, maxOutput: found?.maxOutput };
  }
}

/**
 * A human-readable summary used by `wandey doctor`. Never includes secrets.
 */
export function describeProviders(registry: ProviderRegistry): string[] {
  return registry
    .catalog()
    .filter((entry) => entry.configured)
    .map((entry) => `${entry.id} (${entry.kind}${entry.local ? ", local" : ""})`);
}
