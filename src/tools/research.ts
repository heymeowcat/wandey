import type { ResearchDepth } from "../core/types.ts";
import type { Tool, ToolResult } from "./types.ts";
import { optionalString, requiredString } from "./types.ts";

const DEPTHS: ResearchDepth[] = ["quick", "standard", "deep", "exhaustive"];

/**
 * The research tool is a thin shell around ResearchEngine.
 *
 * The engine is injected by the agent (see ToolContext.deepResearch) so that
 * tools stay independent of the research package and tests can run the engine
 * without an agent.
 */
export const deepResearchTool: Tool = {
  name: "deep_research",
  description:
    "Run a full deep-research investigation: decompose the question, search multiple queries, read the strongest pages, extract cited evidence, fill gaps over several rounds, and write a Markdown report with verified source ids. Use this for landscape reviews, competitive analysis, literature questions, or any request that needs more than a handful of pages. It can take minutes; it is cheaper and better than manually repeating web_search and fetch_url dozens of times.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The precise research question, including scope, dates, geography, or criteria that matter.",
      },
      depth: {
        type: "string",
        enum: DEPTHS,
        description: "How much work to do. quick: 1 round, few pages. standard: 2 rounds. deep: 3 rounds. exhaustive: 4 rounds and the largest page budget.",
      },
    },
    required: ["question"],
  },

  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.deepResearch) {
      throw new Error("Deep research is not available in this runtime.");
    }
    const question = requiredString(args, "question");
    const raw = optionalString(args, "depth")?.toLowerCase();
    const depth = raw && DEPTHS.includes(raw as ResearchDepth) ? (raw as ResearchDepth) : undefined;

    return ctx.deepResearch(question, depth, {
      messageID: ctx.messageID,
      callID: ctx.callID,
      signal: ctx.signal,
    });
  },
};
