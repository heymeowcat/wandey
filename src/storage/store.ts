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
  ResearchPlan,
  Session,
  SessionDetail,
  SessionMode,
  SourcePartData,
  Usage,
} from "../core/types.ts";
import { newID, now } from "../core/util.ts";
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
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .query(
        `insert into research_job (id, session_id, question, depth, status, plan, report, error, output_path, created_at, updated_at)
         values (?, ?, ?, ?, ?, null, null, null, null, ?, ?)`,
      )
      .run(job.id, job.sessionID, job.question, job.depth, job.status, timestamp, timestamp);
    return job;
  }

  updateResearchJob(
    id: string,
    patch: Partial<Pick<ResearchJob, "status" | "plan" | "report" | "error" | "outputPath">>,
  ): ResearchJob | null {
    const job = this.getResearchJob(id);
    if (!job) return null;
    const next: ResearchJob = { ...job, ...patch, updatedAt: now() };
    this.db
      .query(
        "update research_job set status = ?, plan = ?, report = ?, error = ?, output_path = ?, updated_at = ? where id = ?",
      )
      .run(
        next.status,
        next.plan ? JSON.stringify(next.plan) : null,
        next.report,
        next.error,
        next.outputPath,
        next.updatedAt,
        id,
      );
    return next;
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

function canonicalKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    // Strip common tracking params so the same page is cached once.
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|ref_src|source)$/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return url;
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
