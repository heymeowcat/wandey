# Milestone 1 — Durable runs, budgets, and traces

Status: proposed. No implementation changes are included in this document.

## 1. Goal

Make every agent turn a persisted, resumable run instead of an in-memory promise.

Milestone 1 adds three things:

1. A durable run/step/checkpoint ledger with crash recovery and resume.
2. Run budgets, provider retries, and ordered model fallback.
3. A run strip, budget meter, and trace view in the web UI.

Deep research already checkpoints its own pipeline. This milestone links that work into the
outer run ledger so a `deep_research` tool call resumes the existing research job instead of
starting a duplicate.

### Non-goals

Deferred to later milestones:

- Plan/todo parts, pause/steer, approval gates, and tool policy.
- Typed subagents and isolated role contexts.
- Verification/evidence graph.
- Context summarization and long-term memory.
- MCP, workflows, schedules, local corpus, and eval harness.
- A general coding agent, shell, or browser automation.

## 2. User-visible behavior

- Every accepted prompt creates a run. The session header shows whether it is running,
  waiting for an answer, interrupted, stopped, or complete.
- A restart marks active runs `interrupted`. The user can resume from the last checkpoint or
  dismiss the run.
- A provider error before any content is retried, then falls back through
  `agent.fallback` in order. A mid-stream failure is not retried automatically; the run
  becomes resumable and the partial assistant message is discarded on resume.
- A run can be stopped by token, cost, elapsed-time, tool-call, or crawl-page budgets. The
  run strip shows which budget stopped it and the trace keeps the accounting.
- The trace view lists every model attempt and tool call, including retries, fallbacks,
  duration, usage, errors, and the linked research job.
- Existing sessions, messages, sources, research jobs, provider settings, and the model
  picker continue to work unchanged.

## 3. Data model

### 3.1 Migration `2 -> 3`

Add one migration to `src/storage/schema.ts`. It only creates new tables and indexes; it does
not alter existing tables.

```sql
create table if not exists run (
  id text primary key,
  session_id text not null references session(id) on delete cascade,
  user_message_id text not null references message(id) on delete cascade,
  assistant_message_id text references message(id) on delete set null,
  status text not null,
  mode text not null,
  model text,
  prompt text not null,
  budget text not null,
  usage text not null,
  error text,
  stop_reason text,
  resume_count integer not null default 0,
  started_at integer not null,
  updated_at integer not null,
  ended_at integer,
  dismissed_at integer
);
create index if not exists run_session on run(session_id, started_at desc);
create index if not exists run_open on run(status, updated_at desc);
create unique index if not exists run_active_session on run(session_id)
  where status in ('running', 'waiting');

create table if not exists run_step (
  id text primary key,
  run_id text not null references run(id) on delete cascade,
  step_key text not null,
  ordinal integer not null,
  kind text not null,
  name text not null,
  status text not null,
  attempt integer not null default 1,
  model text,
  message_id text references message(id) on delete set null,
  call_id text,
  ref_id text,
  title text,
  input text,
  output text,
  usage text,
  crawl_pages integer not null default 0,
  error text,
  started_at integer not null,
  ended_at integer,
  updated_at integer not null
);
create index if not exists run_step_run on run_step(run_id, ordinal, attempt);
create unique index if not exists run_step_attempt on run_step(run_id, step_key, attempt);

create table if not exists run_checkpoint (
  id text primary key,
  run_id text not null references run(id) on delete cascade,
  seq integer not null,
  state text not null,
  created_at integer not null
);
create unique index if not exists run_checkpoint_seq on run_checkpoint(run_id, seq);
```

`run.user_message_id` cascades from `message`, so deleting a session or message also removes
its run. `run_step.message_id` is nullable because a failed attempt may not own a message.

### 3.2 Core types

Add to `src/core/types.ts`:

```ts
export type RunStatus =
  | "running"
  | "waiting"
  | "interrupted"
  | "completed"
  | "aborted"
  | "failed";

export type RunStopReason =
  | "completed"
  | "user"
  | "budget"
  | "step_limit"
  | "error"
  | "restart";

export interface RunBudget {
  maxTokens: number;
  maxCostUsd: number;
  maxSeconds: number;
  maxToolCalls: number;
  maxCrawlPages: number;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  toolCalls: number;
  crawlPages: number;
  elapsedMs: number;
  /** True when any token count was estimated instead of provider-reported. */
  estimated: boolean;
}

export interface Run {
  id: string;
  sessionID: string;
  userMessageID: string;
  assistantMessageID: string | null;
  status: RunStatus;
  mode: SessionMode;
  model: string | null;
  prompt: string;
  budget: RunBudget;
  usage: RunUsage;
  error: string | null;
  stopReason: RunStopReason | null;
  resumeCount: number;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  dismissedAt: number | null;
}

export type RunStepKind = "model" | "tool";
export type RunStepStatus = "running" | "completed" | "failed" | "aborted";

export interface RunStep {
  id: string;
  runID: string;
  /** Stable identity: model:<loop> or tool:<loop>:<index>:<callID>. */
  stepKey: string;
  ordinal: number;
  kind: RunStepKind;
  /** "model" or the tool name. */
  name: string;
  status: RunStepStatus;
  attempt: number;
  model: string | null;
  messageID: string | null;
  callID: string | null;
  /** External durable object, currently the deep-research job id. */
  refID: string | null;
  title: string | null;
  /** Truncated JSON metadata, never the full system prompt. */
  input: string | null;
  /** Truncated result text. */
  output: string | null;
  usage: Usage | null;
  crawlPages: number;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  updatedAt: number;
}

export interface RunCheckpointState {
  version: 1;
  loopStep: number;
  phase: "model" | "tools" | "done";
  assistantMessageID: string | null;
  modelStepID: string | null;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  nextToolIndex: number;
}

export interface RunCheckpoint {
  id: string;
  runID: string;
  seq: number;
  state: RunCheckpointState;
  createdAt: number;
}
```

