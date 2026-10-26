import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import type {
  EvidenceNote,
  FetchedPage,
  Message,
  Part,
  PartType,
  ResearchDepth,
  ResearchJob,
  ResearchJobState,
  ResearchPlan,
  Run,
  RunBudget,
  RunCheckpoint,
  RunCheckpointState,
  RunStep,
  RunStepKind,
  RunStepStatus,
  RunStepUsage,
  RunStatus,
  RunStopReason,
  RunUsage,
  Session,
  SessionDetail,
  SessionMode,
  SourcePartData,
  Usage,
} from "../core/types.ts";
import { emptyRunUsage, normalizeRunBudget, normalizeRunUsage } from "../core/run-usage.ts";
import { newID, now } from "../core/util.ts";
import { canonicalURL as canonicalKey } from "../core/url.ts";
import { MIGRATIONS } from "./schema.ts";

/**
 * SQLite persistence. Synchronous on purpose: recent Bun versions ship a fast
 * embedded SQLite, calls are microseconds, and synchronous code removes a whole
 * class of "message saved after it was rendered" races from the agent loop.
 */
export class Store {
  readonly db: Database;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file, { create: true });
    this.db.run("pragma journal_mode = wal");
    this.db.run("pragma foreign_keys = on");
    this.db.run("pragma busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    const current = Number((this.db.query("pragma user_version").get() as { user_version?: number } | null)?.user_version ?? 0);
    for (let version = current; version < MIGRATIONS.length; version++) {
      const sql = MIGRATIONS[version]!;
      this.db.transaction(() => {
        this.db.run(sql);
        this.db.run(`pragma user_version = ${version + 1}`);
      })();
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  createSession(options: { title?: string; mode?: SessionMode; model?: string | null; parentID?: string | null } = {}): Session {
    const timestamp = now();
    const session: Session = {
      id: newID("ses"),
      title: options.title?.trim() || "New research",
      mode: options.mode ?? "chat",
      model: options.model ?? null,
      parentID: options.parentID ?? null,
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .query(
        `insert into session (id, title, mode, model, parent_id, archived, created_at, updated_at)
         values (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(session.id, session.title, session.mode, session.model, session.parentID, timestamp, timestamp);
    return session;
  }

  getSession(id: string): Session | null {
    const row = this.db.query("select * from session where id = ?").get(id) as SessionRow | null;
    return row ? rowToSession(row) : null;
  }

  listSessions(options: { limit?: number; includeArchived?: boolean; parentOnly?: boolean } = {}): Session[] {
    const clauses = [];
    if (!options.includeArchived) clauses.push("archived = 0");
    if (options.parentOnly) clauses.push("parent_id is null");
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const rows = this.db
      .query(`select * from session ${where} order by updated_at desc limit ?`)
      .all(options.limit ?? 100) as SessionRow[];
    return rows.map(rowToSession);
  }

  updateSession(id: string, patch: Partial<Pick<Session, "title" | "model" | "mode" | "archived">>): Session | null {
    const session = this.getSession(id);
    if (!session) return null;
    const next: Session = {
      ...session,
      ...patch,
      updatedAt: now(),
    };
    this.db
      .query("update session set title = ?, mode = ?, model = ?, archived = ?, updated_at = ? where id = ?")
      .run(next.title, next.mode, next.model, next.archived ? 1 : 0, next.updatedAt, id);
    return next;
  }

  touchSession(id: string): void {
    this.db.query("update session set updated_at = ? where id = ?").run(now(), id);
  }

  deleteSession(id: string): void {
    this.db.query("delete from session where id = ?").run(id);
  }

  // -------------------------------------------------------------------------
  // Messages and parts
  // -------------------------------------------------------------------------

  createMessage(sessionID: string, role: "user" | "assistant", model: string | null = null): Message {
    const message: Message = {
      id: newID("msg"),
      sessionID,
      role,
      model,
      error: null,
      finishReason: null,
      usage: null,
      createdAt: now(),
    };
    this.db
      .query(
        `insert into message (id, session_id, role, model, error, finish_reason, usage, created_at)
         values (?, ?, ?, ?, null, null, null, ?)`,
      )
      .run(message.id, message.sessionID, message.role, message.model, message.createdAt);
    this.touchSession(sessionID);
    return message;
  }

  getMessage(id: string): Message | null {
    const row = this.db.query("select * from message where id = ?").get(id) as MessageRow | null;
    return row ? rowToMessage(row) : null;
  }

  updateMessage(
    id: string,
    patch: Partial<Pick<Message, "error" | "finishReason" | "usage" | "model">>,
  ): Message | null {
    const message = this.getMessage(id);
    if (!message) return null;
    const next: Message = { ...message, ...patch };
    this.db
      .query("update message set model = ?, error = ?, finish_reason = ?, usage = ? where id = ?")
      .run(next.model, next.error, next.finishReason, next.usage ? JSON.stringify(next.usage) : null, id);
    return next;
  }

  addPart(sessionID: string, messageID: string, type: PartType, data: Part["data"]): Part {
    const orderRow = this.db
      .query("select coalesce(max(ord), -1) + 1 as next from part where message_id = ?")
      .get(messageID) as { next: number };
    const part = {
      id: newID("prt"),
      sessionID,
      messageID,
      order: orderRow?.next ?? 0,
      createdAt: now(),
      type,
      data,
    } as Part;
    this.db
      .query("insert into part (id, session_id, message_id, type, ord, data, created_at) values (?, ?, ?, ?, ?, ?, ?)")
      .run(part.id, sessionID, messageID, type, part.order, JSON.stringify(data), part.createdAt);
    return part;
  }

  updatePart(id: string, data: Part["data"]): Part | null {
    const row = this.db.query("select * from part where id = ?").get(id) as PartRow | null;
    if (!row) return null;
    this.db.query("update part set data = ? where id = ?").run(JSON.stringify(data), id);
    return rowToPart({ ...row, data: JSON.stringify(data) });
  }

  getPart(id: string): Part | null {
    const row = this.db.query("select * from part where id = ?").get(id) as PartRow | null;
    return row ? rowToPart(row) : null;
  }

  listParts(messageID: string): Part[] {
    const rows = this.db
      .query("select * from part where message_id = ? order by ord asc")
      .all(messageID) as PartRow[];
    return rows.map(rowToPart);
  }

  getSessionDetail(id: string): SessionDetail | null {
    const session = this.getSession(id);
    if (!session) return null;
    const messageRows = this.db
      .query("select * from message where session_id = ? order by created_at asc, rowid asc")
      .all(id) as MessageRow[];
    const messages = messageRows.map((row) => ({
      message: rowToMessage(row),
      parts: this.listParts(row.id),
    }));
    return { session, messages };
  }

  /** Conversation history in the compact shape providers need. */
  providerHistory(sessionID: string): Array<{ role: "user" | "assistant"; content: Part[] }> {
    const rows = this.db
      .query("select * from message where session_id = ? order by created_at asc, rowid asc")
      .all(sessionID) as MessageRow[];
    const output: Array<{ role: "user" | "assistant"; content: Part[] }> = [];
    for (const row of rows) {
      if (!row.role) continue;
      output.push({ role: row.role as "user" | "assistant", content: this.listParts(row.id) });
    }
    return output;
  }

  // -------------------------------------------------------------------------
  // Durable runs
  // -------------------------------------------------------------------------

  /** Run a group of synchronous writes atomically. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  createRun(options: {
    sessionID: string;
    userMessageID: string;
    prompt: string;
    mode: SessionMode;
    model: string | null;
    budget: RunBudget;
  }): Run {
    if (this.activeRun(options.sessionID)) {
      throw new Error("This session already has an active run.");
    }
    const timestamp = now();
    const run: Run = {
      id: newID("run"),
      sessionID: options.sessionID,
      userMessageID: options.userMessageID,
      assistantMessageID: null,
      status: "running",
      mode: options.mode,
      model: options.model,
      prompt: options.prompt,
      budget: normalizeRunBudget(options.budget),
      usage: emptyRunUsage(),
      error: null,
      stopReason: null,
      resumeCount: 0,
      startedAt: timestamp,
      updatedAt: timestamp,
      endedAt: null,
      dismissedAt: null,
    };
    this.db
      .query(
        `insert into run
         (id, session_id, user_message_id, assistant_message_id, status, mode, model, prompt,
          budget, usage, error, stop_reason, resume_count, started_at, updated_at, ended_at, dismissed_at)
         values (?, ?, ?, null, ?, ?, ?, ?, ?, ?, null, null, 0, ?, ?, null, null)`,
      )
      .run(
        run.id,
        run.sessionID,
        run.userMessageID,
        run.status,
        run.mode,
        run.model,
        run.prompt,
        JSON.stringify(run.budget),
        JSON.stringify(run.usage),
        run.startedAt,
        run.updatedAt,
      );
    return run;
  }

  getRun(id: string): Run | null {
    const row = this.db.query("select * from run where id = ?").get(id) as RunRow | null;
    return row ? rowToRun(row) : null;
  }

  listRuns(sessionID: string, options: { limit?: number; includeDismissed?: boolean } = {}): Run[] {
    const clauses = ["session_id = ?"];
    if (options.includeDismissed === false) clauses.push("dismissed_at is null");
    const rows = this.db
      .query(`select * from run where ${clauses.join(" and ")} order by started_at desc, rowid desc limit ?`)
      .all(sessionID, options.limit ?? 20) as RunRow[];
    return rows.map(rowToRun);
  }

  latestRun(sessionID: string, options: { includeDismissed?: boolean } = {}): Run | null {
    return this.listRuns(sessionID, { limit: 1, ...options })[0] ?? null;
  }

  activeRun(sessionID: string): Run | null {
    const row = this.db
      .query("select * from run where session_id = ? and status in ('running', 'waiting') order by started_at desc limit 1")
      .get(sessionID) as RunRow | null;
    return row ? rowToRun(row) : null;
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<
        Run,
        | "assistantMessageID"
        | "status"
        | "model"
        | "usage"
        | "error"
        | "stopReason"
        | "endedAt"
        | "dismissedAt"
      >
    > & { resumeCount?: number },
  ): Run | null {
    const run = this.getRun(id);
    if (!run) return null;
    const next: Run = {
      ...run,
      ...patch,
      usage: patch.usage ?? run.usage,
      resumeCount: patch.resumeCount ?? run.resumeCount,
      updatedAt: now(),
    };
    this.db
      .query(
        `update run
         set assistant_message_id = ?, status = ?, model = ?, usage = ?, error = ?, stop_reason = ?,
             resume_count = ?, updated_at = ?, ended_at = ?, dismissed_at = ?
         where id = ?`,
      )
      .run(
        next.assistantMessageID,
        next.status,
        next.model,
        JSON.stringify(next.usage),
        next.error,
        next.stopReason,
        next.resumeCount,
        next.updatedAt,
        next.endedAt,
        next.dismissedAt,
        id,
      );
    return next;
  }

  /**
   * A process that died mid-run cannot still be running. Mark those runs
   * resumable and close any steps that were in flight.
   */
  recoverInterruptedRuns(message = "Interrupted by a server restart. Resume it to continue."): number {
    const rows = this.db
      .query("select id from run where status in ('running', 'waiting')")
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return 0;
    const timestamp = now();
    this.transaction(() => {
      this.db
        .query(
          `update run
           set status = 'interrupted', stop_reason = 'restart', error = coalesce(error, ?),
               ended_at = coalesce(ended_at, ?), updated_at = ?
           where status in ('running', 'waiting')`,
        )
        .run(message, timestamp, timestamp);
      this.db
        .query(
          `update run_step
           set status = 'failed', error = coalesce(error, ?), ended_at = coalesce(ended_at, ?), updated_at = ?
           where status = 'running'`,
        )
        .run(message, timestamp, timestamp);
    });
    return rows.length;
  }

  dismissRun(id: string): Run | null {
    const run = this.getRun(id);
    if (!run) return null;
    return this.updateRun(id, { dismissedAt: now() });
  }

  deleteRun(id: string): void {
    this.db.query("delete from run where id = ?").run(id);
  }

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
  }): RunStep {
    const ordinalRow = this.db
      .query("select coalesce(max(ordinal), -1) + 1 as next from run_step where run_id = ?")
      .get(options.runID) as { next: number };
    const timestamp = now();
    const step: RunStep = {
      id: newID("stp"),
      runID: options.runID,
      stepKey: options.stepKey,
      ordinal: ordinalRow?.next ?? 0,
      kind: options.kind,
      name: options.name,
      status: "running",
      attempt: options.attempt ?? 1,
      model: options.model ?? null,
      messageID: options.messageID ?? null,
      callID: options.callID ?? null,
      refID: options.refID ?? null,
      title: options.title ?? null,
      input: options.input ?? null,
      output: null,
      usage: null,
      crawlPages: 0,
      error: null,
      startedAt: timestamp,
      endedAt: null,
      updatedAt: timestamp,
    };
    try {
      this.db
        .query(
          `insert into run_step
           (id, run_id, step_key, ordinal, kind, name, status, attempt, model, message_id, call_id,
            ref_id, title, input, output, usage, crawl_pages, error, started_at, ended_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, 0, null, ?, null, ?)`,
        )
        .run(
          step.id,
          step.runID,
          step.stepKey,
          step.ordinal,
          step.kind,
          step.name,
          step.status,
          step.attempt,
          step.model,
          step.messageID,
          step.callID,
          step.refID,
          step.title,
          step.input,
          step.startedAt,
          step.updatedAt,
        );
    } catch (err) {
      if (/unique/i.test((err as Error).message)) {
        throw new Error(`Run step ${options.stepKey} already has attempt ${step.attempt}.`);
      }
      throw err;
    }
    return step;
  }

  updateRunStep(
    id: string,
    patch: Partial<
      Pick<
        RunStep,
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
      >
    >,
  ): RunStep | null {
    const step = this.getRunStep(id);
    if (!step) return null;
    const next: RunStep = { ...step, ...patch, updatedAt: now() };
    this.db
      .query(
        `update run_step
         set status = ?, model = ?, message_id = ?, ref_id = ?, title = ?, input = ?, output = ?,
             usage = ?, crawl_pages = ?, error = ?, ended_at = ?, updated_at = ?
         where id = ?`,
      )
      .run(
        next.status,
        next.model,
        next.messageID,
        next.refID,
        next.title,
        next.input,
        next.output,
        next.usage ? JSON.stringify(next.usage) : null,
        next.crawlPages,
        next.error,
        next.endedAt,
        next.updatedAt,
        id,
      );
    return next;
  }

  getRunStep(id: string): RunStep | null {
    const row = this.db.query("select * from run_step where id = ?").get(id) as RunStepRow | null;
    return row ? rowToRunStep(row) : null;
  }

  latestRunStep(runID: string, stepKey: string): RunStep | null {
    const row = this.db
      .query("select * from run_step where run_id = ? and step_key = ? order by attempt desc limit 1")
      .get(runID, stepKey) as RunStepRow | null;
    return row ? rowToRunStep(row) : null;
  }

  findRunStepByRef(refID: string): RunStep | null {
    const row = this.db
      .query("select * from run_step where ref_id = ? order by started_at desc limit 1")
      .get(refID) as RunStepRow | null;
    return row ? rowToRunStep(row) : null;
  }

  listRunSteps(runID: string): RunStep[] {
    const rows = this.db
      .query("select * from run_step where run_id = ? order by ordinal asc, attempt asc")
      .all(runID) as RunStepRow[];
    return rows.map(rowToRunStep);
  }

  createRunCheckpoint(runID: string, state: RunCheckpointState): RunCheckpoint {
    const timestamp = now();
    const checkpoint = this.transaction(() => {
      const seqRow = this.db
        .query("select coalesce(max(seq), -1) + 1 as next from run_checkpoint where run_id = ?")
        .get(runID) as { next: number };
      const next: RunCheckpoint = {
        id: newID("ckp"),
        runID,
        seq: seqRow?.next ?? 0,
        state,
        createdAt: timestamp,
      };
      this.db
        .query("insert into run_checkpoint (id, run_id, seq, state, created_at) values (?, ?, ?, ?, ?)")
        .run(next.id, next.runID, next.seq, JSON.stringify(next.state), next.createdAt);
      return next;
    });
    return checkpoint;
  }

  latestRunCheckpoint(runID: string): RunCheckpoint | null {
    const row = this.db
      .query("select * from run_checkpoint where run_id = ? order by seq desc limit 1")
      .get(runID) as RunCheckpointRow | null;
    return row ? rowToRunCheckpoint(row) : null;
  }

  listRunCheckpoints(runID: string): RunCheckpoint[] {
    const rows = this.db
      .query("select * from run_checkpoint where run_id = ? order by seq asc")
      .all(runID) as RunCheckpointRow[];
    return rows.map(rowToRunCheckpoint);
  }

  /** Delete a message and its parts, e.g. a partial stream before a retry. */
  deleteMessage(id: string): void {
    this.db.query("delete from message where id = ?").run(id);
  }

  /** Remove empty assistant messages left by a crash between insert and checkpoint. */
  deleteEmptyAssistantMessages(sessionID: string): number {
    const rows = this.db
      .query(
        `select id from message
         where session_id = ? and role = 'assistant'
           and not exists (select 1 from part where part.message_id = message.id)`,
      )
      .all(sessionID) as Array<{ id: string }>;
    for (const row of rows) this.deleteMessage(row.id);
    return rows.length;
  }

  /** Mark unanswered question parts expired after a restart. */
  expirePendingQuestions(_message = "Interrupted by a server restart."): number {
    const rows = this.db.query("select * from part where type = 'question'").all() as PartRow[];
    let expired = 0;
    for (const row of rows) {
      const part = rowToPart(row);
      if (part.type !== "question" || part.data.status !== "pending") continue;
      this.updatePart(part.id, { ...part.data, status: "expired" });
      expired++;
    }
    return expired;
  }

  /** Reconcile the run usage row from persisted step usage. */
  sumRunUsage(runID: string): RunUsage {
    const run = this.getRun(runID);
    const usage = emptyRunUsage();
    if (!run) return usage;
    const toolKeys = new Set<string>();
    for (const step of this.listRunSteps(runID)) {
      if (step.usage) {
        usage.inputTokens += step.usage.input ?? 0;
        usage.outputTokens += step.usage.output ?? 0;
        usage.totalTokens += step.usage.total ?? (step.usage.input ?? 0) + (step.usage.output ?? 0);
        usage.costUsd += step.usage.cost ?? 0;
        usage.estimated = usage.estimated || step.usage.estimated === true;
      }
      usage.crawlPages += step.crawlPages;
      if (step.kind === "tool" && step.status === "completed") toolKeys.add(step.stepKey);
    }
    usage.toolCalls = toolKeys.size;
    usage.elapsedMs = run.usage.elapsedMs;
    return usage;
  }

  /**
   * Crash-window fallback: find the newest research job for this session and
   * question that is not linked from any run step.
   */
  findUnlinkedResearchJob(sessionID: string, question: string, since: number): ResearchJob | null {
    const row = this.db
      .query(
        `select * from research_job
         where session_id = ? and question = ? and created_at >= ?
           and id not in (select ref_id from run_step where ref_id is not null)
         order by created_at desc limit 1`,
      )
      .get(sessionID, question, since) as ResearchJobRow | null;
    return row ? rowToResearchJob(row) : null;
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  addSource(sessionID: string, page: FetchedPage): { source: SourcePartData; isNew: boolean } {
    const existing = this.db
      .query("select id, url, title, site from source where session_id = ? and canonical_url = ?")
      .get(sessionID, canonicalKey(page.finalUrl || page.url)) as
      | { id: string; url: string; title: string; site: string }
      | null;
    if (existing) {
      const source: SourcePartData = {
        sourceID: existing.id,
        url: existing.url,
        title: existing.title,
        site: existing.site,
      };
      return { source, isNew: false };
    }

    const countRow = this.db
      .query("select count(*) as count from source where session_id = ?")
      .get(sessionID) as { count: number };
    const id = `s${(countRow?.count ?? 0) + 1}`;
    const snippet = makeSnippet(page.text || page.markdown);
    const site = page.site || safeSite(page.finalUrl || page.url);

    this.db
      .query(
        `insert into source
         (id, session_id, url, canonical_url, title, site, snippet, text, content, status, words, via, meta, fetched_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionID,
        page.finalUrl || page.url,
        canonicalKey(page.finalUrl || page.url),
        page.title || page.finalUrl,
        site,
        snippet,
        page.text.slice(0, 400_000),
        page.markdown.slice(0, 500_000),
        page.status,
        page.words,
        page.via,
        JSON.stringify({ requestedUrl: page.url, fromCache: page.fromCache ?? false }),
        page.fetchedAt,
      );

    return {
      source: { sourceID: id, url: page.finalUrl || page.url, title: page.title || page.finalUrl, site, snippet },
      isNew: true,
    };
  }

  getSource(sessionID: string, sourceID: string): (SourcePartData & { text: string; content: string; fetchedAt: number }) | null {
    const row = this.db
      .query("select * from source where session_id = ? and id = ?")
      .get(sessionID, sourceID) as SourceRow | null;
    if (!row) return null;
    return {
      sourceID: row.id,
      url: row.url,
      title: row.title,
      site: row.site,
      text: row.text,
      content: row.content,
      fetchedAt: row.fetched_at,
    };
  }

  listSources(sessionID: string): SourcePartData[] {
    const rows = this.db
      .query("select id, url, title, site, snippet from source where session_id = ? order by fetched_at asc")
      .all(sessionID) as Array<{ id: string; url: string; title: string; site: string; snippet: string }>;
    return rows.map((row) => ({
      sourceID: row.id,
      url: row.url,
      title: row.title,
      site: row.site,
      snippet: row.snippet,
    }));
  }

  findSourceByURL(sessionID: string, url: string): string | null {
    const row = this.db
      .query("select id from source where session_id = ? and canonical_url = ?")
      .get(sessionID, canonicalKey(url)) as { id: string } | null;
    return row?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Research
  // -------------------------------------------------------------------------

  createResearchJob(options: { sessionID: string; question: string; depth: ResearchDepth }): ResearchJob {
    const timestamp = now();
    const job: ResearchJob = {
      id: newID("job"),
      sessionID: options.sessionID,
      question: options.question,
      depth: options.depth,
      status: "pending",
      plan: null,
      report: null,
      error: null,
      outputPath: null,
      state: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .query(
        `insert into research_job (id, session_id, question, depth, status, plan, report, error, output_path, state, created_at, updated_at)
         values (?, ?, ?, ?, ?, null, null, null, null, null, ?, ?)`,
      )
      .run(job.id, job.sessionID, job.question, job.depth, job.status, timestamp, timestamp);
    return job;
  }

  updateResearchJob(
    id: string,
    patch: Partial<Pick<ResearchJob, "status" | "plan" | "report" | "error" | "outputPath" | "state">>,
  ): ResearchJob | null {
    const job = this.getResearchJob(id);
    if (!job) return null;
    const next: ResearchJob = { ...job, ...patch, updatedAt: now() };
    this.db
      .query(
        "update research_job set status = ?, plan = ?, report = ?, error = ?, output_path = ?, state = ?, updated_at = ? where id = ?",
      )
      .run(
        next.status,
        next.plan ? JSON.stringify(next.plan) : null,
        next.report,
        next.error,
        next.outputPath,
        next.state ? JSON.stringify(next.state) : null,
        next.updatedAt,
        id,
      );
    return next;
  }

  /**
   * A process that died mid-research cannot still be running. Mark those jobs
   * resumable on the next boot instead of leaving the UI stuck on "running".
   */
  recoverInterruptedResearchJobs(message = "Interrupted by a server restart. Resume it to continue."): number {
    const jobs = this.db
      .query("select id, session_id from research_job where status in ('pending', 'running')")
      .all() as Array<{ id: string; session_id: string }>;
    if (jobs.length === 0) return 0;

    this.db
      .query(
        `update research_job
         set status = 'aborted', error = coalesce(error, ?), updated_at = ?
         where status in ('pending', 'running')`,
      )
      .run(message, now());

    // The job row is what powers Resume; the part is what the conversation
    // renders. Mark live research cards interrupted too, otherwise a restart
    // leaves an endless "running" card with no Resume button.
    for (const job of jobs) {
      for (const part of this.listResearchParts(job.session_id, job.id)) {
        if (part.type !== "research" || part.data.status !== "running") continue;
        this.updatePart(part.id, {
          ...part.data,
          status: "error" as const,
          error: message,
          progress: {
            ...part.data.progress,
            stage: "error" as const,
            message,
            current: [],
          },
        });
      }
    }
    return jobs.length;
  }

  /** All research parts for a job, newest first. */
  listResearchParts(sessionID: string, jobID: string): Part[] {
    const rows = this.db
      .query("select * from part where session_id = ? and type = 'research' order by created_at desc")
      .all(sessionID) as PartRow[];
    const output: Part[] = [];
    for (const row of rows) {
      const part = rowToPart(row);
      if (part.type === "research" && part.data.jobID === jobID) output.push(part);
    }
    return output;
  }

  /** Find the latest research part for a job, used to recover legacy progress. */
  findResearchPart(sessionID: string, jobID: string): Part | null {
    return this.listResearchParts(sessionID, jobID)[0] ?? null;
  }

  getResearchJob(id: string): ResearchJob | null {
    const row = this.db.query("select * from research_job where id = ?").get(id) as ResearchJobRow | null;
    return row ? rowToResearchJob(row) : null;
  }

  listResearchJobs(sessionID: string): ResearchJob[] {
    const rows = this.db
      .query("select * from research_job where session_id = ? order by created_at desc")
      .all(sessionID) as ResearchJobRow[];
    return rows.map(rowToResearchJob);
  }

  addNotes(notes: EvidenceNote[]): void {
    if (notes.length === 0) return;
    const insert = this.db.query(
      `insert into research_note
       (id, session_id, job_id, claim, quote, source_id, source_title, source_url, sub_question_id, confidence, round, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const note of notes) {
        insert.run(
          note.id,
          note.sessionID,
          note.jobID,
          note.claim,
          note.quote,
          note.sourceID,
          note.sourceTitle,
          note.sourceURL,
          note.subQuestionID,
          note.confidence,
          note.round,
          now(),
        );
      }
    })();
  }

  listNotes(jobID: string): EvidenceNote[] {
    const rows = this.db
      .query("select * from research_note where job_id = ? order by created_at asc")
      .all(jobID) as NoteRow[];
    return rows.map(rowToNote);
  }

  // -------------------------------------------------------------------------
  // Key-value settings (small, UI-facing preferences)
  // -------------------------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.query("select value from kv where key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .query("insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
      .run(key, value);
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  title: string;
  mode: string;
  model: string | null;
  parent_id: string | null;
  archived: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  model: string | null;
  error: string | null;
  finish_reason: string | null;
  usage: string | null;
  created_at: number;
}

interface PartRow {
  id: string;
  session_id: string;
  message_id: string;
  type: string;
  ord: number;
  data: string;
  created_at: number;
}

interface SourceRow {
  id: string;
  session_id: string;
  url: string;
  canonical_url: string;
  title: string;
  site: string;
  snippet: string;
  text: string;
  content: string;
  status: number;
  words: number;
  via: string;
  meta: string | null;
  fetched_at: number;
}

interface ResearchJobRow {
  id: string;
  session_id: string;
  question: string;
  depth: string;
  status: string;
  plan: string | null;
  report: string | null;
  error: string | null;
  output_path: string | null;
  state: string | null;
  created_at: number;
  updated_at: number;
}

interface NoteRow {
  id: string;
  session_id: string;
  job_id: string;
  claim: string;
  quote: string;
  source_id: string;
  source_title: string;
  source_url: string;
  sub_question_id: string;
  confidence: string;
  round: number;
  created_at: number;
}

interface RunRow {
  id: string;
  session_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  status: string;
  mode: string;
  model: string | null;
  prompt: string;
  budget: string;
  usage: string;
  error: string | null;
  stop_reason: string | null;
  resume_count: number;
  started_at: number;
  updated_at: number;
  ended_at: number | null;
  dismissed_at: number | null;
}

interface RunStepRow {
  id: string;
  run_id: string;
  step_key: string;
  ordinal: number;
  kind: string;
  name: string;
  status: string;
  attempt: number;
  model: string | null;
  message_id: string | null;
  call_id: string | null;
  ref_id: string | null;
  title: string | null;
  input: string | null;
  output: string | null;
  usage: string | null;
  crawl_pages: number;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  updated_at: number;
}

interface RunCheckpointRow {
  id: string;
  run_id: string;
  seq: number;
  state: string;
  created_at: number;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    mode: (row.mode as SessionMode) ?? "chat",
    model: row.model,
    parentID: row.parent_id,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionID: row.session_id,
    role: row.role as "user" | "assistant",
    model: row.model,
    error: row.error,
    finishReason: row.finish_reason as Message["finishReason"],
    usage: row.usage ? (JSON.parse(row.usage) as Usage) : null,
    createdAt: row.created_at,
  };
}

function rowToPart(row: PartRow): Part {
  return {
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
    order: row.ord,
    createdAt: row.created_at,
    type: row.type,
    data: JSON.parse(row.data),
  } as Part;
}

function rowToResearchJob(row: ResearchJobRow): ResearchJob {
  return {
    id: row.id,
    sessionID: row.session_id,
    question: row.question,
    depth: row.depth as ResearchDepth,
    status: row.status as ResearchJob["status"],
    plan: row.plan ? (JSON.parse(row.plan) as ResearchPlan) : null,
    report: row.report,
    error: row.error,
    outputPath: row.output_path,
    state: row.state ? (JSON.parse(row.state) as ResearchJobState) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToNote(row: NoteRow): EvidenceNote {
  return {
    id: row.id,
    sessionID: row.session_id,
    jobID: row.job_id,
    claim: row.claim,
    quote: row.quote,
    sourceID: row.source_id,
    sourceTitle: row.source_title,
    sourceURL: row.source_url,
    subQuestionID: row.sub_question_id,
    confidence: row.confidence as EvidenceNote["confidence"],
    round: row.round,
  };
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    sessionID: row.session_id,
    userMessageID: row.user_message_id,
    assistantMessageID: row.assistant_message_id,
    status: row.status as RunStatus,
    mode: (row.mode as SessionMode) ?? "chat",
    model: row.model,
    prompt: row.prompt,
    budget: normalizeRunBudget(safeJSON<RunBudget>(row.budget)),
    usage: normalizeRunUsage(safeJSON<RunUsage>(row.usage)),
    error: row.error,
    stopReason: row.stop_reason as RunStopReason | null,
    resumeCount: row.resume_count,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    dismissedAt: row.dismissed_at,
  };
}

function rowToRunStep(row: RunStepRow): RunStep {
  return {
    id: row.id,
    runID: row.run_id,
    stepKey: row.step_key,
    ordinal: row.ordinal,
    kind: row.kind as RunStepKind,
    name: row.name,
    status: row.status as RunStepStatus,
    attempt: row.attempt,
    model: row.model,
    messageID: row.message_id,
    callID: row.call_id,
    refID: row.ref_id,
    title: row.title,
    input: row.input,
    output: row.output,
    usage: row.usage ? (safeJSON<RunStepUsage>(row.usage) ?? null) : null,
    crawlPages: row.crawl_pages,
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
  };
}

function rowToRunCheckpoint(row: RunCheckpointRow): RunCheckpoint {
  return {
    id: row.id,
    runID: row.run_id,
    seq: row.seq,
    state: safeJSON<RunCheckpointState>(row.state) ?? {
      version: 1,
      loopStep: 0,
      phase: "model",
      assistantMessageID: null,
      modelStepID: null,
      toolCalls: [],
      nextToolIndex: 0,
    },
    createdAt: row.created_at,
  };
}

function safeJSON<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function safeSite(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function makeSnippet(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
