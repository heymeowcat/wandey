/**
 * Core domain types shared across wandey.
 *
 * There are three layers and this file defines the contracts between them:
 *
 *   providers/   model APIs (OpenAI-compatible, Anthropic, Gemini, ...)
 *   agent/       the loop that streams a model, runs tools, and persists parts
 *   server/web   the local HTTP + WebSocket surface the UI talks to
 *
 * Everything that crosses a layer boundary is declared here on purpose, so the
 * wire format the browser sees is the same shape the agent works with.
 */

// ---------------------------------------------------------------------------
// Messages (provider-facing and UI-facing)
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ReasoningBlock {
  type: "reasoning";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Raw arguments string, kept for debugging malformed tool calls. */
  raw?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  id: string;
  name: string;
  title?: string;
  output: string;
  isError?: boolean;
  metadata?: unknown;
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock | ToolResultBlock;

export interface ChatMessage {
  role: MessageRole;
  content: ContentBlock[];
}

/** Token accounting as reported by providers. */
export interface Usage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  cost?: number;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  [key: string]: unknown;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool input object. */
  parameters: JsonSchema;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown>; raw?: string }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: FinishReason; error?: string };

export type FinishReason = "stop" | "tool_calls" | "length" | "error" | "aborted";

export interface ModelInfo {
  /** Model id as sent to the provider, e.g. "gpt-4o" or "llama3.2". */
  id: string;
  /** Human-friendly label. */
  name: string;
  /** Provider id this model belongs to, e.g. "ollama". */
  provider: string;
  /** Fully qualified ref used in config and UI, e.g. "ollama/llama3.2". */
  ref: string;
  contextWindow?: number;
  maxOutput?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  free?: boolean;
  costPerMTok?: { input?: number; output?: number };
}

export interface ChatRequestContext {
  provider: ProviderAdapter;
  model: string;
}

export interface ProviderAdapter {
  /** Provider id, unique in the registry, e.g. "ollama". */
  id: string;
  /** Adapter family. */
  kind: ProviderKind;
  /** Base URL when the provider is HTTP-based. */
  baseUrl?: string;
  /** Whether credentials are configured (some local providers need none). */
  authenticated: boolean;
  listModels(): Promise<ModelInfo[]>;
  stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown>;
}

export type ProviderKind = "openai" | "anthropic" | "gemini" | "opencode";

// ---------------------------------------------------------------------------
// Sessions and persisted parts
// ---------------------------------------------------------------------------

export type SessionMode = "chat" | "research";

export interface Session {
  id: string;
  title: string;
  mode: SessionMode;
  model: string | null;
  parentID: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  model: string | null;
  error: string | null;
  finishReason: FinishReason | null;
  usage: Usage | null;
  createdAt: number;
}

export type PartType =
  | "text"
  | "reasoning"
  | "tool"
  | "source"
  | "question"
  | "research"
  | "error";

export interface TextPartData {
  text: string;
}

export interface ReasoningPartData {
  text: string;
}

export type ToolStatus = "running" | "done" | "error";

export interface ToolPartData {
  callID: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  title?: string;
  output?: string;
  metadata?: unknown;
  startedAt: number;
  endedAt?: number;
}