Also add `callID?: string` to `QuestionPartData` so a resumed `ask_user` step can find its
question after a restart.

Add run events to `ServerEvent`:

```ts
| { type: "run.created"; sessionID: string; run: Run }
| { type: "run.updated"; sessionID: string; run: Run }
| { type: "run.step"; sessionID: string; runID: string; step: RunStep }
```

Do not add runs to the core `SessionDetail`; the server adds `runs` to the session-detail
response so the CLI and storage contract stay small.

### 3.3 Invariants

- A session has at most one run with status `running` or `waiting`.
- `run.status` is `running` only while the process owns the run. Startup recovery converts
  stale `running`/`waiting` rows to `interrupted`.
- A model step is completed only after its assistant message and parts are persisted.
- A tool step is completed only after its tool part is persisted.
- `run_checkpoint` is the resume cursor. `run_step` is the audit and idempotency record.
- `run_step.ref_id` is set to the research job id for `deep_research`. The step's `call_id`
  is stored separately.
- Trace payloads are truncated: model metadata and tool args to 4 KB, tool output to 8 KB,
  model output to 8 KB. The full system prompt is never stored.

## 4. Configuration

Add to `src/core/config.ts`:

```ts
export interface AgentBudgetConfig {
  /** 0 means unlimited. */
  maxTokens: number;
  maxCostUsd: number;
  maxSeconds: number;
  maxToolCalls: number;
  maxCrawlPages: number;
}

export interface AgentRetryConfig {
  /** Total attempts per model candidate, including the first. */
  attempts: number;
  baseDelayMs: number;
}
```

Extend `Config.agent`:

```ts
agent: {
  // existing fields...
  budget: AgentBudgetConfig;
  retry: AgentRetryConfig;
  /** Ordered fallback refs, tried after the primary model is exhausted. */
  fallback: string[];
};
```

Defaults:

```json
{
  "agent": {
    "budget": {
      "maxTokens": 0,
      "maxCostUsd": 0,
      "maxSeconds": 0,
      "maxToolCalls": 0,
      "maxCrawlPages": 0
    },
    "retry": {
      "attempts": 3,
      "baseDelayMs": 700
    },
    "fallback": []
  }
}
```

Semantics:

| Field | Meaning |
| --- | --- |
| `maxTokens` | Input + output tokens across all model attempts in the run. |
| `maxCostUsd` | Estimated or provider-reported USD cost across the run. |
| `maxSeconds` | Active wall-clock time across resumes, excluding server downtime. |
| `maxToolCalls` | Top-level tool calls. A `deep_research` call counts as one. |
| `maxCrawlPages` | Pages actually fetched by `fetch_url`, `crawl_site`, or deep research. |
| `retry.attempts` | Attempts per model candidate. `1` disables retries. |
| `retry.baseDelayMs` | Exponential backoff base, capped at 8 seconds with jitter. |
| `fallback` | Ordered model refs. Tried only when the primary has no content yet. |

`mergeConfig` must merge `budget` and `retry` as nested objects and replace `fallback`
arrays rather than merging them. Normalize negative values to `0`, `attempts` to at least
`1`, and trim/deduplicate fallback refs in `loadConfig`. `saveConfig` already writes the
whole `agent` object, so no separate persistence change is needed.

Budget snapshots are stored on the run at creation. Changing config affects new runs, not
runs already in progress. A budget-stopped run is terminal; dismiss it and start a new run
with a larger budget. `interrupted`, `failed`, and user-aborted runs are resumable.

## 5. Store API

Add these methods to `src/storage/store.ts`:

