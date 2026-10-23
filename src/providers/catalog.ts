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
    docs: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    env: ["ANTHROPIC_API_KEY"],
    description: "Claude models, native Messages API",
    docs: "https://console.anthropic.com/settings/keys",
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    env: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    description: "Gemini API",
    docs: "https://aistudio.google.com/app/apikey",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    env: ["OPENROUTER_API_KEY"],
    description: "One key, hundreds of models",
    docs: "https://openrouter.ai/keys",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    kind: "openai",
    baseUrl: "https://opencode.ai/inference/v1",
    env: ["OPENCODE_API_KEY"],
    description: "Models curated by OpenCode",
    docs: "https://opencode.ai/console",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    env: ["DEEPSEEK_API_KEY"],
    description: "DeepSeek API",
    docs: "https://platform.deepseek.com/api_keys",
  },
  groq: {
    id: "groq",
    name: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    env: ["GROQ_API_KEY"],
    description: "Fast inference",
    docs: "https://console.groq.com/keys",
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    env: ["MISTRAL_API_KEY"],
    description: "Mistral API",
    docs: "https://console.mistral.ai/api-keys",
  },
  xai: {
    id: "xai",
    name: "xAI",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    env: ["XAI_API_KEY"],
    description: "Grok models",
    docs: "https://console.x.ai",
  },
  zai: {
    id: "zai",
    name: "Z.ai",
    kind: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    env: ["ZAI_API_KEY", "Z_AI_API_KEY"],
    description: "GLM models",
    docs: "https://docs.z.ai",
  },
  moonshot: {
    id: "moonshot",
    name: "Moonshot",
    kind: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    env: ["MOONSHOT_API_KEY"],
    description: "Kimi models",
    docs: "https://platform.moonshot.ai/console/api-keys",
  },
  minimax: {
    id: "minimax",
    name: "MiniMax",
    kind: "openai",
    baseUrl: "https://api.minimax.io/v1",
    env: ["MINIMAX_API_KEY"],
    description: "MiniMax models",
    docs: "https://platform.minimax.io",
  },
  together: {
    id: "together",
    name: "Together",
    kind: "openai",
    baseUrl: "https://api.together.xyz/v1",
    env: ["TOGETHER_API_KEY"],
    description: "Open models at scale",
    docs: "https://api.together.ai/settings/api-keys",
  },
  fireworks: {
    id: "fireworks",
    name: "Fireworks",
    kind: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    env: ["FIREWORKS_API_KEY"],
    description: "Fast open-model inference",
    docs: "https://fireworks.ai/account/api-keys",
  },
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    kind: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    env: ["CEREBRAS_API_KEY"],
    description: "Wafer-scale inference",
    docs: "https://cloud.cerebras.ai",
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    kind: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    env: ["OLLAMA_HOST"],
    local: true,
    description: "Local and cloud models through a local Ollama server",
    docs: "https://ollama.com/download",
  },
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    kind: "openai",
    baseUrl: "http://127.0.0.1:1234/v1",
    env: ["LMSTUDIO_HOST"],
    local: true,
    description: "Local models served by LM Studio",
    docs: "https://lmstudio.ai",
  },
  llamacpp: {
    id: "llamacpp",
    name: "llama.cpp",
    kind: "openai",
    baseUrl: "http://127.0.0.1:8080/v1",
    env: ["LLAMACPP_HOST"],
    local: true,
    description: "llama.cpp server",
    docs: "https://github.com/ggml-org/llama.cpp",
  },
  vllm: {
    id: "vllm",
    name: "vLLM",
    kind: "openai",
    baseUrl: "http://127.0.0.1:8000/v1",
    env: ["VLLM_HOST"],
    local: true,
    description: "vLLM server",
    docs: "https://docs.vllm.ai",
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
