import fs from "node:fs";
import readline from "node:readline";
import type { Config } from "../core/config.ts";
import { ensurePaths, loadConfig, redactConfig, saveConfig } from "../core/config.ts";
import type { QuestionPartData, Session, SessionMode } from "../core/types.ts";
import { VERSION } from "../core/version.ts";
import { Agent } from "../agent/agent.ts";
import { PageFetcher } from "../crawl/fetcher.ts";
import { EventBus } from "../core/events.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { SearchService } from "../search/search.ts";
import { Store } from "../storage/store.ts";
import { createToolRegistry } from "../tools/index.ts";
import { startServer } from "../server/server.ts";

/**
 * The command line is a thin shell around the same agent the browser uses.
 * No business logic lives here: serve starts the server, chat wires the event
 * bus to a terminal, and the rest inspects configuration.
 */

const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: number) => (text: string): string => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const magenta = paint(35);
const cyan = paint(36);

const VALUE_FLAGS = new Set([
  "port",
  "host",
  "model",
  "session",
  "provider",
  "limit",
  "depth",
  "key",
  "value",
]);

interface Args {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (arg === "-v") {
      flags.set("version", true);
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const equals = body.indexOf("=");
      if (equals !== -1) {
        flags.set(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      const key = body;
      const next = argv[index + 1];
      if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith("-")) {
        flags.set(key, next);
        index++;
      } else {
        flags.set(key, true);
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

const flag = (args: Args, key: string): string | undefined => {
  const value = args.flags.get(key);
  return typeof value === "string" ? value : undefined;
};
const has = (args: Args, key: string): boolean => args.flags.get(key) === true || typeof args.flags.get(key) === "string";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "serve" || command === "server") {
    await serve(rest);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(`wandey ${VERSION}`);
    return;
  }

  switch (command) {
    case "chat":
      await chat(rest);
      break;
    case "models":
      await models(rest);
      break;
    case "doctor":
      await doctor(rest);
      break;
    case "config":
      await config(rest);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

async function serve(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (has(args, "help")) {
    printServeHelp();
    return;
  }

  const { config, paths } = loadConfig();
  if (flag(args, "model")) config.agent.model = flag(args, "model")!;
  if (has(args, "no-opencode")) config.integrations.opencode = false;
  if (has(args, "no-open")) config.server.openBrowser = false;

  const host = flag(args, "host") ?? config.server.host;
  const port = parsePort(flag(args, "port") ?? String(config.server.port));
  ensurePaths(paths);

  console.log(`${bold("wandey")} ${dim(VERSION)}`);
  console.log(`${dim("config")}  ${paths.configFile}`);
  console.log(`${dim("data")}    ${paths.dbFile}`);

  const server = await startServer({
    config,
    paths,
    host,
    port,
    openBrowser: config.server.openBrowser,
    dev: has(args, "dev"),
  });

  console.log(
    `${dim("hint")}    ${config.server.openBrowser ? "opening your browser" : "open the URL above"} · Ctrl+C to stop`,
  );

  const stop = (): void => {
    console.log(`\n${dim("stopping…")}`);
    server.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<void>(() => {});
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port "${value}". Use a number from 0 to 65535.`);
  }
  return port;
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

async function chat(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (has(args, "help")) {
    printChatHelp();
    return;
  }

  const { config, paths } = loadConfig();
  const requestedModel = flag(args, "model") ?? "";
  if (requestedModel) config.agent.model = requestedModel;
  if (has(args, "no-opencode")) config.integrations.opencode = false;
  ensurePaths(paths);

  const store = new Store(paths.dbFile);
  const registry = new ProviderRegistry(config);
  const bus = new EventBus();
  const fetcher = new PageFetcher(config.crawl);
  const search = new SearchService(config);
  const tools = createToolRegistry();
  const agent = new Agent({ config, store, registry, tools, fetcher, search, bus });

  let session: Session;
  const wanted = flag(args, "session");
  try {
    if (wanted) {
      const found = store.getSession(wanted);
      if (!found) throw new Error(`No session with id "${wanted}".`);
      session = found;
    } else if (has(args, "continue")) {
      session = store.listSessions()[0] ?? store.createSession({ title: "New chat" });
    } else {
      session = store.createSession({
        title: "New chat",
        mode: has(args, "research") ? "research" : "chat",
        model: requestedModel || config.agent.model || null,
      });
    }
  } catch (err) {
    store.close();
    throw err;
  }

  let mode: SessionMode = session.mode;
  if (has(args, "research")) mode = "research";
  if (has(args, "chat")) mode = "chat";

  let model = requestedModel || session.model || config.agent.model;
  if (!model) {
    process.stdout.write(dim("Looking for an available model… "));
    model = (await registry.defaultModel()) ?? "";
    process.stdout.write("\n");
  }
  if (!model) {
    console.error(
      red("No model is available.") +
        dim(" Start Ollama, add an API key, or run `wandey models` after configuring a provider."),
    );
    store.close();
    process.exitCode = 1;
    return;
  }
  if (session.model !== model) store.updateSession(session.id, { model });

  let showReasoning = has(args, "reasoning");
  let closed = false;
  let exit = false;
  let activeRun = false;
  let resolveIdle: (() => void) | null = null;
  let sawText = false;
  let lastResearchKey = "";
  const roles = new Map<string, "user" | "assistant">();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  rl.on("close", () => {
    closed = true;
    // On a TTY, Ctrl+D means stop what is running. With piped stdin, EOF is
    // normal: let the current answer finish, then the loop exits cleanly.
    if (agent.isRunning(session.id) && process.stdin.isTTY) agent.abort(session.id);
    else if (!agent.isRunning(session.id)) exit = true;
  });

  const ask = (query: string): Promise<string> =>
    new Promise((resolve) => {
      if (closed) return resolve("");
      rl.question(query, resolve);
    });

  const newline = (): void => {
    if (sawText) {
      process.stdout.write("\n");
      sawText = false;
    }
  };

  const answerQuestion = async (part: QuestionPartData): Promise<void> => {
    newline();
    console.log(`\n${magenta("?")} ${bold(part.header || "A question")}`);
    console.log(part.question);
    for (const [index, option] of part.options.entries()) {
      const description = option.description ? dim(` — ${option.description}`) : "";
      console.log(`  ${cyan(String(index + 1))}) ${option.label}${description}`);
    }
    const help = part.allowCustom
      ? "Choose number(s), type a custom answer, or press Enter to skip."
      : "Choose number(s), or press Enter to skip.";
    console.log(dim(`  ${help}`));

    const raw = (await ask(`  ${magenta("answer>")} `)).trim();
    if (!raw) {
      agent.answerQuestion(part.questionID, []);
      console.log(dim("  skipped"));
      return;
    }

    const tokens = raw.split(/[\s,]+/).filter(Boolean);
    const indexes = tokens.map((token) => (/^\d+$/.test(token) ? Number(token) : Number.NaN));
    const allOptions = indexes.every(
      (index) => Number.isInteger(index) && index >= 1 && index <= part.options.length,
    );
    if (allOptions) {
      const selected = indexes
        .filter((index) => Number.isInteger(index))
        .slice(0, part.multiple ? undefined : 1)
        .map((index) => part.options[index - 1]!.label);
      agent.answerQuestion(part.questionID, selected);
      return;
    }
    if (part.allowCustom) {
      agent.answerQuestion(part.questionID, [], raw);
      return;
    }
    console.log(red("  Please use one of the numbers shown, or press Enter to skip."));
    agent.answerQuestion(part.questionID, []);
  };

  bus.on((event) => {
    if ("sessionID" in event && event.sessionID && event.sessionID !== session.id) return;

    switch (event.type) {
      case "message.created":
        roles.set(event.message.id, event.message.role);
        break;

      case "part.created": {
        if (roles.get(event.messageID) !== "assistant") break;
        if (event.part.type === "tool") {
          newline();
          const title = event.part.data.title || event.part.data.name.replace(/_/g, " ");
          console.log(`${dim("tool")} ${title} ${dim("…")}`);
        }
        break;
      }

      case "part.delta": {
        if (roles.get(event.messageID) !== "assistant") break;
        if (event.kind === "reasoning") {
          if (showReasoning) {
            process.stdout.write(dim(event.delta));
            sawText = true;
          }
          break;
        }
        process.stdout.write(event.delta);
        sawText = true;
        break;
      }

      case "part.updated": {
        if (event.part.type === "tool" && roles.get(event.part.messageID) === "assistant") {
          newline();
          const tool = event.part.data;
          const mark = tool.status === "error" ? red("✗") : green("✓");
          const duration = tool.endedAt ? dim(` ${((tool.endedAt - tool.startedAt) / 1000).toFixed(1)}s`) : "";
          console.log(`  ${mark} ${tool.name}${duration}`);
        } else if (event.part.type === "text" && roles.get(event.part.messageID) === "assistant") {
          newline();
        } else if (event.part.type === "error") {
          newline();
          console.log(red(`error: ${event.part.data.message}`));
        } else if (event.part.type === "research" && event.part.data.status !== "running") {
          newline();
        }
        break;
      }

      case "research.progress": {
        if (event.part.type !== "research") break;
        const progress = event.part.data.progress;
        const key = `${progress.stage}:${progress.subQuestionsDone}:${progress.round}`;
        if (key === lastResearchKey) break;
        lastResearchKey = key;
        newline();
        console.log(
          dim(
            `  ◐ ${progress.stage} ${progress.subQuestionsDone}/${progress.subQuestionsTotal} questions · ${progress.pagesFetched} pages · ${progress.message}`,
          ),
        );
        break;
      }

      case "question":
        if (event.part.type === "question" && event.part.data.status === "pending") {
          void answerQuestion(event.part.data);
        }
        break;

      case "session.status":
        if (event.status === "idle") {
          newline();
          resolveIdle?.();
        } else if (event.status === "waiting") {
          newline();
        }
        break;

      case "session.error":
        newline();
        console.error(red(`error: ${event.message}`));
        break;

      default:
        break;
    }
  });

  const printRunSummary = (): void => {
    const detail = store.getSessionDetail(session.id);
    if (!detail) return;
    const last = [...detail.messages].reverse().find((entry) => entry.message.role === "assistant");
    if (!last) return;
    const usage = last.message.usage;
    if (usage) {
      const bits: string[] = [];
      if (usage.input !== undefined) bits.push(`${compact(usage.input)} in`);
      if (usage.output !== undefined) bits.push(`${compact(usage.output)} out`);
      if (usage.cost) bits.push(`$${usage.cost.toFixed(4)}`);
      if (bits.length > 0) console.log(dim(`  ${bits.join(" · ")}`));
    }
    const sources = last.parts.filter((part) => part.type === "source");
    if (sources.length > 0) {
      console.log(dim("  sources"));
      for (const part of sources) {
        if (part.type !== "source") continue;
        console.log(`    ${cyan(part.data.sourceID.toUpperCase())} ${part.data.title}`);
        console.log(`       ${dim(part.data.url)}`);
      }
    }
    const research = last.parts.find((part) => part.type === "research");
    if (research?.type === "research") {
      const job = store.getResearchJob(research.data.jobID);
      if (job?.outputPath) console.log(dim(`  report  ${job.outputPath}`));
    }
  };

  const toggleMode = (next: SessionMode, quiet = false): void => {
    mode = next;
    store.updateSession(session.id, { mode });
    if (!quiet) console.log(dim(`mode is now ${mode}`));
  };

  const commandHelp = (): void => {
    console.log(
      [
        "",
        bold("commands"),
        `  ${cyan("/model")} [ref]   show or change the model`,
        `  ${cyan("/research")}     toggle deep research for the next prompt`,
        `  ${cyan("/sources")}      list sources collected in this session`,
        `  ${cyan("/session")}      show the session id and title`,
        `  ${cyan("/new")}          start a new session`,
        `  ${cyan("/reasoning")}    toggle streamed reasoning`,
        `  ${cyan("/help")}         this list`,
        `  ${cyan("/quit")}         exit (Ctrl+D also works)`,
        "",
      ].join("\n"),
    );
  };

  console.log("");
  console.log(`${bold("wandey chat")} ${dim(VERSION)}`);
  console.log(`${dim("model")}    ${cyan(model)}`);
  console.log(`${dim("mode")}     ${mode}`);
  console.log(`${dim("session")}  ${session.id}`);
  console.log(dim("Type /help for commands. Ctrl+C stops a running turn."));

  process.on("SIGINT", () => {
    if (agent.isRunning(session.id)) {
      agent.abort(session.id);
      newline();
      console.log(dim("stopping…"));
    } else {
      rl.close();
    }
  });

  while (!exit && !closed) {
    const line = await ask(`\n${cyan("you>")} `);
    if (closed) break;
    const input = line.trim();
    if (!input) continue;
    if (["exit", "quit", ":q"].includes(input.toLowerCase())) {
      exit = true;
      break;
    }

    if (input.startsWith("/")) {
      const [rawCommand, ...rest] = input.split(/\s+/);
      const command = rawCommand!.toLowerCase();
      if (command === "/quit" || command === "/exit") {
        exit = true;
        break;
      }
      if (command === "/help") {
        commandHelp();
        continue;
      }
      if (command === "/model") {
        const next = rest.join(" ").trim();
        if (!next) {
          console.log(`${dim("model")} ${cyan(model)}`);
          const options = (await registry.listModels()).filter((entry) => entry.supportsTools !== false).slice(0, 12);
          if (options.length > 0) {
            console.log(dim("some available models"));
            for (const option of options) console.log(`  ${option.ref}`);
          }
          continue;
        }
        model = next;
        store.updateSession(session.id, { model });
        console.log(dim(`model is now ${model}`));
        continue;
      }
      if (command === "/research") {
        toggleMode(mode === "research" ? "chat" : "research");
        continue;
      }
      if (command === "/sources") {
        const sources = store.listSources(session.id);
        if (sources.length === 0) console.log(dim("No sources in this session yet."));
        for (const source of sources) console.log(`  ${cyan(source.sourceID.toUpperCase())} ${source.title} ${dim(source.url)}`);
        continue;
      }
      if (command === "/session") {
        console.log(`${dim("id")}    ${session.id}`);
        console.log(`${dim("title")} ${session.title}`);
        continue;
      }
      if (command === "/new") {
        session = store.createSession({ title: "New chat", mode, model });
        console.log(dim(`new session ${session.id}`));
        continue;
      }
      if (command === "/reasoning") {
        showReasoning = !showReasoning;
        console.log(dim(`reasoning is ${showReasoning ? "on" : "off"}`));
        continue;
      }
      console.log(red(`Unknown command ${command}. Type /help.`));
      continue;
    }

    const done = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    activeRun = true;
    lastResearchKey = "";
    try {
      await agent.prompt(session.id, input, { model, mode });
      if (agent.isRunning(session.id)) await done;
    } catch (err) {
      newline();
      console.error(red((err as Error).message));
    } finally {
      activeRun = false;
      resolveIdle = null;
      newline();
      printRunSummary();
    }
  }

  if (activeRun && agent.isRunning(session.id)) agent.abort(session.id);
  rl.close();
  store.close();
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

async function models(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (has(args, "help")) {
    console.log("Usage: wandey models [--provider <id>] [--free] [--all] [--limit <n>] [--json]");
    return;
  }
  const { config, paths } = loadConfig();
  const registry = new ProviderRegistry(config);
  const refresh = has(args, "refresh");
  const all = has(args, "all");
  const limit = Number(flag(args, "limit") ?? "20");
  const providerFilter = flag(args, "provider");
  const freeOnly = has(args, "free");
  const [allModels, providers] = await Promise.all([
    registry.listModels(refresh),
    registry.statusesWithModels(),
  ]);

  let shown = allModels;
  if (providerFilter) shown = shown.filter((model) => model.provider === providerFilter);
  if (freeOnly) shown = shown.filter((model) => model.free);

  if (has(args, "json")) {
    console.log(JSON.stringify({ providers, models: shown }, null, 2));
    return;
  }

  console.log(`${bold("models")} ${dim(`${shown.length} of ${allModels.length} · ${paths.configFile}`)}`);
  if (shown.length === 0) {
    console.log("");
    console.log(yellow("No models found."));
    console.log(dim("Start Ollama, set OPENROUTER_API_KEY, or add a provider in `wandey config`."));
    return;
  }

  const groups = new Map<string, typeof shown>();
  for (const model of shown) {
    const group = groups.get(model.provider) ?? [];
    group.push(model);
    groups.set(model.provider, group);
  }

  for (const [providerID, group] of groups) {
    const status = providers.find((entry) => entry.id === providerID);
    const scope = status?.local ? "local" : status?.source === "opencode" ? "opencode" : "remote";
    console.log("");
    console.log(`${bold(status?.name ?? providerID)} ${dim(`· ${scope} · ${group.length} model${group.length === 1 ? "" : "s"}`)}`);
    if (status?.error) console.log(dim(`  ${status.error}`));
    const visible = all ? group : group.slice(0, Number.isFinite(limit) ? Math.max(1, limit) : group.length);
    for (const model of visible) {
      const tags = [model.free ? green("free") : "", model.supportsTools === false ? dim("no-tools") : ""]
        .filter(Boolean)
        .join(" ");
      const context = model.contextWindow ? dim(` ${compact(model.contextWindow)} ctx`) : "";
      console.log(`  ${cyan(model.ref)}`);
      console.log(`    ${model.name}${context}${tags ? ` ${tags}` : ""}`);
    }
    if (visible.length < group.length) {
      console.log(dim(`  … ${group.length - visible.length} more (use --all or --limit)`));
    }
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function doctor(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (has(args, "help")) {
    console.log("Usage: wandey doctor [--json]");
    return;
  }

  const { config, paths } = loadConfig();
  const problems: string[] = [];
  const warnings: string[] = [];
  const checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string }> = [];
  const add = (name: string, status: "ok" | "warn" | "fail", detail: string): void => {
    checks.push({ name, status, detail });
    if (status === "fail") problems.push(`${name}: ${detail}`);
    if (status === "warn") warnings.push(`${name}: ${detail}`);
  };

  ensurePaths(paths);

  let store: Store | null = null;
  try {
    store = new Store(paths.dbFile);
    const count = store.listSessions().length;
    add("storage", "ok", `${paths.dbFile} (${count} session${count === 1 ? "" : "s"})`);
  } catch (err) {
    add("storage", "fail", (err as Error).message);
  }

  let registry: ProviderRegistry | null = null;
  let providerStatuses: Awaited<ReturnType<ProviderRegistry["statusesWithModels"]>> = [];
  let modelList: Awaited<ReturnType<ProviderRegistry["listModels"]>> = [];
  try {
    registry = new ProviderRegistry(config);
    [providerStatuses, modelList] = await Promise.all([
      registry.statusesWithModels(),
      registry.listModels(),
    ]);
    const usable = providerStatuses.filter((provider) => provider.modelCount > 0);
    if (usable.length === 0) add("providers", "fail", "No provider returned any models.");
    else add("providers", "ok", `${usable.length} usable provider${usable.length === 1 ? "" : "s"}, ${modelList.length} models`);
    for (const provider of providerStatuses) {
      if (provider.error) warnings.push(`${provider.id}: ${provider.error}`);
    }
  } catch (err) {
    add("providers", "fail", (err as Error).message);
  }

  const configuredSearch = config.search.providers.filter((provider) => provider.enabled !== false);
  if (configuredSearch.length === 0) add("search", "fail", "No search providers configured.");
  else {
    const missing = configuredSearch.filter((provider) => searchKeyMissing(provider)).map((provider) => provider.type);
    add(
      "search",
      missing.length > 0 ? "warn" : "ok",
      `${configuredSearch.map((provider) => provider.type).join(", ")}${missing.length > 0 ? ` (missing key: ${missing.join(", ")})` : ""}`,
    );
  }

  const pdfCommand = config.crawl.pdf.command;
  if (config.crawl.pdf.enabled) {
    const found = Bun.which(pdfCommand);
    add("pdf", found ? "ok" : "warn", found ? `${pdfCommand} at ${found}` : `${pdfCommand} not found; PDF extraction disabled at runtime`);
  } else {
    add("pdf", "ok", "disabled in config");
  }

  add(
    "renderer",
    "ok",
    config.crawl.render.backend === "none" ? "none (HTTP + Readability)" : config.crawl.render.backend,
  );
  add("opencode", "ok", config.integrations.opencode ? "credential import enabled" : "disabled");

  if (has(args, "json")) {
    console.log(
      JSON.stringify(
        {
          version: VERSION,
          bun: Bun.version,
          platform: process.platform,
          configFile: paths.configFile,
          dbFile: paths.dbFile,
          checks,
          providers: providerStatuses,
          models: { total: modelList.length },
          problems,
          warnings,
          config: redactConfig(config),
        },
        null,
        2,
      ),
    );
    store?.close();
    process.exitCode = problems.length > 0 ? 1 : 0;
    return;
  }

  console.log(`${bold("wandey doctor")} ${dim(VERSION)}`);
  console.log(dim(`${process.platform} · Bun ${Bun.version}`));
  console.log("");
  for (const check of checks) {
    const mark = check.status === "ok" ? green("✓") : check.status === "warn" ? yellow("!") : red("✗");
    console.log(`${mark} ${check.name.padEnd(12)} ${check.detail}`);
  }

  if (providerStatuses.length > 0) {
    console.log("");
    console.log(bold("providers"));
    for (const provider of providerStatuses) {
      const mark = provider.modelCount > 0 ? green("✓") : dim("·");
      const auth = provider.authenticated ? "auth" : provider.local ? "local" : "no-key";
      const error = provider.error ? ` ${red(provider.error)}` : "";
      console.log(`  ${mark} ${provider.id.padEnd(14)} ${String(provider.modelCount).padStart(4)} models  ${dim(auth)}${error}`);
    }
  }

  if (warnings.length > 0) {
    console.log("");
    console.log(yellow("warnings"));
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }
  if (problems.length > 0) {
    console.log("");
    console.log(red("problems"));
    for (const problem of problems) console.log(`  ✗ ${problem}`);
  } else {
    console.log("");
    console.log(green("All critical checks passed."));
  }
  console.log(dim(`\nconfig ${paths.configFile}`));
  store?.close();
  process.exitCode = problems.length > 0 ? 1 : 0;
}

function searchKeyMissing(provider: Config["search"]["providers"][number]): boolean {
  if (provider.type === "brave") return !(provider.apiKey || process.env[provider.apiKeyEnv ?? "BRAVE_API_KEY"]);
  if (provider.type === "tavily") return !(provider.apiKey || process.env[provider.apiKeyEnv ?? "TAVILY_API_KEY"]);
  if (provider.type === "exa") return !(provider.apiKey || process.env[provider.apiKeyEnv ?? "EXA_API_KEY"]);
  return false;
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

async function config(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const sub = args.positionals[0] ?? "show";
  if (has(args, "help")) {
    printConfigHelp();
    return;
  }
  const { config, paths } = loadConfig();

  if (sub === "path") {
    console.log(paths.configFile);
    return;
  }

  if (sub === "init") {
    if (fs.existsSync(paths.configFile) && !has(args, "force")) {
      console.log(`${paths.configFile} already exists. Use --force to overwrite.`);
      return;
    }
    if (has(args, "force")) fs.rmSync(paths.configFile, { force: true });
    saveConfig({ storage: { dir: paths.home } }, paths);
    console.log(`Wrote ${paths.configFile}`);
    return;
  }

  if (sub === "set") {
    const key = args.positionals[1];
    const value = args.positionals[2];
    if (!key) {
      console.error("Usage: wandey config set <dotted.key> <value>");
      process.exitCode = 1;
      return;
    }
    if (value === undefined) {
      console.error("A value is required. Use JSON for objects/arrays, e.g. '{\"port\":4319}'.");
      process.exitCode = 1;
      return;
    }
    const patch: Record<string, unknown> = {};
    setDeep(patch, key.split("."), parseValue(value));
    saveConfig(patch as unknown as Partial<Config>, paths);
    console.log(`Set ${bold(key)} in ${paths.configFile}`);
    return;
  }

  if (sub === "show") {
    console.log(dim(paths.configFile));
    console.log(JSON.stringify(redactConfig(config), null, 2));
    return;
  }

  console.error(`Unknown config subcommand "${sub}".`);
  printConfigHelp();
  process.exitCode = 1;
}

function setDeep(target: Record<string, unknown>, segments: string[], value: unknown): void {
  let cursor = target;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }
    const existing = cursor[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  });
}

function parseValue(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

// ---------------------------------------------------------------------------
// Help and formatting
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`${bold("wandey")} ${dim(VERSION)} — a small, unlimited research agent`);
  console.log("");
  console.log(`${bold("usage")}  wandey <command> [options]`);
  console.log("");
  console.log(`${bold("commands")}`);
  console.log(`  ${cyan("serve")}     start the local web UI and API ${dim("(default)")}`);
  console.log(`  ${cyan("chat")}      talk to the agent in this terminal`);
  console.log(`  ${cyan("models")}    list available models by provider`);
  console.log(`  ${cyan("doctor")}    check providers, storage, search, and tools`);
  console.log(`  ${cyan("config")}    show, initialize, or edit configuration`);
  console.log(`  ${cyan("version")}   print the version`);
  console.log("");
  console.log(`${bold("examples")}`);
  console.log("  wandey");
  console.log("  wandey serve --port 4319 --no-open");
  console.log("  wandey chat --model openrouter/google/gemma-4-31b-it:free");
  console.log("  wandey chat --research");
  console.log("  wandey models --free");
  console.log("");
  console.log(dim("Run `wandey <command> --help` for command options."));
}

function printServeHelp(): void {
  console.log("Usage: wandey serve [--port <n>] [--host <host>] [--model <ref>] [--no-open] [--dev]");
  console.log("");
  console.log("  --port       listen port (default 4319)");
  console.log("  --host       bind address (default 127.0.0.1)");
  console.log("  --model      default model for new sessions");
  console.log("  --no-open    do not open a browser");
  console.log("  --dev        rebuild the browser bundle on request");
  console.log("  --no-opencode  skip importing OpenCode credentials");
}

function printChatHelp(): void {
  console.log("Usage: wandey chat [--model <ref>] [--research] [--session <id> | --continue]");
  console.log("");
  console.log("  --model      model ref to use");
  console.log("  --research   start in deep-research mode");
  console.log("  --chat       force normal chat mode for a research session");
  console.log("  --session    resume a session by id");
  console.log("  --continue   resume the most recent session");
  console.log("  --reasoning  stream reasoning text");
}

function printConfigHelp(): void {
  console.log("Usage: wandey config [show|path|init|set]");
  console.log("");
  console.log("  show              print the merged config with secrets redacted");
  console.log("  path              print the config file path");
  console.log("  init [--force]    write a default config file");
  console.log("  set <key> <value> set a dotted key (values parse as JSON when possible)");
  console.log("");
  console.log(`  ${dim("wandey config set server.port 4319")}`);
  console.log(`  ${dim('wandey config set agent.model "openrouter/google/gemma-4-31b-it:free"')}`);
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}