```ts
createRun(options: {
  sessionID: string;
  userMessageID: string;
  prompt: string;
  mode: SessionMode;
  model: string | null;
  budget: RunBudget;
}): Run;

getRun(id: string): Run | null;
listRuns(sessionID: string, options?: { limit?: number; includeDismissed?: boolean }): Run[];
latestRun(sessionID: string, options?: { includeDismissed?: boolean }): Run | null;

updateRun(
  id: string,
  patch: Partial<Pick<Run,
    | "assistantMessageID"
    | "status"
    | "model"
    | "usage"
    | "error"
    | "stopReason"
    | "endedAt"
    | "dismissedAt"
  >> & { resumeCount?: number },
): Run | null;

recoverInterruptedRuns(message?: string): number;
dismissRun(id: string): Run | null;
deleteRun(id: string): void;

createRunStep(options: {
  runID: string;
  stepKey: string;
  kind: RunStepKind;
  name: string;
  attempt?: number;
  model?: string | null;
  messageID?: string | null;
  callID?: string | null;
  refID?: string | null;
  title?: string | null;
  input?: string | null;
}): RunStep;

updateRunStep(
  id: string,
  patch: Partial<Pick<RunStep,
    | "status"
    | "model"
    | "messageID"
    | "refID"
    | "title"
    | "input"
    | "output"
    | "usage"
    | "crawlPages"
    | "error"
    | "endedAt"
  >>,
): RunStep | null;

getRunStep(id: string): RunStep | null;
latestRunStep(runID: string, stepKey: string): RunStep | null;
listRunSteps(runID: string): RunStep[];

createRunCheckpoint(runID: string, state: RunCheckpointState): RunCheckpoint;
latestRunCheckpoint(runID: string): RunCheckpoint | null;
listRunCheckpoints(runID: string): RunCheckpoint[];

/** Delete an assistant message and its parts before retrying a partial stream. */
deleteMessage(id: string): void;

/** Remove empty assistant messages left by a crash between insert and checkpoint. */
deleteEmptyAssistantMessages(sessionID: string): number;

/** Mark unanswered question parts expired after a restart. */
expirePendingQuestions(message?: string): number;

/** Reconcile the run usage row from persisted step usage. */
sumRunUsage(runID: string): RunUsage;

/**
 * Crash-window fallback: find the newest research job for this session/question
 * that is not linked from any run step.
 */
findUnlinkedResearchJob(sessionID: string, question: string, since: number): ResearchJob | null;
```

Implementation notes:

- `ordinal` is allocated as `max(ordinal) + 1` for the run, so retries and fallbacks appear
  in chronological trace order even though they share a `step_key`.
- `createRunCheckpoint` allocates `seq` as `max(seq) + 1` in the same transaction as the
  insert.
- `recoverInterruptedRuns` updates `running`/`waiting` runs to `interrupted`,
  `stop_reason = 'restart'`, sets `ended_at`, and marks any `running` steps `failed` with the
  same message. It does not touch completed runs or research jobs; research recovery stays
  separate.
- `expirePendingQuestions` iterates question parts with `status = 'pending'`, updates them to
  `expired`, and publishes nothing (startup has no sockets).
- `deleteEmptyAssistantMessages` deletes assistant messages with zero parts. It protects real
  failures because those messages always have at least an error part. Call it at the start of
  resume to clean up a crash between message insertion and checkpoint insertion.
- `sumRunUsage` sums `run_step.usage` and `crawl_pages`, counts tool steps, and preserves the
  stored `elapsed_ms`. Use it on resume so a crash cannot double-count a retried step.
- Row mappers follow the existing `rowToX` style at the bottom of `store.ts`.

## 6. Agent state machine

Replace the in-memory-only loop in `src/agent/agent.ts` with a persisted run state machine.
`Agent.runs` remains the process-local registry of active controllers, but it no longer owns
run state.

### 6.1 Run creation

`Agent.prompt()`:

1. Validate the prompt and session.
2. Build the user message and its text part.
3. Create the user message, its text part, and the run with the session/model/budget snapshot
   in one SQLite transaction, so an active-run conflict cannot leave an orphan prompt. Publish
   `run.created` after the commit.
4. Start `executeRun(run.id)` in the background and return `{ message, run }` from the HTTP
   layer. The CLI keeps returning the message.
5. The finalizer updates the run to a terminal status, publishes `run.updated`, touches the
   session, and publishes `session.status: idle`.

### 6.2 Step keys

Deterministic keys make resume idempotent:

```text
model:<loopStep>
tool:<loopStep>:<callIndex>:<callID>
```

`loopStep` is the model iteration, starting at `0`. A model retry or fallback uses the same
key with `attempt + 1`. A tool step that was interrupted while `running` is marked
`aborted` and retried as a new attempt with the same key. A tool step that already has a
persisted tool result is skipped.

### 6.3 Main loop

```text
load latest checkpoint, or start at { loopStep: 0, phase: "model" }

while loopStep < agent.maxSteps:
  budget.check()
  if checkpoint.phase == "done": finish completed
  if checkpoint.phase == "tools":
    execute pending tool calls from checkpoint.nextToolIndex
    checkpoint = { phase: "model", loopStep: loopStep + 1, ... }
    continue

  assistant = checkpoint.assistantMessageID
    ? reuse the empty assistant message
    : store.createMessage(sessionID, "assistant", model)

  create/latest model step for model:<loopStep> with the next attempt
  checkpoint = { phase: "model", assistantMessageID: assistant.id, modelStepID: step.id, ... }
  save checkpoint

  stream the model with retry/fallback
  persist text/reasoning/usage and the assistant message

  if no tool calls:
    checkpoint = { phase: "done", ... }
    save checkpoint
    mark model step completed
    finish completed

  checkpoint = { phase: "tools", toolCalls, nextToolIndex: 0, ... }
  save checkpoint
  mark model step completed
  execute tool calls
  checkpoint = { phase: "model", loopStep: loopStep + 1, ... }
  save checkpoint

if loopStep reached maxSteps:
  finish failed with stop_reason "step_limit"
```

The existing `buildProviderHistory`, `buildSystemPrompt`, and part streaming code stay. The
state machine wraps them rather than replacing them.

Write ordering matters: the checkpoint with the completed model output and tool calls is
persisted before the model step is marked completed. If the process dies between those two
writes, resume sees `phase: "tools"` and marks the still-running model step completed because
its message and parts are already durable. This avoids replaying a completed model call.

