import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../core/config.ts";
import { expandHome } from "../core/config.ts";
import type { EventBus } from "../core/events.ts";
import type {
  EvidenceNote,
  FetchedPage,
  Part,
  ResearchDepth,
  ResearchJob,
  ResearchPartData,
  ResearchPlan,
  ResearchProgress,
  SourcePartData,
  SubQuestion,
} from "../core/types.ts";
import { canonicalURL, hostOf } from "../core/url.ts";
import { mapLimit, newID, now, slugify, truncate } from "../core/util.ts";
import type { PageFetcher } from "../crawl/fetcher.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { SearchService } from "../search/search.ts";
import type { Store } from "../storage/store.ts";
import { ensureTitle, fallbackReport, normalizeCitations, sourcesSection } from "./citations.ts";
import { ResearchModel } from "./model.ts";
import { extractionPrompt, gapPrompt, notesDigest, plannerPrompt, synthesisPrompt } from "./prompts.ts";

/**
 * Deep research.
 *
 * The pipeline is deliberately visible rather than magic:
 *
 *   plan -> search -> read -> extract -> (gap -> search -> read -> extract)*
 *        -> synthesize -> write files
 *
 * Each stage is bounded by config.research limits, runs searches and page reads
 * concurrently, and persists a note for every claim it intends to use. The
 * synthesis prompt only sees those notes, which is what makes citations auditable
 * rather than decorative.
 */

export interface ResearchEngineDeps {
  config: Config;
  store: Store;
  registry: ProviderRegistry;
  search: SearchService;
  fetcher: PageFetcher;
  bus: EventBus;
}

export interface ResearchInput {
  sessionID: string;
  messageID: string;
  question: string;
  depth?: ResearchDepth;
  /** Model resolved for the active chat session. */
  model?: string;
  signal?: AbortSignal;
}

export interface ResearchOutcome {
  job: ResearchJob;
  plan: ResearchPlan;
  report: string;
  outputPath: string;
  sources: SourcePartData[];
  cited: string[];
  notes: number;
  warnings: string[];
}

interface Settings {
  rounds: number;
  breadth: number;
  resultsPerQuery: number;
  pagesPerSubQuestion: number;
  maxSources: number;
  maxSubQuestions: number;
  workers: number;
  maxReportChars: number;
  outputDir: string;
}

interface Candidate {
  url: string;
  title: string;
  snippet: string;
  provider: string;
  publishedAt?: string;
  subQuestionIDs: Set<string>;
}

interface PageRecord {
  page: FetchedPage;
  source: SourcePartData;
}

const DEPTH_SCALE: Record<ResearchDepth, number> = {
  quick: 0.5,
  standard: 1,
  deep: 1.5,
  exhaustive: 2,
};

export class ResearchEngine {
  constructor(private readonly deps: ResearchEngineDeps) {}

  async run(input: ResearchInput): Promise<ResearchOutcome> {
    const question = input.question.replace(/\s+/g, " ").trim();
    if (!question) throw new Error("Research question is empty");
    const depth = input.depth ?? this.deps.config.research.depth;
    if (!(depth in DEPTH_SCALE)) throw new Error(`Unknown research depth "${depth}"`);

    const model = await this.pickModel(input.model);
    const settings = settingsFor(this.deps.config, depth);
    const job = this.deps.store.createResearchJob({ sessionID: input.sessionID, question, depth });

    const progress: ResearchProgress = {
      stage: "planning",
      message: "Planning the investigation",
      subQuestionsDone: 0,
      subQuestionsTotal: 0,
      sourcesFound: 0,
      pagesFetched: 0,
      round: 0,
      roundTotal: settings.rounds,
      current: [],
    };
    const data: ResearchPartData = {
      jobID: job.id,
      question,
      depth,
      status: "running",
      progress,
    };
    const part = this.deps.store.addPart(input.sessionID, input.messageID, "research", data);
    this.deps.bus.publish({ type: "part.created", sessionID: input.sessionID, messageID: input.messageID, part });

    const run = new ResearchRun(this.deps, input, job, part, data, settings, model);
    return run.execute();
  }

