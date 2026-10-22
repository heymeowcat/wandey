import type { ProviderKind } from "../core/types.ts";

/**
 * Built-in provider catalog.
 *
 * These are templates, not connections: an entry only becomes a live provider
 * when its env var is set, when it is explicitly configured, or (for local
 * servers) when it answers on its default port.
 */
export interface ProviderTemplate {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  env: string[];
  local?: boolean;
  description: string;
  /** Curated models used when the provider has no /models endpoint. */
  fallbackModels?: string[];
  docs?: string;
}

export const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    env: ["OPENAI_API_KEY"],
    description: "OpenAI API",
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    env: ["ANTHROPIC_API_KEY"],
    description: "Claude models, native Messages API",
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    env: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    description: "Gemini API",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    env: ["OPENROUTER_API_KEY"],
    description: "One key, hundreds of models",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    kind: "openai",
    baseUrl: "https://opencode.ai/zen/v1",
    env: ["OPENCODE_API_KEY"],
    description: "Models curated by OpenCode",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    env: ["DEEPSEEK_API_KEY"],
    description: "DeepSeek API",
  },
  groq: {
    id: "groq",
    name: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    env: ["GROQ_API_KEY"],
    description: "Fast inference",
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    env: ["MISTRAL_API_KEY"],
    description: "Mistral API",
  },
  xai: {
    id: "xai",
    name: "xAI",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    env: ["XAI_API_KEY"],
    description: "Grok models",
  },
  zai: {
    id: "zai",
    name: "Z.ai",
    kind: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    env: ["ZAI_API_KEY", "Z_AI_API_KEY"],
    description: "GLM models",
  },
  moonshot: {
    id: "moonshot",
    name: "Moonshot",
    kind: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    env: ["MOONSHOT_API_KEY"],
    description: "Kimi models",
  },
  minimax: {
    id: "minimax",
    name: "MiniMax",
    kind: "openai",
    baseUrl: "https://api.minimax.io/v1",
    env: ["MINIMAX_API_KEY"],
    description: "MiniMax models",
  },
  together: {
    id: "together",
    name: "Together",
    kind: "openai",
    baseUrl: "https://api.together.xyz/v1",
    env: ["TOGETHER_API_KEY"],
    description: "Open models at scale",
  },
  fireworks: {
    id: "fireworks",
    name: "Fireworks",
    kind: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    env: ["FIREWORKS_API_KEY"],
    description: "Fast open-model inference",
  },
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    kind: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    env: ["CEREBRAS_API_KEY"],
    description: "Wafer-scale inference",
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    kind: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    env: ["OLLAMA_HOST"],
    local: true,
    description: "Local models (opened via its OpenAI-compatible API)",
  },
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    kind: "openai",
    baseUrl: "http://127.0.0.1:1234/v1",
    env: ["LMSTUDIO_HOST"],
    local: true,
    description: "Local models served by LM Studio",
  },
  llamacpp: {
    id: "llamacpp",
    name: "llama.cpp",
    kind: "openai",
    baseUrl: "http://127.0.0.1:8080/v1",
    env: ["LLAMACPP_HOST"],
    local: true,
    description: "llama.cpp server",
  },
  vllm: {
    id: "vllm",
    name: "vLLM",
    kind: "openai",
    baseUrl: "http://127.0.0.1:8000/v1",
    env: ["VLLM_HOST"],
    local: true,
    description: "vLLM server",
  },
};

export function templateFor(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES[id];
}

/** Which providers to try out of the box, even with no configuration. */
export const AUTO_LOCAL_PROVIDERS = ["ollama", "lmstudio", "llamacpp"];

/**
 * Resolve an env var list to [name, value] for the first one that is set.
 */
export function firstEnv(names: string[]): { name: string; value: string } | null {
  for (const name of names) {
    const value = Bun.env[name];
    if (value && value.trim()) return { name, value: value.trim() };
  }
  return null;
}