### 6.4 Resume

`Agent.resumeRun(runID)` is exposed to the server and the CLI:

1. Reject missing, running, waiting, completed, dismissed, or budget-stopped runs.
2. Reject if the session already has an active run.
3. Delete empty assistant messages left by a crash between message insertion and checkpoint
   insertion.
4. Load the latest checkpoint. If there is none, derive the cursor from the latest steps or
   start at loop 0.
5. If the checkpoint phase is `model` and it has an assistant message:
   - Delete that assistant message and its parts. This removes a partial stream.
   - Mark the current model step `failed` with `Interrupted before completion`.
   - Clear `assistantMessageID`/`modelStepID` and retry the same `model:<loopStep>` key with
     the next attempt.
6. If the checkpoint phase is `tools`, keep the assistant message and completed tool parts.
   If the model step is still `running`, mark it completed because the checkpoint was written
   only after its message and parts were persisted. Continue from `nextToolIndex`.
7. If the checkpoint phase is `done`, mark any still-running model step completed, reconcile
   usage, set the run to `completed`, publish `run.updated`, and return without another model
   call.
8. Otherwise reconcile `run.usage` with `sumRunUsage`, set status `running`, clear `error`,
   `stopReason`, and `endedAt`, increment `resume_count`, publish `run.updated`, and start
   `executeRun`.
9. On success, the finalizer marks the run completed.

A resumed run must never create a second assistant answer for the same model step. The
partial-message deletion is what prevents duplicated output.

### 6.5 Tool execution and idempotency

`runTool()` records a tool step before executing and updates it after the tool part is saved.
It reuses an existing tool part with the same `callID` instead of creating a second card when
a tool is retried. A tool result (including an error result) marks the step `completed` and is
fed back to the model. A user abort or crash leaves the step `aborted`/`running`; resume
re-runs it. The tool context `emit` is wrapped so crawl progress can update the run budget.

Resume behavior per tool:

| Tool | Resume behavior |
| --- | --- |
| `deep_research` | If `ref_id` points to a job, call `ResearchEngine.resume`. If the job is already done, rebuild the tool result from the saved report. If `ref_id` is missing, use `findUnlinkedResearchJob`; only start a new job if no match exists. |
| `ask_user` | If the matching question part is answered, reuse it. Otherwise mark the old question expired and ask again. |
| `web_search` | Re-run; it has no durable side effects. |
| `fetch_url` / `crawl_site` | Re-run; sources deduplicate by canonical URL. |
| `read_source` | Re-run; read-only. |

For `deep_research`, `ResearchEngine.run` calls an `onJobCreated` observer immediately after
`createResearchJob`. The agent updates `run_step.ref_id` and publishes `run.step` from that
callback. The callback is synchronous and runs before research work starts, which closes the
normal crash window. `findUnlinkedResearchJob` closes the remaining insert/callback gap.

When research resumes, the agent reuses the existing assistant message and tool part. The
research engine creates its new research card in the same message, as it already does for
legacy resume. On success, the tool step is marked completed with the report summary and
job metadata.

### 6.6 Questions and restart

- `startServer` calls `expirePendingQuestions()` after `recoverInterruptedRuns()`.
- A run in `waiting` becomes `interrupted` on restart; resume re-asks if needed.
- While the process is alive, `answerQuestion` continues to resolve the in-memory promise and
  sets the run back to `running`.

## 7. Budgets

Add `src/agent/budget.ts`:

```ts
export class BudgetExceededError extends Error {
  constructor(
    readonly dimension: "tokens" | "cost" | "time" | "tools" | "pages",
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class RunBudgetController {
  constructor(options: {
    budget: RunBudget;
    usage: RunUsage;
    onExceeded: (error: BudgetExceededError) => void;
    onChange?: (usage: RunUsage) => void;
  });

  start(): () => void; // starts the maxSeconds timer, returns stop()
  check(): void;      // throws BudgetExceededError
  addUsage(model: string, usage: Usage, info: ModelInfo | null): void;
  addToolCall(): void;
  addCrawlPages(delta: number): void;
  addEstimatedUsage(inputChars: number, outputChars: number, info: ModelInfo | null): void;
  snapshot(): RunUsage;
}
```

Accounting rules:

- Usage events from a provider are treated as cumulative snapshots for that step. Add only
  positive deltas to the run total.
- `totalTokens = usage.total ?? input + output`. Reasoning tokens are included in output
  where providers report them separately.
- Cost uses `usage.cost` when present. Otherwise use
  `input / 1e6 * costPerMTok.input + output / 1e6 * costPerMTok.output` from `ModelInfo`.
- If a provider reports no usage, estimate `ceil(chars / 4)` tokens at step end and set
  `usage.estimated = true`.
- Persist the step's usage even when the attempt fails or is aborted mid-stream. The tokens
  and cost were still incurred and must count toward the run budget and trace.
- `elapsedMs` is active time. On resume, start from the persisted value and add the new
  active duration.
- `maxCrawlPages` counts actual fetched pages. For `crawl_site`, track a per-tool high-water
  mark from `crawl.progress.fetched`; for research, use the delta in
  `progress.pagesFetched`.

Enforcement points:

