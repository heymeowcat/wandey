/**
 * Live smoke test for the agent loop.
 *
 * Usage:
 *   bun scripts/smoke-agent.ts [provider/model] ["prompt"]
 *
 * This script uses an in-memory database, hits real search providers, and needs
 * a working configured model. It is intentionally not part of `bun test`.
 */
import { loadConfig } from "../src/core/config.ts";
import { Store } from "../src/storage/store.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { EventBus } from "../src/core/events.ts";
import { PageFetcher } from "../src/crawl/fetcher.ts";
import { SearchService } from "../src/search/search.ts";
import { createToolRegistry } from "../src/tools/index.ts";
import { Agent } from "../src/agent/agent.ts";

const { config } = loadConfig();
const store = new Store(":memory:");
const registry = new ProviderRegistry(config);
const tools = createToolRegistry();
const fetcher = new PageFetcher(config.crawl);
const search = new SearchService(config);
const bus = new EventBus();

bus.on((event) => {
  if (event.type === "part.delta") return;
  if (event.type === "crawl.progress") {
    console.log("crawl", event.progress.kind, event.progress.fetched);
    return;
  }
  if (event.type === "part.created") {
    console.log("part", event.part.type);
    return;
  }
  if (event.type === "part.updated") {
    console.log("part-updated", event.part.type);
    return;
  }
  if (event.type === "session.error") {
    console.log("ERROR", event.message);
    return;
  }
  if (event.type === "session.status") console.log("status", event.status);
});

const agent = new Agent({ config, store, registry, tools, fetcher, search, bus });
const session = store.createSession({ title: "New research" });
const model = process.argv[2] || "openrouter/google/gemma-4-31b-it:free";
const prompt =
  process.argv[3] ||
  "Find one recent notable open-source web crawler project. Use web_search first, then answer in 3 short cited bullets.";

console.log("model", model);
await agent.prompt(session.id, prompt, { model });

const deadline = Date.now() + 180_000;
while (agent.isRunning(session.id) && Date.now() < deadline) await Bun.sleep(200);

const detail = store.getSessionDetail(session.id);
if (!detail) throw new Error("no session");
for (const { message, parts } of detail.messages) {
  console.log("---", message.role, message.finishReason, message.error ?? "");
  for (const part of parts) {
    if (part.type === "text") console.log(part.data.text.slice(0, 2500));
    if (part.type === "tool") {
      console.log("TOOL", part.data.name, part.data.status, "\n", (part.data.output ?? "").slice(0, 600));
    }
    if (part.type === "error") console.log("ERRPART", part.data.message);
    if (part.type === "source") console.log("SOURCE", part.data.sourceID, part.data.title);
  }
}