  private async pickModel(requested?: string): Promise<string> {
    const configured =
      requested?.trim() ||
      this.deps.config.research.workerModel.trim() ||
      this.deps.config.agent.model.trim();
    if (configured) return configured;
    const fallback = await this.deps.registry.defaultModel();
    if (!fallback) {
      throw new Error("No model is available for deep research. Configure a provider or set agent.model.");
    }
    return fallback;
  }
}

class ResearchRun {
  private readonly progress: ResearchProgress;
  private readonly data: ResearchPartData;
  private readonly settings: Settings;
  private readonly job: ResearchJob;
  private readonly signal?: AbortSignal;
  private readonly planModel: ResearchModel;
  private readonly workerModel: ResearchModel;
  private readonly synthModel: ResearchModel;

  private plan: ResearchPlan | null = null;
  private readonly allQuestions: SubQuestion[] = [];
  private readonly candidates = new Map<string, Candidate>();
  private readonly pages = new Map<string, PageRecord>();
  private readonly sources = new Map<string, SourcePartData>();
  private readonly sourceParts = new Set<string>();
  private readonly notes: EvidenceNote[] = [];
  private readonly completed = new Set<string>();
  private readonly active = new Set<string>();
  private readonly warnings = new Set<string>();

  constructor(
    private readonly deps: ResearchEngineDeps,
    private readonly input: ResearchInput,
    job: ResearchJob,
    private readonly part: Part,
    data: ResearchPartData,
    settings: Settings,
    model: string,
  ) {
    this.job = job;
    this.data = data;
    this.progress = data.progress;
    this.settings = settings;
    this.signal = input.signal;
    this.planModel = new ResearchModel(deps.registry, deps.config.research.planModel.trim() || model);
    this.workerModel = new ResearchModel(deps.registry, deps.config.research.workerModel.trim() || model);
    this.synthModel = new ResearchModel(deps.registry, deps.config.research.synthModel.trim() || model);
  }

