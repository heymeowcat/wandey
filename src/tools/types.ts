import type { Config } from "../core/config.ts";
import type { Emit } from "../core/events.ts";
import type { JsonSchema, QuestionOption, ResearchDepth, SourcePartData, ToolSchema } from "../core/types.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { Store } from "../storage/store.ts";
import type { PageFetcher } from "../crawl/fetcher.ts";
import type { SearchService } from "../search/search.ts";

export interface AskRequest {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
  allowCustom?: boolean;
}

export interface AskResponse {
  answer: string[];
  custom?: string;
}

export type AskHandler = (request: AskRequest) => Promise<AskResponse>;

export interface DeepResearchOptions {
  messageID: string;
  callID: string;
  signal: AbortSignal;
}

export type DeepResearchHandler = (
  question: string,
  depth: ResearchDepth | undefined,
  options: DeepResearchOptions,
) => Promise<ToolResult>;

/** Everything a tool is allowed to touch. */
export interface ToolContext {
  sessionID: string;
  messageID: string;
  /** Stable id for this tool call, used for progress correlation and abort. */
  callID: string;
  signal: AbortSignal;
  emit: Emit;
  store: Store;
  config: Config;
  fetcher: PageFetcher;
  search: SearchService;
  registry: ProviderRegistry;
  ask: AskHandler;
  /** Injected by the agent; keeps the tool package free of research-engine imports. */
  deepResearch?: DeepResearchHandler;
}

export interface ToolResult {
  title: string;
  /** Text shown to the model. Keep it compact; the UI shows details. */
  output: string;
  isError?: boolean;
  metadata?: unknown;
  sources?: SourcePartData[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { title: `Unknown tool: ${name}`, output: `Error: no tool named "${name}". Available: ${this.names().join(", ")}`, isError: true };
    }
    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        return { title: `${name} aborted`, output: "The tool call was aborted.", isError: true };
      }
      return {
        title: `${name} failed`,
        output: `Error: ${(err as Error).message}`,
        isError: true,
        metadata: { stack: (err as Error).stack },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Argument helpers. Providers occasionally send strings for numbers, so these
// coerce rather than reject when it is unambiguous.
// ---------------------------------------------------------------------------

export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required string argument "${key}"`);
  }
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === "string" && args[key].trim() ? args[key].trim() : undefined;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (Array.isArray(value)) {
    const cleaned = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
    return cleaned.length > 0 ? cleaned : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return undefined;
}

export function optionalObjectArray(args: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = args[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}
