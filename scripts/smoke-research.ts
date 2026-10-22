/**
 * Live smoke test for deep research.
 *
 * Usage:
 *   bun scripts/smoke-research.ts [provider/model] ["question"] [depth]
 *
 * Runs the engine directly (no agent) against real search providers and models.
 * Uses an in-memory database and writes the report to ./research.
 */
import { loadConfig } from "../src/core/config.ts";
import { Store } from "../src/storage/store.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { EventBus } from "../src/core/events.ts";
import { PageFetcher } from "../src/crawl/fetcher.ts";
import { SearchService } from "../src/search/search.ts";
import { ResearchEngine } from "../src/research/engine.ts";

const { config, paths } = loadConfig();
config.research.outputDir = `${paths.home}/research`;

const store = new Store(":memory:");
const registry = new ProviderRegistry(config);
const fetcher = new PageFetcher(config.crawl);
const search = new SearchService(config);
const bus = new EventBus();

const model = process.argv[2] || "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free";
const question =
  process.argv[3] ||
  "What are the main tradeoffs between SQLite and PostgreSQL for a local-first desktop application in 2026?";
const depth = (process.argv[4] || "quick") as "quick" | "standard" | "deep" | "exhaustive";

let last = "";
bus.on((event) => {
  if (event.type !== "research.progress" || event.part.type !== "research") return;
  const data = event.part.data;
  if (data.status !== "running" && data.status !== "done") return;
  const label = `${data.progress.stage} · ${data.progress.subQuestionsDone}/${data.progress.subQuestionsTotal} · ${data.progress.pagesFetched} pages · ${data.progress.message}`;
  if (label === last) return;
  last = label;
  console.log(label);
});

const session = store.createSession({ title: "Research smoke" });
const message = store.createMessage(session.id, "assistant", model);
const engine = new ResearchEngine({ config, store, registry, search, fetcher, bus });

console.log("model", model, "depth", depth);
const started = Date.now();
try {
  const outcome = await engine.run({
    sessionID: session.id,
    messageID: message.id,
    question,
    depth,
    model,
  });
  console.log(`\nDONE in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log("report:", outcome.outputPath);
  console.log("sources:", outcome.sources.length, "notes:", outcome.notes, "cited:", outcome.cited.join(", "));
  console.log("warnings:", outcome.warnings.length ? outcome.warnings.join(" | ") : "none");
  console.log("\n--- report ---\n");
  console.log(outcome.report);
} catch (err) {
  console.error("FAILED:", (err as Error).message);
  process.exitCode = 1;
}