  async execute(): Promise<ResearchOutcome> {
    try {
      this.progressNow("planning", "Planning sub-questions");
      this.plan = await this.makePlan();
      this.allQuestions.push(...this.plan.subQuestions);
      this.progress.subQuestionsTotal = this.allQuestions.length;

      let questions = this.plan.subQuestions;
      for (let round = 1; round <= this.settings.rounds; round++) {
        this.throwIfAborted();
        this.progress.round = round;
        this.progressNow("searching", `Round ${round}/${this.settings.rounds}: searching`);

        await this.discover(questions);
        const selected = this.selectForFetch(questions);
        await this.fetchPages(selected);
        await this.extractEvidence(questions, round);

        if (round >= this.settings.rounds) break;
        const followUps = await this.findGaps(round);
        if (followUps.length === 0) break;
        questions = followUps;
        this.allQuestions.push(...followUps);
        this.progress.subQuestionsTotal = this.allQuestions.length;
      }

      this.throwIfAborted();
      if (this.pages.size === 0) {
        throw new Error(
          `No pages could be read${this.warnings.size > 0 ? `: ${[...this.warnings].slice(0, 3).join("; ")}` : ""}`,
        );
      }

      const { report, cited } = await this.synthesize();
      const outputPath = await this.writeOutput(report);

      const updated = this.deps.store.updateResearchJob(this.job.id, {
        status: "done",
        plan: this.plan,
        report,
        outputPath,
      }) ?? { ...this.job, status: "done" as const, plan: this.plan, report, outputPath };

      this.data.status = "done";
      this.data.report = report;
      this.progressNow("done", "Research complete");

      return {
        job: updated,
        plan: this.plan,
        report,
        outputPath,
        sources: [...this.sources.values()],
        cited,
        notes: this.notes.length,
        warnings: [...this.warnings],
      };
    } catch (err) {
      const aborted = this.signal?.aborted || (err as Error)?.name === "AbortError";
      const message = aborted ? "Stopped by user." : (err as Error).message;
      this.deps.store.updateResearchJob(this.job.id, {
        status: aborted ? "aborted" : "error",
        plan: this.plan,
        error: message,
      });
      this.data.status = "error";
      this.data.error = message;
      this.progressNow("error", message);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  private async makePlan(): Promise<ResearchPlan> {
    const { system, prompt } = plannerPrompt({
      question: this.input.question,
      depth: this.job.depth,
      subQuestionCount: this.settings.maxSubQuestions,
      queriesPerSubQuestion: Math.max(2, Math.min(3, this.settings.breadth)),
    });

    let parsed: { restatedQuestion?: unknown; scope?: unknown; subQuestions?: unknown } | null = null;
    try {
      parsed = await this.planModel.json({ system, prompt, temperature: 0.2, signal: this.signal });
    } catch (err) {
      this.throwIfAborted(err);
      this.warn(`Planner failed: ${(err as Error).message}`);
    }

    const subQuestions = normalizeSubQuestions(
      parsed?.subQuestions,
      "q",
      this.settings.maxSubQuestions,
      this.input.question,
    );
    const plan: ResearchPlan = {
      restatedQuestion: stringValue(parsed?.restatedQuestion) || this.input.question,
      scope: stringValue(parsed?.scope) || "Public web sources relevant to the question.",
      subQuestions: subQuestions.length > 0 ? subQuestions : fallbackPlan(this.input.question),
    };
    this.progressNow("planning", `Planned ${plan.subQuestions.length} sub-questions`);
    return plan;
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  private async discover(questions: SubQuestion[]): Promise<void> {
    const perQuestion = Math.max(1, Math.min(this.settings.breadth, 6));
    await mapLimit(questions, this.settings.workers, async (question) => {
      for (const query of question.queries.slice(0, perQuestion)) {
        this.throwIfAborted();
        await this.track(`search: ${truncate(query, 44)}`, async () => {
          try {
            const response = await this.deps.search.search(query, {
              count: this.settings.resultsPerQuery,
              signal: this.signal,
            });
            for (const warning of response.warnings) this.warn(warning);
            for (const result of response.results) this.addCandidate(result, question.id);
            this.progress.sourcesFound = this.candidates.size;
            this.progressNow("searching", `Found ${this.candidates.size} candidate sources`);
          } catch (err) {
            this.throwIfAborted(err);
            this.warn(`Search failed for "${query}": ${(err as Error).message}`);
          }
        });
      }
    });
  }

  private addCandidate(
    result: { title: string; url: string; snippet: string; provider: string; publishedAt?: string },
    subQuestionID: string,
  ): void {
    let url: string;
    try {
      const parsed = new URL(result.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      url = canonicalURL(result.url);
    } catch {
      return;
    }
    const existing = this.candidates.get(url);
    if (existing) {
      existing.subQuestionIDs.add(subQuestionID);
      return;
    }
    if (this.candidates.size >= this.settings.maxSources) return;
    this.candidates.set(url, {
      url,
      title: result.title.trim() || url,
      snippet: result.snippet.trim(),
      provider: result.provider,
      publishedAt: result.publishedAt,
      subQuestionIDs: new Set([subQuestionID]),
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  private selectForFetch(questions: SubQuestion[]): Candidate[] {
    const selected: Candidate[] = [];
    const chosen = new Set<string>();
    const budget = Math.min(this.settings.maxSources, this.settings.pagesPerSubQuestion * Math.max(1, questions.length));

    for (const question of questions) {
      let count = 0;
      for (const candidate of this.candidates.values()) {
        if (count >= this.settings.pagesPerSubQuestion) break;
        if (selected.length >= budget) break;
        if (chosen.has(candidate.url) || this.pages.has(candidate.url)) continue;
        if (!candidate.subQuestionIDs.has(question.id)) continue;
        selected.push(candidate);
        chosen.add(candidate.url);
        count++;
      }
      if (selected.length >= budget) break;
    }
    return selected;
  }

  private async fetchPages(selected: Candidate[]): Promise<void> {
    if (selected.length === 0) {
      this.warn("No fetchable search results were found.");
      return;
    }
    this.progressNow("crawling", `Reading ${selected.length} pages`);
    const concurrency = Math.max(1, Math.min(this.settings.workers, this.deps.config.crawl.concurrency));

    await mapLimit(selected, concurrency, async (candidate) => {
      this.throwIfAborted();
      await this.track(`read: ${hostOf(candidate.url)}`, async () => {
        try {
          const page = await this.deps.fetcher.fetch(candidate.url, {
            signal: this.signal,
            maxChars: this.deps.config.crawl.maxCharsPerPage,
          });
          if (page.error) {
            this.warn(`Fetch failed: ${candidate.url} — ${page.error}`);
            return;
          }
          if (page.markdown.trim().length < 120 && page.words < 15) {
            this.warn(`Skipped thin page: ${candidate.url}`);
            return;
          }
          const added = this.deps.store.addSource(this.input.sessionID, page);
          this.pages.set(candidate.url, { page, source: added.source });
          this.sources.set(added.source.sourceID, added.source);
          this.progress.pagesFetched = this.pages.size;

          if (!this.sourceParts.has(added.source.sourceID)) {
            this.sourceParts.add(added.source.sourceID);
            const part = this.deps.store.addPart(this.input.sessionID, this.input.messageID, "source", added.source);
            this.deps.bus.publish({
              type: "part.created",
              sessionID: this.input.sessionID,
              messageID: this.input.messageID,
              part,
            });
          }
          this.progressNow("crawling", `Read ${this.pages.size} pages`);
        } catch (err) {
          this.throwIfAborted(err);
          this.warn(`Read failed: ${candidate.url} — ${(err as Error).message}`);
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Evidence extraction
  // -------------------------------------------------------------------------

  private async extractEvidence(questions: SubQuestion[], round: number): Promise<void> {
    this.progressNow("extracting", "Extracting evidence");
    await mapLimit(questions, this.settings.workers, async (question) => {
      this.throwIfAborted();
      const records = this.recordsFor(question);
      if (records.length === 0) {
        this.completed.add(question.id);
        this.progress.subQuestionsDone = this.completed.size;
        return;
      }

      const documents = buildDocuments(records, 24_000);
      const { system, prompt } = extractionPrompt({ subQuestion: question, round, documents });

      let parsed: { notes?: unknown } | null = null;
      try {
        parsed = await this.workerModel.json({
          system,
          prompt,
          temperature: 0.1,
          signal: this.signal,
        });
      } catch (err) {
        this.throwIfAborted(err);
        this.warn(`Extraction failed for "${truncate(question.question, 80)}": ${(err as Error).message}`);
      }

      const allowed = new Map(records.map((record) => [record.source.sourceID, record.source]));
      let notes = normalizeNotes(parsed?.notes, question, round, allowed, this.input.sessionID, this.job.id);
      if (notes.length === 0) notes = fallbackNotes(records, question, round, this.input.sessionID, this.job.id);

      if (notes.length > 0) {
        this.deps.store.addNotes(notes);
        this.notes.push(...notes);
      }
      this.completed.add(question.id);
      this.progress.subQuestionsDone = this.completed.size;
      this.progressNow("extracting", `${this.notes.length} evidence notes from ${this.pages.size} pages`);
    });
  }

  private recordsFor(question: SubQuestion): PageRecord[] {
    const records: PageRecord[] = [];
    for (const candidate of this.candidates.values()) {
      if (records.length >= this.settings.pagesPerSubQuestion) break;
      if (!candidate.subQuestionIDs.has(question.id)) continue;
      const record = this.pages.get(candidate.url);
      if (record) records.push(record);
    }
    return records;
  }

  // -------------------------------------------------------------------------
  // Gaps
  // -------------------------------------------------------------------------

  private async findGaps(round: number): Promise<SubQuestion[]> {
    this.progressNow("analyzing", "Looking for evidence gaps");
    const { system, prompt } = gapPrompt({
      question: this.input.question,
      plan: this.plan!,
      asked: this.allQuestions,
      notes: this.notes,
      round,
      maxQuestions: 3,
    });

    try {
      const parsed = await this.planModel.json<{ subQuestions?: unknown }>({
        system,
        prompt,
        temperature: 0.3,
        signal: this.signal,
      });
      const followUps = normalizeSubQuestions(
        parsed?.subQuestions,
        `r${round + 1}`,
        3,
        this.input.question,
      ).filter((question) => !this.allQuestions.some((asked) => sameQuestion(asked.question, question.question)));
      if (followUps.length > 0) {
        this.progressNow("analyzing", `${followUps.length} follow-up questions`);
      }
      return followUps;
    } catch (err) {
      this.throwIfAborted(err);
      this.warn(`Gap analysis failed: ${(err as Error).message}`);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Synthesis and output
  // -------------------------------------------------------------------------

  private async synthesize(): Promise<{ report: string; cited: string[] }> {
    this.progressNow("synthesizing", "Writing the report");
    const sourceList = [...this.sources.values()]
      .map((source) => `- [${source.sourceID}] ${source.title} — ${source.url}`)
      .join("\n");
    const { system, prompt } = synthesisPrompt({
      question: this.input.question,
      plan: this.plan!,
      depth: this.job.depth,
      evidence: notesDigest(this.notes, Math.max(20_000, Math.min(55_000, this.settings.maxReportChars))),
      sources: sourceList,
      maxChars: this.settings.maxReportChars,
    });

    let raw = "";
    try {
      raw = await this.synthModel.text({ system, prompt, temperature: 0.35, signal: this.signal });
    } catch (err) {
      this.throwIfAborted(err);
      this.warn(`Synthesis failed: ${(err as Error).message}`);
    }

    let report = raw.trim()
      ? ensureTitle(raw.trim(), this.input.question)
      : fallbackReport({
          question: this.input.question,
          plan: this.plan!,
          notes: this.notes,
          sources: [...this.sources.values()],
        });

    if (report.length > this.settings.maxReportChars) {
      report = `${report.slice(0, this.settings.maxReportChars).trimEnd()}\n\n_(Report truncated at the configured limit.)_`;
    }

    const { text, cited } = normalizeCitations(report, new Set(this.sources.keys()));
    const verified = `${text}${sourcesSection([...this.sources.values()], cited)}`;
    return { report: verified, cited };
  }

  private async writeOutput(report: string): Promise<string> {
    const dir = path.resolve(expandHome(this.settings.outputDir) || path.join(os.homedir(), ".wandey", "research"));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const base = `${slugify(this.input.question, 52)}-${stamp}-${this.job.id.slice(-4)}`;
    const markdownPath = path.join(dir, `${base}.md`);
    const jsonPath = path.join(dir, `${base}.json`);

    await Bun.write(markdownPath, `${report}\n`);
    await Bun.write(
      jsonPath,
      `${JSON.stringify(
        {
          job: this.job.id,
          question: this.input.question,
          depth: this.job.depth,
          plan: this.plan,
          notes: this.notes,
          sources: [...this.sources.values()],
          warnings: [...this.warnings],
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    return markdownPath;
  }

  // -------------------------------------------------------------------------
  // Progress, abort, and small helpers
  // -------------------------------------------------------------------------

  private progressNow(stage: ResearchProgress["stage"], message: string): void {
    this.progress.stage = stage;
    this.progress.message = message;
    this.progress.current = [...this.active].slice(0, 8);
    this.data.progress = { ...this.progress, current: [...this.progress.current] };

    const saved = this.deps.store.updatePart(this.part.id, this.data);
    if (!saved) return;
    this.deps.bus.publish({ type: "part.updated", sessionID: this.input.sessionID, part: saved });
    this.deps.bus.publish({ type: "research.progress", sessionID: this.input.sessionID, part: saved });
  }

  private async track<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.active.add(label);
    try {
      return await fn();
    } finally {
      this.active.delete(label);
    }
  }

  private warn(message: string): void {
    if (message.trim()) this.warnings.add(message.trim());
  }

  private throwIfAborted(err?: unknown): void {
    if (this.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (err && (err as Error)?.name === "AbortError") throw err;
  }

}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function settingsFor(config: Config, depth: ResearchDepth): Settings {
  const scale = DEPTH_SCALE[depth];
  const research = config.research;
  return {
    rounds: clamp(Math.round(research.rounds * scale), 1, 6),
    breadth: clamp(Math.round(research.breadth * scale), 1, 8),
    resultsPerQuery: clamp(research.resultsPerQuery, 3, 20),
    pagesPerSubQuestion: clamp(Math.round(research.pagesPerSubQuestion * scale), 2, 12),
    maxSources: clamp(Math.round(research.maxSources * scale), 4, 300),
    maxSubQuestions: clamp(Math.round(research.breadth * scale) + 1, 3, 8),
    workers: clamp(research.workers, 1, 8),
    maxReportChars: clamp(research.maxReportChars, 4_000, 120_000),
    outputDir: research.outputDir,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function fallbackPlan(question: string): SubQuestion[] {
  const base = question.replace(/[?.!]+$/, "").trim();
  return [
    {
      id: "q1",
      question: `What are the key facts about ${base}?`,
      queries: [base, `${base} primary sources`],
      rationale: "Establish the factual baseline.",
    },
    {
      id: "q2",
      question: `What does recent evidence say about ${base}?`,
      queries: [`${base} recent evidence`, `${base} analysis`],
      rationale: "Find current evidence and analysis.",
    },
    {
      id: "q3",
      question: `What are the limitations, risks, or disagreements around ${base}?`,
      queries: [`${base} criticism`, `${base} limitations risks`],
      rationale: "Surface counter-evidence and uncertainty.",
    },
  ];
}

function normalizeSubQuestions(
  raw: unknown,
  prefix: string,
  limit: number,
  fallbackQuestion: string,
): SubQuestion[] {
  const rows = Array.isArray(raw) ? raw : [];
  const output: SubQuestion[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (output.length >= limit) break;
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const question = stringValue(record.question) || stringValue(record.q);
    if (!question || seen.has(sameKey(question))) continue;
    seen.add(sameKey(question));

    const queries = Array.isArray(record.queries)
      ? record.queries.map(stringValue).filter((query) => query.length > 2)
      : [];
    const uniqueQueries = [...new Set(queries.map((query) => query.trim()))].slice(0, 4);
    if (uniqueQueries.length === 0) {
      uniqueQueries.push(truncate(`${question} ${fallbackQuestion}`, 180));
    }

    output.push({
      id: `${prefix}${output.length + 1}`,
      question,
      queries: uniqueQueries,
      rationale: stringValue(record.rationale) || undefined,
    });
  }
  return output;
}

function normalizeNotes(
  raw: unknown,
  question: SubQuestion,
  round: number,
  allowed: Map<string, SourcePartData>,
  sessionID: string,
  jobID: string,
): EvidenceNote[] {
  const rows = Array.isArray(raw) ? raw : [];
  const notes: EvidenceNote[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const claim = truncate(stringValue(record.claim), 600);
    if (!claim || seen.has(claim.toLowerCase())) continue;

    const sourceID = normalizeSourceID(stringValue(record.sourceID) || stringValue(record.sourceId));
    const source = sourceID ? allowed.get(sourceID) : undefined;
    if (!sourceID || !source) continue;
    seen.add(claim.toLowerCase());

    const confidenceRaw = stringValue(record.confidence).toLowerCase();
    const confidence = confidenceRaw === "high" || confidenceRaw === "low" ? confidenceRaw : "medium";
    notes.push({
      id: newID("note"),
      sessionID,
      jobID,
      claim,
      quote: truncate(stringValue(record.quote), 420),
      sourceID,
      sourceTitle: source.title,
      sourceURL: source.url,
      subQuestionID: question.id,
      confidence,
      round,
    });
    if (notes.length >= 12) break;
  }
  return notes;
}

function fallbackNotes(
  records: PageRecord[],
  question: SubQuestion,
  round: number,
  sessionID: string,
  jobID: string,
): EvidenceNote[] {
  return records.slice(0, 3).map(({ page, source }) => {
    const excerpt = truncate(
      (page.excerpt || page.markdown || page.text).replace(/\s+/g, " ").trim(),
      300,
    );
    return {
      id: newID("note"),
      sessionID,
      jobID,
      claim: `${source.title} reports: ${excerpt}`,
      quote: excerpt,
      sourceID: source.sourceID,
      sourceTitle: source.title,
      sourceURL: source.url,
      subQuestionID: question.id,
      confidence: "low" as const,
      round,
    };
  });
}

function buildDocuments(records: PageRecord[], budget: number): string {
  const blocks: string[] = [];
  let used = 0;
  for (const { page, source } of records) {
    const body = truncate((page.markdown || page.text).trim(), 7_000);
    if (body.length < 120) continue;
    const block = `<source id="${source.sourceID}" title="${escapeAttribute(source.title)}" url="${escapeAttribute(source.url)}">\n${body}\n</source>`;
    if (used + block.length > budget && blocks.length > 0) break;
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.join("\n\n");
}

function normalizeSourceID(raw: string): string | null {
  const clean = raw.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/^#/, "").toLowerCase();
  if (!clean) return null;
  const digits = clean.match(/^s?(\d+)$/)?.[1];
  return digits ? `s${digits}` : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sameQuestion(a: string, b: string): boolean {
  return sameKey(a) === sameKey(b);
}

function sameKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
