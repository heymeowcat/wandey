import { describe, expect, test } from "bun:test";
import { ollamaCloudID } from "../src/providers/openai.ts";

describe("ollamaCloudID", () => {
  test("adds the cloud tag to untagged model families", () => {
    expect(ollamaCloudID("beam")).toBe("beam:cloud");
    expect(ollamaCloudID("minimax-m3.1-flash")).toBe("minimax-m3.1-flash:cloud");
  });

  test("uses Ollama's size-suffixed cloud convention", () => {
    expect(ollamaCloudID("gpt-oss:20b")).toBe("gpt-oss:20b-cloud");
    expect(ollamaCloudID("gpt-oss:120b")).toBe("gpt-oss:120b-cloud");
    expect(ollamaCloudID("gemma4:31b")).toBe("gemma4:31b-cloud");
  });

  test("collapses digest-like catalog variants to the family", () => {
    expect(ollamaCloudID("deepseek-v4.1-flash:1017")).toBe("deepseek-v4.1-flash:cloud");
    expect(ollamaCloudID("deepseek-v4-pro:0813")).toBe("deepseek-v4-pro:cloud");
  });

  test("leaves already-cloud model names unchanged", () => {
    expect(ollamaCloudID("minimax-m3.1-flash:cloud")).toBe("minimax-m3.1-flash:cloud");
    expect(ollamaCloudID("gpt-oss:20b-cloud")).toBe("gpt-oss:20b-cloud");
  });
});
