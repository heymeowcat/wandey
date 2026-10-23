import type {
  Message,
  ModelInfo,
  ResearchJob,
  ResearchPartData,
  Session,
  SessionDetail,
  SessionMode,
  SourcePartData,
} from "../src/core/types.ts";

/** Typed wrappers for the local HTTP API. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ProviderInfo {
  id: string;
  name: string;
  kind: string;
  baseUrl?: string;
  authenticated: boolean;
  local: boolean;
  source: string;
  auto?: "env" | "local" | "opencode";
  modelCount: number;
  models?: string[];
  error?: string;
}

export interface ProviderCatalogEntry extends ProviderInfo {
  description: string;
  configured: boolean;
  connected: boolean;
  keyStored: boolean;
  custom: boolean;
  disabled: boolean;
  env: string[];
  docs?: string;
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
  catalog: ProviderCatalogEntry[];
  configFile: string;
  opencode: boolean;
}

export interface ProviderMutationResponse {
  id?: string;
  provider?: ProviderInfo | null;
  models: ModelInfo[];
  providers: ProviderInfo[];
  catalog: ProviderCatalogEntry[];
}

export interface ProviderUpsert {
  id?: string;
  name?: string;
  kind?: "openai" | "anthropic" | "gemini";
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
}

export interface LoadedSessionDetail extends SessionDetail {
  /** Present after a page reload while the agent is still working. */
  running?: boolean;
}

export interface ModelsResponse {
  models: ModelInfo[];
  providers: ProviderInfo[];
}

export interface SessionPatch {
  title?: string;
  model?: string | null;
  mode?: SessionMode;
  archived?: boolean;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Not JSON; keep the status line.
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  models: () => request<ModelsResponse>("/api/models"),

  providers: () => request<ProvidersResponse>("/api/providers"),

  connectProvider: (provider: ProviderUpsert) =>
    request<ProviderMutationResponse>("/api/providers", {
      method: "POST",
      body: JSON.stringify(provider),
    }),

  disconnectProvider: (id: string) =>
    request<ProviderMutationResponse & { ok: boolean }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  refreshProviders: () =>
    request<{ models: ModelInfo[]; providers: ProviderInfo[]; catalog: ProviderCatalogEntry[] }>(
      "/api/providers/refresh",
      { method: "POST" },
    ),

  sessions: () => request<{ sessions: Session[] }>("/api/sessions"),

  session: (id: string) => request<LoadedSessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),

  createSession: (options: { title?: string; mode?: SessionMode; model?: string | null } = {}) =>
    request<{ session: Session }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(options),
    }),

  updateSession: (id: string, patch: SessionPatch) =>
    request<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),

  prompt: (id: string, text: string, options: { model?: string; mode?: SessionMode } = {}) =>
    request<{ message: Message }>(`/api/sessions/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text, ...options }),
    }),

  abort: (id: string) =>
    request<{ aborted: boolean }>(`/api/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" }),

  answer: (id: string, questionID: string, answer: string[], custom?: string) =>
    request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ questionID, answer, custom }),
    }),

  source: (sessionID: string, sourceID: string) =>
    request<{ source: SourcePartData & { text: string; content: string; fetchedAt: number } }>(
      `/api/sessions/${encodeURIComponent(sessionID)}/sources/${encodeURIComponent(sourceID)}`,
    ),

  researchJobs: (sessionID: string) =>
    request<{ jobs: ResearchJob[] }>(`/api/sessions/${encodeURIComponent(sessionID)}/research`),

  researchJob: (jobID: string) =>
    request<{
      job: ResearchJob;
      notes: Array<{
        id: string;
        claim: string;
        quote: string;
        sourceID: string;
        sourceTitle: string;
        sourceURL: string;
        confidence: string;
      }>;
      sources: SourcePartData[];
    }>(`/api/research/${encodeURIComponent(jobID)}`),

  resumeResearch: (jobID: string) =>
    request<{ message: Message }>(`/api/research/${encodeURIComponent(jobID)}/resume`, {
      method: "POST",
    }),
};

/** The research part card needs this narrow helper for dashboard labels. */
export function researchPercent(data: ResearchPartData): number {
  if (data.status === "done") return 100;
  if (data.status === "error") return 100;
  const stage = data.progress.stage;
  if (data.progress.subQuestionsTotal > 0 && data.progress.subQuestionsDone > 0) {
    const base = stage === "synthesizing" ? 88 : stage === "done" ? 100 : 62;
    return Math.min(96, base + (data.progress.subQuestionsDone / data.progress.subQuestionsTotal) * 14);
  }
  const floor: Record<string, number> = {
    planning: 4,
    searching: 18,
    crawling: 38,
    extracting: 58,
    analyzing: 72,
    synthesizing: 88,
    done: 100,
    error: 100,
  };
  return floor[stage] ?? 5;
}