1. Before every model attempt.
2. After every usage event, so a token/cost overrun can abort mid-stream.
3. Before every tool call.
4. On every crawl/research page progress update.
5. A timer for `maxSeconds` that calls `controller.abort(new BudgetExceededError(...))`.

When a budget is exceeded:

- Abort the run controller with `BudgetExceededError`.
- Mark the current step `aborted`.
- Set `run.status = "aborted"`, `run.stopReason = "budget"`, and a clear error such as
  `Run budget exceeded: max cost $0.10 (used $0.12).`
- Add an error part to the current assistant message.
- Publish `run.updated` and `session.error`.
- Do not retry or fall back; budget exhaustion is terminal.

The run strip shows configured limits only. Unlimited dimensions show the used amount without
a bar.

## 8. Retry and fallback

Add `src/providers/retry.ts` with:

```ts
export function isRetryableProviderError(error: unknown): boolean;

export class MidStreamError extends Error {
  constructor(
    message: string,
    readonly ref: string,
    readonly attempt: number,
    readonly cause?: unknown,
  );
}

export async function* streamWithFallback(options: {
  candidates: string[];
  attempts: number;
  baseDelayMs: number;
  signal?: AbortSignal;
  supportsTools: (ref: string) => Promise<boolean>;
  open: (ref: string, toolsEnabled: boolean) => AsyncIterable<ProviderEvent>;
  onAttempt?: (info: {
    ref: string;
    attempt: number;
    toolsEnabled: boolean;
  }) => void;
  onFirstContent?: (info: { ref: string; attempt: number }) => void;
}): AsyncGenerator<ProviderEvent & { model: string; attempt: number }>;
```

`attempt` in `onAttempt` and in the yielded event is the global attempt number for this model
step, incremented across retries and fallback candidates. The per-candidate retry counter is
internal. This keeps `run_step` attempts unique for the `(run_id, step_key, attempt)` index.

Classification:

- Retryable: network/stream errors without a status, HTTP `408`, `425`, `429`, `500`, `502`,
  `503`, `504`, and provider timeouts that are not user aborts.
- Not retryable: `400`, `401`, `403`, `404`, `422`, and other 4xx errors.
- `AbortError`/user abort is never retried.
- An empty research completion is retryable once; a chat completion that only produces
  reasoning follows the existing "model ended without an answer" error path.

Algorithm:

```text
for each candidate in [primary, ...fallback]:
  resolve candidate; if invalid, record the attempt and move on
  toolsEnabled = supportsTools(candidate) && step has tool schemas
  for attempt = 1..attempts:
    record a model step attempt
    stream = open(candidate, toolsEnabled)
    firstContent = false
    try:
      for event in stream:
        if event is text/reasoning/tool_call: firstContent = true
        yield event
      return
    catch error:
      if user aborted: throw
      if firstContent:
        throw MidStreamError(...)       // never duplicate output
      if retryable and attempt < attempts:
        backoff and retry same candidate
      else:
        move to next candidate
throw the last error
```

- `firstContent` includes text, reasoning, and tool calls. Usage/finish events alone do not
  count as content.
- A fallback candidate that does not support tools runs text-only; the system prompt is
  rebuilt by the `open` callback so the model is not told it has unavailable tools.
- Every attempt is a separate `run_step` row with the same `step_key` and increasing
  `attempt`, so the trace shows retries and fallbacks.
- The model step's `model` is the model that actually produced the final response.

`ProviderRegistry` gets:

```ts
async modelInfo(ref: string): Promise<ModelInfo | null>;
```

It uses the existing cached `listModels()` result and returns a minimal `ModelInfo` when the
provider does not expose metadata. Cost is `0` when no pricing is known.

`ResearchModel` uses the same helper:

- Add `complete(request): Promise<{ text: string; usage: Usage; model: string }>`.
- Keep `text()` as a wrapper for existing callers.
- Pass `agent.retry` and `agent.fallback` into `ResearchModel` from `ResearchEngine`.
- Record usage through the research observer before returning.

This gives research calls the same retry/fallback policy without adding a second routing map.

## 9. Research integration

Extend `ResearchEngineDeps` and the run inputs with an optional observer:

```ts
export interface ResearchObserver {
  onJobCreated(job: ResearchJob): void;
  onModelUsage(model: string, usage: Usage): void;
  /** Delta since the previous observer call. */
  onPagesFetched(delta: number): void;
  assertBudget(): void;
}
```

Changes in `src/research/engine.ts`:

- `run()` calls `observer?.onJobCreated(job)` immediately after `createResearchJob`.
- `ResearchRun` holds the observer and calls `assertBudget()` before planning, searching,
  fetching, extraction, gap analysis, and synthesis.
- `progressNow()` computes the page delta from the previous observed `pagesFetched` and calls
  `observer?.onPagesFetched(delta)`. On resume, initialize the previous value from the
  checkpoint so pages already counted by the run are not counted twice.
- Each model call goes through a small `callText()` helper that records usage and checks the
  budget. The agent accumulates that usage and the page delta onto the active
  `deep_research` tool step as well as the run total.
- On abort, use `signal.reason` when it is a `BudgetExceededError` so the research job error
  says `Run budget exceeded: ...` instead of `Stopped by user.`
- Existing checkpoints, source ids, notes, and resume semantics stay unchanged.

