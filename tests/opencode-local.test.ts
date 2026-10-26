import { describe, expect, test } from "bun:test";
import {
  buildModelCatalog,
  buildOpenCodePrompt,
  freeModelInfo,
  mapOpenCodeFinish,
  OPENCODE_AGENT_CONFIG,
  reasoningFromOpenCodeContent,
  selectFreeOpenCodeModelIDs,
  textFromOpenCodeContent,
} from "../src/providers/opencode-local.ts";

describe("OpenCode local models", () => {
  test("keeps only free ids and falls back to known free models", () => {
    expect(
      selectFreeOpenCodeModelIDs(["big-pickle", "claude-sonnet-5", "deepseek-v4.1-flash-free"]),
    ).toEqual(["big-pickle", "deepseek-v4.1-flash-free"]);
    expect(selectFreeOpenCodeModelIDs(["claude-sonnet-5"])).toContain("big-pickle");
  });

  test("marks models free and text-only", () => {
    expect(freeModelInfo("big-pickle")).toMatchObject({
      id: "big-pickle",
      provider: "opencode-local",
      ref: "opencode-local/big-pickle",
      supportsTools: false,
      free: true,
    });
  });

  test("builds a free-only catalog the isolated runtime can resolve", () => {
    const catalog = buildModelCatalog(["big-pickle", "claude-sonnet-5", "deepseek-v4.1-flash-free"]);
    const provider = catalog.opencode as Record<string, unknown>;
    expect(provider).toMatchObject({
      id: "opencode",
      name: "OpenCode",
      api: "https://opencode.ai/inference/openai/v1",
      npm: "@ai-sdk/openai-compatible",
      env: ["OPENCODE_API_KEY"],
    });

    const models = provider.models as Record<string, Record<string, unknown>>;
    expect(Object.keys(models).sort()).toEqual(["big-pickle", "deepseek-v4.1-flash-free"]);
    expect(models["deepseek-v4.1-flash-free"]).toMatchObject({
      name: "DeepSeek V4.1 Flash Free",
      tool_call: true,
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      limit: { context: 200_000, output: 32_000 },
    });
    expect(models["big-pickle"]).toMatchObject({ limit: { context: 200_000, output: 32_000 } });
  });
});

describe("OpenCode local agent", () => {
  test("keeps read-only tools and denies tools that can change the system", () => {
    const agent = OPENCODE_AGENT_CONFIG.agent["wandey-text"];
    expect(agent.steps).toBe(2);
    expect(agent.permission).toMatchObject({
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      bash: "deny",
      edit: "deny",
      task: "deny",
      external_directory: "deny",
      todowrite: "deny",
      question: "deny",
      webfetch: "deny",
      websearch: "deny",
      lsp: "deny",
      doom_loop: "deny",
      skill: "deny",
      browser: "deny",
    });
    expect(agent.tools).toMatchObject({ bash: false, edit: false, webfetch: false, websearch: false });
  });
});

describe("OpenCode local prompt", () => {
  test("folds system and conversation into a text-only prompt", () => {
    const prompt = buildOpenCodePrompt({
      system: "Be concise.",
      messages: [
        { role: "user", content: [{ type: "text", text: "What is Wandey?" }] },
        { role: "assistant", content: [{ type: "text", text: "A research agent." }] },
        { role: "user", content: [{ type: "text", text: "What does it use for search?" }] },
      ],
    });
    expect(prompt).toContain("Be concise.");
    expect(prompt).toContain("User:\nWhat is Wandey?");
    expect(prompt).toContain("Assistant:\nA research agent.");
    expect(prompt).toContain("Tools are unavailable");
  });

  test("does not replay internal reasoning", () => {
    const prompt = buildOpenCodePrompt({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "secret chain of thought" },
            { type: "text", text: "Visible answer." },
          ],
        },
      ],
    });
    expect(prompt).not.toContain("secret chain of thought");
    expect(prompt).toContain("Visible answer.");
  });
});

describe("OpenCode local content", () => {
  test("extracts text and reasoning separately", () => {
    const content = [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "answer" },
    ];
    expect(textFromOpenCodeContent(content)).toBe("answer");
    expect(reasoningFromOpenCodeContent(content)).toBe("thinking");
  });

  test("maps finish states and treats tool-calls as a stop", () => {
    expect(mapOpenCodeFinish("length")).toBe("length");
    expect(mapOpenCodeFinish("error")).toBe("error");
    expect(mapOpenCodeFinish("tool-calls")).toBe("stop");
    expect(mapOpenCodeFinish("stop")).toBe("stop");
  });
});
