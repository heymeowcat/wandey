import { ToolRegistry } from "./types.ts";
import { askUserTool } from "./ask.ts";
import { createWebTools } from "./web.ts";

export * from "./types.ts";

/** Build the default tool set. The research tool is registered separately. */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(askUserTool);
  for (const tool of createWebTools()) registry.register(tool);
  return registry;
}