`Agent.resumeResearch(jobID)` remains for legacy jobs. Before creating a new assistant
message, it looks for a run step with `ref_id = jobID`; if found, it delegates to
`resumeRun(runID)` so the run ledger stays authoritative. The endpoint keeps returning
`{ message }` for the legacy path and adds `run` when it delegates. Standalone jobs keep the
old path.

## 10. Server API and events

### 10.1 Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/sessions/:id` | Add `runs: Run[]` (latest 20, including dismissed) to the existing response. The client hides the strip when the newest run is dismissed. |
| `GET` | `/api/runs/:id` | Return `{ run, steps, checkpoints }` for the trace view. |
| `POST` | `/api/runs/:id/resume` | Resume an interrupted/failed/user-aborted run. Return `202 { run }`. |
| `POST` | `/api/runs/:id/dismiss` | Set `dismissed_at` on a terminal/interrupted run. Return `{ run }`. |
| `POST` | `/api/sessions/:id/prompt` | Return `{ message, run }` instead of only `{ message }`. |
| `POST` | `/api/sessions/:id/abort` | Unchanged; the agent marks the run `aborted` with `stop_reason = "user"`. |
| `GET` | `/api/sessions/:id/research` | Unchanged. |

Error behavior:

- `404` for a missing run.
- `409` for an active run, a completed run, a dismissed run, or a budget-stopped run.
- `409` when the session already has an active run.

### 10.2 Events

Publish `run.created`, `run.updated`, and `run.step` from the agent. Throttle `run.updated`
during streaming to at most once per 500 ms; always publish the terminal update. `run.step` is
published on step creation, completion, retry, fallback, and error.

The existing bus broadcasts to every socket; the web client already filters by `sessionID`.

### 10.3 Startup and shutdown

- `startServer`: after opening the store, call `recoverInterruptedRuns()` and
  `expirePendingQuestions()` before creating the `Agent`. Keep the existing research recovery.
- `stop()`: make shutdown orderly. Change `WandeyServer.stop()` to return `Promise<void>`:
  1. Abort all active runs.
  2. Wait up to 2 seconds for their promises to settle.
  3. Mark any still-active runs `interrupted` with `stop_reason = "restart"`.
  4. Recover research jobs, stop the registry, stop the HTTP server, close the store.
- Update `src/cli/index.ts` and tests to `await server.stop()`.
- `Agent` keeps the promise for each active run so it can be drained. Add
  `activeRunCount()` and `drain(timeoutMs)`.

## 11. Web UI

### 11.1 New files

`web/runs.ts`:

- `renderRunStrip(run, handlers): HTMLElement`
- `openRunTrace({ runID, onClose }): Promise<RunTraceHandle>`
- `updateRunTrace(handle, run, steps)` for live `run.step` updates.

Use the existing `el`, `openModal`, `showToast`, `formatNumber`, and icon vocabulary.

### 11.2 Run strip

Insert `<section id="run-strip" class="run-strip" hidden></section>` between the topbar and
`#chat` in `web/index.html`.

The strip shows:

- Status label: Running, Waiting for you, Interrupted, Stopped, Failed, Complete.
- Model and elapsed time.
- A compact budget meter with one row per configured limit. Unlimited dimensions show only
  the used amount. Estimated tokens are prefixed with `~`.
- Actions:
  - `Trace` always.
  - `Resume` for `interrupted`, `failed`, and user-aborted runs.
  - `Dismiss` for terminal/interrupted runs.
- The error message, when present.

Run selection: prefer the active run, then the newest non-dismissed resumable run, then the
newest run. This keeps an interrupted run visible even if a later run completed. If the
selected run is dismissed, hide the strip rather than falling back to an older run.

A completed run remains visible until dismissed or until a newer active/resumable run takes its
place. This makes the trace easy to find without adding a permanent dashboard.

Add a small trace button in the topbar (`#run-trace-button`) that opens the selected run trace
when the strip is hidden.

### 11.3 Trace modal

The modal contains:

- Summary: status, stop reason, model, start time, active duration, total tokens, cost, tool
  calls, and crawl pages.
- Budget section with used/limit for each configured dimension.
- Steps table: ordinal, kind, name, model, status, attempt, duration, tokens, cost, pages,
  and error.
- Expandable `input`/`output` sections for each step.
- The linked research job id when `ref_id` is present.
- A note when usage was estimated.

While the run is running, `run.step` and `run.updated` events refresh the open modal. Do not
re-render the whole page for trace-only updates.

### 11.4 Client state and events

`web/api.ts`:

- Import `Run`, `RunStep`, `RunCheckpoint`.
- Add `runs: Run[]` to `LoadedSessionDetail`.
- Add `run(id)`, `resumeRun(id)`, and `dismissRun(id)` methods.
- Update `prompt()` to return `{ message, run }`.
- Update `resumeResearch()` to accept an optional `run` in its response.

`web/main.ts`:

- Add `els.runStrip` and `els.runTraceButton`.
- Add `renderRunStrip()` to `renderAll()`, `applySessionUpdate()`, and the run event cases.
- Handle `run.created`, `run.updated`, and `run.step` in `applyEvent`.
- Add `resumeRun(runID)`, `dismissRun(runID)`, and `openTrace(runID)`.
- On `loadSession`, store `detail.runs`.
- Keep the existing research card Resume button. The server delegates linked jobs to
  `resumeRun`, so the UI does not need a second resume path.

