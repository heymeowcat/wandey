import type { EvidenceNote, ResearchPlan, SourcePartData } from "../core/types.ts";
import { truncate } from "../core/util.ts";

/**
 * Citation handling.
 *
 * Models cite sources in slightly different shapes: [s1], [S1], [s1, s3], or
 * invent an id. The report is only useful if every id in it maps to a source the
 * agent actually read, so citations are normalised and validated in one place.
 */

const CITATION = /\[([^\[\]]*\b[sS]\d+\b[^\[\]]*)\]/g;

export function normalizeCitations(
  markdown: string,
  validIDs: Set<string>,
): { text: string; cited: string[] } {
  const cited = new Set<string>();
  const text = markdown.replace(CITATION, (_match, group: string) => {
    const ids = new Set<string>();
    for (const match of group.matchAll(/\b[sS](\d+)\b/g)) {
      const id = `s${match[1]}`;
      if (validIDs.has(id)) ids.add(id);
    }
    if (ids.size === 0) return "";
    for (const id of ids) cited.add(id);
    return [...ids].map((id) => `[${id}]`).join("");
  });

  return { text: tidy(text), cited: [...cited] };
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+([.,;:!?)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sourcesSection(sources: SourcePartData[], cited: string[]): string {
  const wanted = cited.length > 0 ? new Set(cited) : new Set(sources.map((source) => source.sourceID));
  const selected = sources
    .filter((source) => wanted.has(source.sourceID))
    .sort((a, b) => sourceNumber(a.sourceID) - sourceNumber(b.sourceID));
  if (selected.length === 0) return "";

  const lines = selected.map((source) => {
    const title = source.title.replace(/\s+/g, " ").trim() || source.url;
    return `${sourceNumber(source.sourceID)}. [${source.sourceID}] ${title} — ${source.url}`;
  });
  return `\n\n---\n\n## Sources\n\n${lines.join("\n")}\n`;
}

function sourceNumber(id: string): number {
  const value = Number.parseInt(id.replace(/\D/g, ""), 10);
  return Number.isFinite(value) ? value : 9999;
}

/** A deterministic report used when the synthesis model fails or returns junk. */
export function fallbackReport(options: {
  question: string;
  plan: ResearchPlan;
  notes: EvidenceNote[];
  sources: SourcePartData[];
}): string {
  const { question, plan, notes, sources } = options;
  const title = truncate(plan.restatedQuestion || question, 110);
  const byQuestion = new Map<string, EvidenceNote[]>();
  for (const note of notes) {
    const list = byQuestion.get(note.subQuestionID) ?? [];
    list.push(note);
    byQuestion.set(note.subQuestionID, list);
  }

  const lines = [
    `# ${title}`,
    "",
    "_The synthesis model did not return a usable report, so Wandey assembled this summary directly from the evidence notes. Treat it as a briefing, not a polished deliverable._",
    "",
    "## Key evidence",
  ];

  const topNotes = notes.slice(0, 18);
  if (topNotes.length === 0) {
    lines.push("- No extractable evidence was collected. See the limitations below.");
  } else {
    for (const note of topNotes) {
      lines.push(`- ${note.claim} [${note.sourceID}]`);
    }
  }

  lines.push("", "## Evidence by sub-question");
  for (const sub of plan.subQuestions) {
    const list = byQuestion.get(sub.id) ?? [];
    lines.push("", `### ${sub.question}`, "");
    if (list.length === 0) {
      lines.push("- No supported notes were extracted for this sub-question.");
      continue;
    }
    for (const note of list.slice(0, 10)) {
      lines.push(`- ${note.claim} [${note.sourceID}]`);
    }
  }

  lines.push(
    "",
    "## Limitations",
    `- This report covers ${sources.length} saved source(s) and ${notes.length} extracted note(s).`,
    "- Claims are limited to what those sources state; the evidence was not independently verified.",
    "- Where sources are missing or weak, the corresponding question remains open.",
  );

  return lines.join("\n");
}

export function ensureTitle(markdown: string, question: string): string {
  const trimmed = markdown.trim();
  if (/^#\s+\S/m.test(trimmed)) return trimmed;
  return `# ${truncate(question, 100)}\n\n${trimmed}`;
}
