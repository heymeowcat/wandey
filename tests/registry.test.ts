import { describe, expect, test } from "bun:test";
import { DEFAULTS } from "../src/core/config.ts";
import { isOpenCodeFreeModel } from "../src/providers/openai.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";

function registryWithProviders(providers: typeof DEFAULTS.providers): ProviderRegistry {
  const config = structuredClone(DEFAULTS);
  config.integrations = { opencode: false, opencodeLocal: false };
  config.providers = providers;
  return new ProviderRegistry(config, { importOpenCode: false });
}

describe("provider catalog", () => {
  test("keeps disabled custom providers visible", () => {
    const registry = registryWithProviders({
      "my-proxy": {
        enabled: false,
        kind: "openai",
        name: "My Proxy",
        baseUrl: "https://proxy.example/v1",
        models: ["model-a"],
      },
    });
    const entry = registry.catalog().find((item) => item.id === "my-proxy");
    expect(entry).toMatchObject({
      id: "my-proxy",
      name: "My Proxy",
      custom: true,
      configured: true,
      disabled: true,
      connected: false,
      keyStored: false,
      modelCount: 0,
      models: ["model-a"],
    });
  });

  test("marks auto-discovered local servers separately from explicit failures", () => {
    const registry = registryWithProviders({
      ollama: {
        kind: "openai",
        baseUrl: "http://127.0.0.1:11434/v1",
        local: true,
        auto: "local",
      },
      custom: {
        kind: "openai",
        name: "Custom",
        baseUrl: "http://127.0.0.1:9999/v1",
      },
    });
    const catalog = registry.catalog();
    expect(catalog.find((item) => item.id === "ollama")).toMatchObject({
      auto: "local",
      local: true,
      configured: true,
      disabled: false,
    });
    expect(catalog.find((item) => item.id === "custom")).toMatchObject({
      auto: undefined,
      custom: true,
      configured: true,
      disabled: false,
    });
  });

  test("keeps disabled built-in providers in the catalog", () => {
    const registry = registryWithProviders({
      openai: { enabled: false, kind: "openai", name: "OpenAI" },
    });
    const entry = registry.catalog().find((item) => item.id === "openai");
    expect(entry).toMatchObject({
      id: "openai",
      custom: false,
      configured: true,
      disabled: true,
      connected: false,
      keyStored: false,
    });
  });
});

describe("OpenCode local integration", () => {
  test("is opt-in and stays out of the provider catalog", async () => {
    const disabled = structuredClone(DEFAULTS);
    disabled.integrations = { opencode: false, opencodeLocal: false };
    disabled.providers = {};
    const off = new ProviderRegistry(disabled, { importOpenCode: false });
    expect(off.ids()).not.toContain("opencode-local");
    expect(off.catalog().some((entry) => entry.id === "opencode-local")).toBe(false);
    off.stop();

    const enabled = structuredClone(DEFAULTS);
    enabled.integrations = { opencode: false, opencodeLocal: true };
    enabled.providers = {};
    const on = new ProviderRegistry(enabled, { importOpenCode: false });
    expect(on.ids()).toContain("opencode-local");
    expect(on.catalog().some((entry) => entry.id === "opencode-local")).toBe(false);
    expect(await on.supportsTools("opencode-local/big-pickle")).toBe(false);
    on.stop();
  });
});

describe("OpenCode free model detection", () => {
  test("recognizes free ids without marking other providers", () => {
    expect(isOpenCodeFreeModel("opencode", "big-pickle")).toBe(true);
    expect(isOpenCodeFreeModel("opencode", "deepseek-v4.1-flash-free")).toBe(true);
    expect(isOpenCodeFreeModel("opencode", "claude-sonnet-5")).toBe(false);
    expect(isOpenCodeFreeModel("openrouter", "some-model-free")).toBe(false);
  });
});