`web/styles.css`:

- `.run-strip`, `.run-strip-*`, `.run-budget`, `.run-budget-meter`, `.run-budget-row`.
- `.trace-modal`, `.trace-summary`, `.trace-steps`, `.trace-step`, `.trace-payload`.
- Responsive rules at the existing mobile breakpoints.
- Use the existing `--accent`, `--research`, `--success`, `--danger`, and `--warning` tokens.

## 12. File-by-file change list

| File | Change |
| --- | --- |
| `src/storage/schema.ts` | Add migration `2 -> 3`. |
| `src/storage/store.ts` | Run/step/checkpoint CRUD, recovery, question expiry, message deletion, usage reconciliation, unlinked job lookup, row mappers. |
| `src/core/types.ts` | Run types, checkpoint state, question `callID`, run WebSocket events. |
| `src/core/config.ts` | Budget/retry/fallback types, defaults, nested merge, normalization. |
| `src/agent/budget.ts` | New budget controller and `BudgetExceededError`. |
| `src/providers/retry.ts` | New retryability, backoff, `MidStreamError`, `streamWithFallback`. |
| `src/providers/registry.ts` | `modelInfo(ref)` lookup. |
| `src/agent/agent.ts` | Persisted run state machine, checkpoints, resume, step recording, budget wiring, tool idempotency, research delegation, drain. |
| `src/agent/history.ts` | No functional change expected; only adjust if resume needs a message exclusion. |
| `src/research/model.ts` | `complete()` with usage, shared retry/fallback, empty-response handling. |
| `src/research/engine.ts` | Observer hooks, budget checks, page deltas, job-created callback, abort reason. |
| `src/server/server.ts` | Recovery, session detail runs, run endpoints, events, async stop. |
| `src/cli/index.ts` | Await server stop, recover runs on chat start, optional run id in chat output. |
| `web/api.ts` | Run types and API methods. |
| `web/runs.ts` | New run strip and trace modal. |
| `web/main.ts` | Run state, events, resume/dismiss/trace handlers. |
| `web/index.html` | Run strip container and trace button. |
| `web/styles.css` | Run strip, budget meter, trace modal styles. |
| `README.md` | Budget/retry/fallback config and durable-run behavior. |
| `tests/store.test.ts` | Migration, run CRUD, recovery, checkpoint, dismissal. |
| `tests/runs.test.ts` | New agent lifecycle/resume tests with fake providers. |
| `tests/budget.test.ts` | New budget accounting/enforcement tests. |
| `tests/retry.test.ts` | New retry/fallback classification tests. |
| `tests/research.test.ts` | Observer, budget abort, linked resume tests. |
| `tests/provider-api.test.ts` | Run endpoints, session detail, events, async stop. |
| `scripts/smoke-runs.ts` | New live Beam Free lifecycle smoke test. |

## 13. Test plan

### 13.1 Deterministic tests (no network)

Use fake provider adapters and fake tools. These tests must not depend on Beam Free or any
remote API.

| Test | Assertion |
| --- | --- |
| Migration `2 -> 3` | An existing v2 DB with sessions/messages/research jobs opens, keeps data, and has the three new tables. |
| Run CRUD | Create/list/latest/update/dismiss/delete round-trips JSON budget and usage. |
| Recovery | `running`/`waiting` runs become `interrupted`; `running` steps become `failed`; completed runs are untouched. |
| Question expiry | Pending question parts become `expired`; answered ones are untouched. |
| Orphan cleanup | Empty assistant messages from a crash are deleted; assistant messages with error parts are kept. |
| Run creation | One prompt creates one run, one user message, and a `run.created` event. |
| Step recording | A tool loop records model and tool steps with stable keys and ordered ordinals. |
| Pre-content retry | A 429 on attempt 1 and success on attempt 2 produces one answer and two model-step attempts. |
| Fallback | A primary that always 429s falls through to the next model and records both refs. |
| Mid-stream failure | After a text delta, a provider error does not retry/fallback; the run is `interrupted`; the partial message exists. |
| Resume after partial | Resume deletes the partial assistant message, retries the same model step, and produces exactly one final answer. |
| Resume after tool | A fake tool loop interrupted after one tool skips that tool and runs the remaining one. |
| Deep-research link | The tool step gets `ref_id = job.id`; resume calls `ResearchEngine.resume` and does not create a second job. |
| Research resume fallback | If `ref_id` is missing, `findUnlinkedResearchJob` finds the job created by the tool. |
| Budget tokens | A low `maxTokens` stops the run with `stop_reason = "budget"` and a useful error. |
| Budget cost | Provider `usage.cost` wins; otherwise `ModelInfo.costPerMTok` is used. |
| Budget time | A low `maxSeconds` aborts the run and records active elapsed time. |
| Budget tools/pages | Tool-call and crawl-page limits stop before the next call. |
| Estimated usage | A provider with no usage produces estimated tokens and `usage.estimated = true`. |
| API | `GET /api/sessions/:id` includes runs; trace/resume/dismiss endpoints return the expected statuses. |
| Events | `run.created`, `run.updated`, and `run.step` are emitted with the right payloads. |
| Async shutdown | `stop()` aborts, drains, marks remaining runs interrupted, and closes cleanly. |

### 13.2 Live tests with Beam Free