export interface SourcePartData {
  sourceID: string;
  url: string;
  title: string;
  site?: string;
  snippet?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionPartData {
  questionID: string;
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple: boolean;
  allowCustom: boolean;
  answer?: string[];
  /** How the question ended, in case it was never answered. */
  status?: "pending" | "answered" | "expired";
}

export type ResearchStage =
  | "planning"
  | "searching"
  | "crawling"
  | "extracting"
  | "analyzing"
  | "synthesizing"
  | "done"
  | "error";

export interface ResearchProgress {
  stage: ResearchStage;
  message: string;
  subQuestionsDone: number;
  subQuestionsTotal: number;
  sourcesFound: number;
  pagesFetched: number;
  round: number;
  roundTotal: number;
  current: string[];
}

export interface ResearchPartData {
  jobID: string;
  question: string;
  depth: ResearchDepth;
  status: "running" | "done" | "error";
  progress: ResearchProgress;
  report?: string;
  error?: string;
}

export type Part =
  | { id: string; sessionID: string; messageID: string; order: number; createdAt: number; type: "text"; data: TextPartData }
  | { id: string; sessionID: string; messageID: string; order: number; createdAt: number; type: "reasoning"; data: ReasoningPartData }
  | { id: string; sessionID: string; messageID: string; order: number; createdAt: number; type: "tool"; data: ToolPartData }
  | { id: string; sessionID: string; messageID: string; order: number; createdAt: number; type: "source"; data: SourcePartData }
  | { id: string; sessionID: string; messageID: string; order: number; createdAt: number; type: "question"; data: QuestionPartData }
  | { id: string; sessionID: string; messageID: string; order: number; createdAt: number; type: "research"; data: ResearchPartData }
  | { id: string; sessionID: string; messageID: string; order: number; createdAt: number; type: "error"; data: { message: string } };

export interface SessionDetail {
  session: Session;
  messages: Array<{ message: Message; parts: Part[] }>;
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

export type ResearchDepth = "quick" | "standard" | "deep" | "exhaustive";

export interface ResearchSource {
  id: string;
  sessionID: string;
  url: string;
  canonicalUrl: string;
  title: string;
  site: string;
  snippet: string;
  text: string;
  fetchedAt: number;
  status: number;
  words: number;
  error?: string;
}

export interface EvidenceNote {
  id: string;
  claim: string;
  quote: string;
  sourceID: string;
  sourceTitle: string;
  sourceURL: string;
  subQuestionID: string;
  confidence: "low" | "medium" | "high";
  round: number;
}

export interface SubQuestion {
  id: string;
  question: string;
  queries: string[];
  rationale?: string;
}

export interface ResearchPlan {
  restatedQuestion: string;
  scope: string;
  subQuestions: SubQuestion[];
}

export interface ResearchJob {
  id: string;
  sessionID: string;
  question: string;
  depth: ResearchDepth;
  status: "pending" | "running" | "done" | "error" | "aborted";
  plan: ResearchPlan | null;
  report: string | null;
  error: string | null;
  outputPath: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  provider: string;
  publishedAt?: string;
  score?: number;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  site: string;
  markdown: string;
  text: string;
  links: string[];
  words: number;
  fetchedAt: number;
  /** How the page content was obtained. */
  via: "http" | "reader" | "browser" | "backend" | "cache";
  fromCache?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Server events (agent -> UI over WebSocket)
// ---------------------------------------------------------------------------

export interface CrawlProgress {
  jobID: string;
  kind: "discovered" | "fetching" | "fetched" | "failed" | "skipped";
  url: string;
  queued: number;
  active: number;
  fetched: number;
  failed: number;
  message?: string;
}

export type ServerEvent =
  | { type: "hello"; sessionID?: string; data: { version: string; models: ModelInfo[] } }
  | { type: "session.updated"; session: Session }
  | { type: "session.deleted"; sessionID: string }
  | { type: "message.created"; sessionID: string; message: Message }
  | { type: "part.created"; sessionID: string; messageID: string; part: Part }
  | { type: "part.delta"; sessionID: string; messageID: string; partID: string; kind: "text" | "reasoning"; delta: string }
  | { type: "part.updated"; sessionID: string; part: Part }
  | { type: "message.updated"; sessionID: string; message: Message }
  | { type: "session.status"; sessionID: string; status: "idle" | "streaming" | "tool" | "waiting" }
  | { type: "session.error"; sessionID: string; message: string }
  | { type: "question"; sessionID: string; part: Part }
  | { type: "question.done"; sessionID: string; part: Part }
  | { type: "crawl.progress"; sessionID: string; progress: CrawlProgress }
  | { type: "research.progress"; sessionID: string; part: Part }
  | { type: "toast"; level: "info" | "error" | "success"; message: string };

/** Events the UI sends back to the agent. */
export type ClientEvent =
  | { type: "ping" }
  | { type: "subscribe"; sessionID: string }
  | { type: "prompt"; sessionID: string; text: string; model?: string; mode?: SessionMode }
  | { type: "abort"; sessionID: string }
  | { type: "answer"; sessionID: string; questionID: string; answer: string[]; custom?: string }
  | { type: "permission"; sessionID: string; requestID: string; allow: boolean; remember?: boolean };
