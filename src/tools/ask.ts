import type { Tool, ToolContext, ToolResult } from "./types.ts";
import { optionalBoolean, optionalObjectArray, requiredString } from "./types.ts";

/**
 * Ask the user a question and wait for an answer.
 *
 * This is what powers the OpenCode-style option cards in the UI. Models are
 * encouraged to use it for genuine forks in the road (which source to trust,
 * which direction to explore) rather than for yes/no busywork.
 */
export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "Ask the user to choose a direction when a decision genuinely affects the work. Provide 2-5 concrete options with short labels and descriptions. Set multiple=true when selecting several options makes sense. The answer comes back as a list of selected labels, plus optional custom text. Do not use this for trivial confirmations.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to show. One or two sentences." },
      header: { type: "string", description: "A very short label, ideally under 20 characters." },
      options: {
        type: "array",
        description: "Concrete choices. Provide at least two.",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Short choice label." },
            description: { type: "string", description: "What this choice means." },
          },
          required: ["label"],
        },
      },
      multiple: { type: "boolean", description: "Allow selecting more than one option." },
      allow_custom: { type: "boolean", description: "Allow a free-text answer in addition to the options." },
    },
    required: ["question", "options"],
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const question = requiredString(args, "question");
    const header = typeof args.header === "string" ? args.header.trim() : undefined;
    const multiple = optionalBoolean(args, "multiple") ?? false;
    const allowCustom = optionalBoolean(args, "allow_custom") ?? true;
    const options = optionalObjectArray(args, "options")
      .map((row) => ({
        label: typeof row.label === "string" ? row.label.trim() : "",
        description: typeof row.description === "string" ? row.description.trim() : undefined,
      }))
      .filter((option) => option.label);

    if (options.length === 0) {
      throw new Error("ask_user requires at least one option with a label");
    }

    const response = await ctx.ask({ question, header, options: options.slice(0, 8), multiple, allowCustom });
    const lines = [`The user answered: ${response.answer.join(", ") || "(no option selected)"}`];
    if (response.custom?.trim()) lines.push(`Custom note: ${response.custom.trim()}`);
    return {
      title: header || "Asked the user",
      output: lines.join("\n"),
      metadata: { question, options, answer: response.answer, custom: response.custom },
    };
  },
};
