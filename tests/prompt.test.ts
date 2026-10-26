import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { DEFAULTS } from "../src/core/config.ts";
import type { Session } from "../src/core/types.ts";
import { ToolRegistry } from "../src/tools/types.ts";

const session: Session = {
  id: "ses_test",
  title: "Test",
  mode: "chat",
  model: "opencode-local/big-pickle",
  parentID: null,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
};

function tools(): ToolRegistry {
  return new ToolRegistry()
    .register({
      name: "web_search",
      description: "Search the web.",
      parameters: { type: "object" },
      execute: async () => ({ title: "search", output: "" }),
    })
    .register({
      name: "deep_research",
      description: "Run deep research.",
      parameters: { type: "object" },
      execute: async () => ({ title: "research", output: "" }),
    });
}

describe("buildSystemPrompt", () => {
  test("describes tools and citations when tools are enabled", () => {
    const prompt = buildSystemPrompt({ config: DEFAULTS, session, tools: tools() });
    expect(prompt).toContain("You have: web_search, deep_research");
    expect(prompt).toContain("Search first.");
    expect(prompt).toContain("Every non-obvious factual claim needs an inline citation");
    expect(prompt).toContain("## Web safety");
    expect(prompt).toContain("## Deep research");
  });

  test("removes tool instructions for text-only models", () => {
    const prompt = buildSystemPrompt({
      config: DEFAULTS,
      session,
      tools: tools(),
      toolsEnabled: false,
    });
    expect(prompt).toContain("You have no tools in this session.");
    expect(prompt).toContain("Do not invent sources, citations, or browsing results.");
    expect(prompt).not.toContain("You have: web_search");
    expect(prompt).not.toContain("Search first.");
    expect(prompt).not.toContain("## Web safety");
    expect(prompt).not.toContain("## Deep research");
  });

  test("warns that research mode cannot browse without tools", () => {
    const prompt = buildSystemPrompt({
      config: DEFAULTS,
      session: { ...session, mode: "research" },
      tools: tools(),
      toolsEnabled: false,
    });
    expect(prompt).toContain("This model cannot browse or call tools in this session.");
    expect(prompt).not.toContain("call deep_research first");
  });
});