Beam Free is `opencode-local/beam-free` and is text-only (`supportsTools: false`). Use it for
lifecycle, abort/resume, budget, and UI smoke tests. Use fake adapters for tool loops and
deterministic retry tests.

Run in an isolated home so the user's real database and config are untouched:

```sh
export WANDEY_HOME="$(mktemp -d)"
cat > "$WANDEY_HOME/config.json" <<'JSON'
{
  "integrations": { "opencode": false, "opencodeLocal": true },
  "agent": {
    "model": "opencode-local/beam-free",
    "budget": {
      "maxTokens": 0,
      "maxCostUsd": 0,
      "maxSeconds": 0,
      "maxToolCalls": 0,
      "maxCrawlPages": 0
    },
    "retry": { "attempts": 3, "baseDelayMs": 700 },
    "fallback": []
  }
}
JSON
bun run src/cli/index.ts serve --opencode-local --no-open --port 4329
```

The local OpenCode backend stays opt-in. Do not add free-tier headers or change provider
authentication behavior for these tests.

Live matrix:

1. **Short prompt** — send `Reply with exactly: ok`. Assert the run completes, has one
   model step, and the assistant text is `ok`. Usage may be absent; the trace should show
   estimated or zero usage without failing.
2. **Abort/resume** — send a request that streams for several seconds, abort after the first
   text delta, assert `aborted`/`user`, then resume. Assert the partial assistant message is
   gone and exactly one final answer remains.
3. **Restart/resume** — start a run, kill the server before completion, restart with the same
   `WANDEY_HOME`, assert the session shows an `interrupted` run, resume it, and assert it
   completes.
4. **Budget stop** — set a low `maxTokens` or `maxSeconds`, run a prompt, assert
   `aborted`/`budget`, the budget error is visible, and the trace records the usage.
5. **UI trace** — open the session in the browser, verify the run strip, budget meter,
   trace modal, step attempts, and resume/dismiss actions. Reconnect the WebSocket during a
   run and verify the strip resynchronizes from the session detail.
6. **Regression** — run the existing model picker, provider manager, local OpenCode toggle,
   and deep-research checkpoint tests. No behavior changes are expected.

### 13.3 Commands

```sh
bunx tsc --noEmit
bun test
bun run build:web
bun scripts/smoke-runs.ts --live
```

`smoke-runs.ts` should create its own temp `WANDEY_HOME`, print the run trace, and clean up.
It must never touch `~/.wandey`.

## 14. Acceptance criteria

- Existing databases migrate in place with no data loss.
- Every prompt creates a run with at least one model step and a terminal status.
- A server restart marks active runs resumable; resume completes without duplicate assistant
  messages.
- A mid-stream provider failure becomes `interrupted`, and resume retries the step.
- Pre-content errors retry and fall back in the configured order.
- All five budgets are enforced and visible in the run strip and trace.
- A `deep_research` step is linked to its research job and resumes that job instead of
  creating a duplicate.
- The trace modal shows every model attempt and tool call with usage, duration, and errors.
- The local OpenCode backend remains opt-in and unchanged.
- `bunx tsc --noEmit`, `bun test`, and `bun run build:web` pass.
- The Beam Free live matrix passes in an isolated `WANDEY_HOME`.

## 15. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Duplicated text after resume | Delete the partial assistant message before retrying a `model` checkpoint. Never retry after the first content event in the same attempt. |
| Duplicate research job | Update `run_step.ref_id` from the synchronous `onJobCreated` callback; use `findUnlinkedResearchJob` for the insert/callback crash window. |
| Double-counted usage | Treat provider usage as cumulative per step; reconcile from steps on resume. |
| SQLite write volume | Persist usage per step, throttle live `run.updated` events, and truncate trace payloads. |
| Large traces | Cap input/output sizes and store checkpoints as compact JSON. |
| Budget stop mid-stream | Abort with a typed reason, mark the step aborted, and preserve the trace. |
| Shutdown races | Make `stop()` async, drain active runs for up to 2 seconds, then recover. |
| Fallback without tools | Rebuild the request per candidate and run text-only when the candidate cannot use tools. |
| Old research jobs | Keep `resumeResearch` as the legacy path and delegate linked jobs to the run ledger. |

## 16. Commit sequence

Each commit must pass `bunx tsc --noEmit`, `bun test`, and `bun run build:web` where the
change affects the web bundle. Use author `Vidura Fernando <heyvidura@gmail.com>`.

1. `feat(storage): add durable run ledger` — migration, types, store methods, storage tests.
2. `feat(agent): record model and tool steps as runs` — run creation, step/usage recording,
   events, trace data; no resume behavior yet.
3. `feat(agent): resume interrupted runs from checkpoints` — checkpoints, partial-message
   deletion, tool/research idempotency, question expiry, run recovery.
4. `feat(agent): enforce run budgets` — budget config, controller, accounting, timer, budget
   stop behavior.
5. `feat(providers): retry and fall back across models` — retry helper, registry model info,
   agent and research integration, tests.
6. `feat(server): expose run controls and events` — run endpoints, session detail runs,
   startup/shutdown recovery, async stop.
7. `feat(web): show run status, budgets, and traces` — API client, run strip, trace modal,
   styles, live events.
8. `docs: document durable runs and budgets` — README, this milestone document, smoke-test
   instructions.
