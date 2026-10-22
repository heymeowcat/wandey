import { describe, expect, test } from "bun:test";
import type { EvidenceNote, ResearchPlan, SourcePartData } from "../src/core/types.ts";
import {
  ensureTitle,
  fallbackReport,
  normalizeCitations,
  sourcesSection,
} from "../src/research/citations.ts";

const sources: SourcePartData[] = [
  { sourceID: "s1", url: "https://one.test/a", title: "One" },
  { sourceID: "s2", url: "https://two.test/b", title: "Two" },
  { sourceID: "s3", url: "https://three.test/c", title: "Three" },
];

const plan: ResearchPlan = {
  restatedQuestion: "What changed?",
  scope: "A short test plan.",
  subQuestions: [
    { id: "q1", question: "What is the first thing?", queries: ["first thing"] },
    { id: "q2", question: "What is the second thing?", queries: ["second thing"] },
  ],
};

const notes: EvidenceNote[] = [
  {
    id: "note1",
    sessionID: "ses_test",
    jobID: "job_test",
    claim: "The first thing is supported.",
    quote: "First thing quote.",
    sourceID: "s1",
    sourceTitle: "One",
    sourceURL: "https://one.test/a",
    subQuestionID: "q1",
    confidence: "high",
    round: 1,
  },
  {
    id: "note2",
    sessionID: "ses_test",
    jobID: "job_test",
    claim: "The second thing is contested.",
    quote: "Second thing quote.",
    sourceID: "s2",
    sourceTitle: "Two",
    sourceURL: "https://two.test/b",
    subQuestionID: "q2",
    confidence: "medium",
    round: 2,
  },
];

describe("normalizeCitations", () => {
  test("normalises ids, drops unknown sources, and tracks what was cited", () => {
    const result = normalizeCitations("A [s1], B [S2], C [s9], D [s1, s3].", new Set(["s1", "s2", "s3"]));
    expect(result.text).toBe("A [s1], B [s2], C, D [s1][s3].");
    expect(result.cited).toEqual(["s1", "s2", "s3"]);
  });

  test("removes invalid-only citations without leaving punctuation debris", () => {
    const result = normalizeCitations("No supported claim [s9].", new Set(["s1"]));
    expect(result.text).toBe("No supported claim.");
    expect(result.cited).toEqual([]);
  });

  test("keeps valid ids from a mixed citation group", () => {
    const result = normalizeCitations("Only one is real [s2, nope].", new Set(["s1", "s2"]));
    expect(result.text).toBe("Only one is real [s2].");
    expect(result.cited).toEqual(["s2"]);
  });
});

describe("sourcesSection", () => {
  test("lists only cited sources, sorted by source number", () => {
    const section = sourcesSection(sources, ["s3", "s1"]);
    expect(section).toContain("[s1] One");
    expect(section).toContain("[s3] Three");
    expect(section).not.toContain("[s2] Two");
    expect(section.indexOf("[s1]")).toBeLessThan(section.indexOf("[s3]"));
  });

  test("lists every source when the report made no citations", () => {
    const section = sourcesSection(sources, []);
    expect(section).toContain("[s1]");
    expect(section).toContain("[s2]");
    expect(section).toContain("[s3]");
  });

  test("returns nothing when nothing can be listed", () => {
    expect(sourcesSection([], [])).toBe("");
  });
});

describe("fallbackReport", () => {
  test("builds a deterministic, citable briefing from the evidence notes", () => {
    const report = fallbackReport({ question: "What changed?", plan, notes, sources });
    expect(report).toContain("# What changed?");
    expect(report).toContain("The first thing is supported. [s1]");
    expect(report).toContain("The second thing is contested. [s2]");
    expect(report).toContain("### What is the first thing?");
    expect(report).toContain("## Limitations");
  });

  test("explains when there is no evidence", () => {
    const report = fallbackReport({ question: "What changed?", plan, notes: [], sources: [] });
    expect(report).toContain("No extractable evidence was collected");
    expect(report).toContain("0 saved source(s) and 0 extracted note(s)");
  });
});

describe("ensureTitle", () => {
  test("keeps an existing title", () => {
    expect(ensureTitle("# Existing\n\nBody", "Question")).toBe("# Existing\n\nBody");
  });

  test("adds a title when the report has none", () => {
    expect(ensureTitle("Body only.", "A long question")).toBe("# A long question\n\nBody only.");
  });
});
