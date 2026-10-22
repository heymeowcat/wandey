import { ToolRegistry } from "./types.ts";
import { askUserTool } from "./ask.ts";
import { deepResearchTool } from "./research.ts";
import { createWebTools } from "./web.ts";

export * from "./types.ts";

/** Build the default tool set. The agent injects the research engine at runtime. */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(askUserTool);
  registry.register(deepResearchTool);
  for (const tool of createWebTools()) registry.register(tool);
  return registry;
}
