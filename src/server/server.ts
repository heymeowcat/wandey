import fs from "node:fs";
import path from "node:path";
import type { Config, Paths, ProviderConfig } from "../core/config.ts";
import { getApiKey, redactConfig, saveConfig } from "../core/config.ts";
import type { EventBus } from "../core/events.ts";
import { EventBus as Bus } from "../core/events.ts";
import type { ClientEvent, ProviderKind, ServerEvent, SessionMode } from "../core/types.ts";
import { Agent } from "../agent/agent.ts";
import { PageFetcher } from "../crawl/fetcher.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { templateFor } from "../providers/catalog.ts";
import { openCodeProviderConfigs } from "../integrations/opencode.ts";
import { SearchService } from "../search/search.ts";
import { Store } from "../storage/store.ts";
import { createToolRegistry } from "../tools/index.ts";
import { VERSION } from "../core/version.ts";

/**
 * The local server.
 *
 * One Bun process serves the API, the WebSocket event stream, and the compiled
 * browser UI. There is no build step in production: TypeScript in `web/` is
 * bundled in memory when the server starts, which keeps the deployment story to
 * "run one binary".
 */

const ROOT = path.resolve(import.meta.dir, "../..");

export interface ServerOptions {
  config: Config;
  paths: Paths;
  host?: string;
  port?: number;
  openBrowser?: boolean;
  /** Rebuild the browser bundle on every request (handy while editing the UI). */
  dev?: boolean;
}

export interface WandeyServer {
  url: string;
  port: number;
  stop(): void;
  store: Store;
  agent: Agent;
  bus: EventBus;
  registry: ProviderRegistry;
}

interface SocketData {
  sessionID: string | null;
}

interface ProviderUpsertBody {
  id?: string;
  name?: string;
  kind?: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  models?: string[] | string;
}

type Socket = Bun.ServerWebSocket<SocketData>;

export async function startServer(options: ServerOptions): Promise<WandeyServer> {
  const { config, paths } = options;
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.cacheDir, { recursive: true });

  const store = new Store(paths.dbFile);
  const recovered = store.recoverInterruptedResearchJobs();
  if (recovered > 0) {
    console.error(`[research] marked ${recovered} interrupted job(s) resumable`);
  }
  const registry = new ProviderRegistry(config);
  const bus = new Bus();
  const fetcher = new PageFetcher(config.crawl);
  const search = new SearchService(config);
  const tools = createToolRegistry();
  const agent = new Agent({ config, store, registry, tools, fetcher, search, bus });

  const sockets = new Set<Socket>();
  const indexHTML = await Bun.file(path.join(ROOT, "web", "index.html")).text();
  const styles = await Bun.file(path.join(ROOT, "web", "styles.css")).text();
  let bundle = await buildBrowserBundle();
  let bundleAt = Date.now();

  function send(socket: Socket, event: ServerEvent): void {
    try {
      socket.send(JSON.stringify(event));
    } catch {
      // The tab closed between the broadcast and this write.
    }
  }

  bus.on((event) => {
    for (const socket of sockets) send(socket, event);
  });

  async function currentBundle(): Promise<string> {
    if (options.dev && Date.now() - bundleAt > 1_000) {
      try {
        bundle = await buildBrowserBundle();
        bundleAt = Date.now();
      } catch (err) {
        console.error("[server] web bundle failed:", (err as Error).message);
      }
    }
    return bundle;
  }

  async function upsertProvider(body: ProviderUpsertBody): Promise<Response> {
    const requestedID = body.id?.trim().toLowerCase();
    const id = requestedID || slugProviderID(body.name ?? "");
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      return json({ error: "Provider id can only contain lowercase letters, numbers, dots, dashes, and underscores." }, 400);
    }

    const template = templateFor(id);
    const existing = config.providers[id];
    // Display names are slugged into ids. Never let a new custom endpoint
    // silently overwrite a built-in or another custom connection.
    if (!requestedID && (existing || template)) {
      return json(
        { error: "A provider with that name already exists. Choose a different display name." },
        409,
      );
    }

    const name = body.name?.trim() || existing?.name || template?.name || id;
    const kind = body.kind ?? existing?.kind ?? template?.kind ?? "openai";
    if (kind !== "openai" && kind !== "anthropic" && kind !== "gemini") {
      return json({ error: `Unsupported provider protocol "${kind}".` }, 400);
    }

    const baseUrl = (body.baseUrl?.trim() || existing?.baseUrl || template?.baseUrl || "").replace(/\/+$/, "");
    if (!baseUrl) return json({ error: "A base URL is required for this endpoint." }, 400);
    try {
      new URL(baseUrl);
    } catch {
      return json({ error: "That base URL is not a valid URL." }, 400);
    }

    const local = body.baseUrl?.trim()
      ? Boolean(template?.local || isLocalEndpoint(baseUrl))
      : Boolean(existing?.local ?? template?.local ?? isLocalEndpoint(baseUrl));
    const cfg: ProviderConfig = {
      ...(existing ?? {}),
      enabled: true,
      name,
      kind,
      baseUrl,
      local,
    };
    delete cfg.auto;

    const apiKey = body.apiKey?.trim();
    if (apiKey) cfg.apiKey = apiKey;
    if (body.models !== undefined) {
      const models = (Array.isArray(body.models) ? body.models : body.models.split(/[\n,]+/))
        .map((entry) => String(entry).trim())
        .filter(Boolean);
      if (models.length > 0) cfg.models = [...new Set(models)];
      else delete cfg.models;
    }

    // A remote provider cannot do anything without a key. Accept one from the
    // form, the saved config, an env var, or a key imported from OpenCode.
    // OpenAI-compatible custom endpoints may be unauthenticated proxies.
    const key = getApiKey(id, cfg);
    const imported = registry.catalog().find((entry) => entry.id === id);
    // Disconnecting an OpenCode-imported provider hides it without deleting
    // OpenCode's credentials. Reconnect can reuse those credentials because
    // they are still present in OpenCode's own store.
    const importedKey = config.integrations.opencode ? openCodeProviderConfigs()[id]?.apiKey : undefined;
    const usesImportedKey = Boolean(importedKey) || (imported?.source === "opencode" && imported.authenticated);
    if (!local && !key && !usesImportedKey) {
      if (template) {
        const env = template.env[0] ?? "its API key";
        return json(
          { error: `${template.name} needs an API key. Paste one here, or set ${env} and restart Wandey.` },
          400,
        );
      }
      if (kind !== "openai") {
        return json(
          { error: `${name} needs an API key for the ${kind === "anthropic" ? "Anthropic" : "Gemini"} API format.` },
          400,
        );
      }
    }

    config.providers[id] = cfg;
    try {
      saveConfig({ providers: { [id]: cfg } }, paths);
    } catch (err) {
      if (existing) config.providers[id] = existing;
      else delete config.providers[id];
      return json({ error: `Could not save the provider: ${(err as Error).message}` }, 500);
    }

    registry.reload(config);
    const models = await registry.listModels(true);
    const providers = await registry.statusesWithModels();
    return json(
      {
        id,
        provider: providers.find((entry) => entry.id === id) ?? null,
        models,
        providers,
        catalog: registry.catalog(),
      },
      201,
    );
  }

  async function setOpenCodeLocal(enabled: boolean): Promise<Response> {
    const previous = config.integrations.opencodeLocal;
    config.integrations.opencodeLocal = enabled;
    try {
      saveConfig({ integrations: { ...config.integrations, opencodeLocal: enabled } }, paths);
    } catch (err) {
      config.integrations.opencodeLocal = previous;
      return json({ error: `Could not save the integration: ${(err as Error).message}` }, 500);
    }

    registry.reload(config);
    const models = await registry.listModels(true);
    return json({
      enabled,
      opencodeLocal: enabled,
      models,
      providers: await registry.statusesWithModels(),
      catalog: registry.catalog(),
    });
  }

  async function disconnectProvider(rawID: string): Promise<Response> {
    const id = rawID.toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      return json({ error: "Invalid provider id." }, 400);
    }
    const existing = config.providers[id];
    const template = templateFor(id);
    const known = existing || template || registry.catalog().some((entry) => entry.id === id);
    if (!known) return json({ error: "Provider not found." }, 404);

    // Keep enough information to reconnect later, but remove credentials and
    // authorization headers. A disconnect should not leave a secret on disk.
    const disabled: ProviderConfig = {
      enabled: false,
      ...(existing?.kind || template?.kind ? { kind: existing?.kind ?? template?.kind } : {}),
      ...(existing?.name || template?.name ? { name: existing?.name ?? template?.name } : {}),
      ...(existing?.baseUrl || template?.baseUrl ? { baseUrl: existing?.baseUrl ?? template?.baseUrl } : {}),
      ...(existing?.local ?? template?.local ? { local: existing?.local ?? template?.local } : {}),
      ...(existing?.models?.length ? { models: [...existing.models] } : {}),
      ...(existing?.description ? { description: existing.description } : {}),
    };
    config.providers[id] = disabled;
    try {
      saveConfig({ providers: { [id]: disabled } }, paths);
    } catch (err) {
      if (existing) config.providers[id] = existing;
      else delete config.providers[id];
      return json({ error: `Could not update the provider: ${(err as Error).message}` }, 500);
    }

    registry.reload(config);
    await registry.listModels(true);
    return json({
      ok: true,
      providers: await registry.statusesWithModels(),
      catalog: registry.catalog(),
    });
  }

  const server = Bun.serve<SocketData, never>({
    hostname: options.host ?? config.server.host,
    port: options.port ?? config.server.port,
    development: false,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (pathname === "/ws") {
        const ok = srv.upgrade(req, { data: { sessionID: null } });
        return ok ? undefined : json({ error: "Expected a WebSocket upgrade" }, 400);
      }

      try {
        if (pathname === "/api/health") {
          return json({ ok: true, version: VERSION, uptime: process.uptime() });
        }

        if (pathname === "/api/models") {
          const [models, providers] = await Promise.all([registry.listModels(), registry.statusesWithModels()]);
          return json({ models, providers });
        }

        if (pathname === "/api/providers") {
          if (req.method === "GET") {
            await registry.listModels();
            return json({
              providers: await registry.statusesWithModels(),
              catalog: registry.catalog(),
              configFile: paths.configFile,
              opencode: config.integrations.opencode,
              opencodeLocal: config.integrations.opencodeLocal,
            });
          }
          if (req.method === "POST") {
            const body = await readBody<ProviderUpsertBody>(req);
            return await upsertProvider(body);
          }
          return json({ error: "Method not allowed" }, 405);
        }

        if (pathname === "/api/integrations/opencode-local" && req.method === "POST") {
          const body = await readBody<{ enabled?: boolean }>(req);
          return await setOpenCodeLocal(Boolean(body.enabled));
        }

        if (pathname === "/api/providers/refresh" && req.method === "POST") {
          const models = await registry.listModels(true);
          return json({
            models,
            providers: await registry.statusesWithModels(),
            catalog: registry.catalog(),
          });
        }

        const providerMatch = pathname.match(/^\/api\/providers\/([^/]+)$/);
        if (providerMatch && req.method === "DELETE") {
          return await disconnectProvider(decodeURIComponent(providerMatch[1]!));
        }

        if (pathname === "/api/config") {
          return json({
            config: redactConfig(config),
            paths: { home: paths.home, configFile: paths.configFile, dbFile: paths.dbFile },
          });
        }

        if (pathname === "/api/sessions" && req.method === "GET") {
          return json({ sessions: store.listSessions() });
        }

        if (pathname === "/api/sessions" && req.method === "POST") {
          const body = await readBody<{ title?: string; mode?: SessionMode; model?: string | null }>(req);
          const session = store.createSession({
            title: body.title,
            mode: body.mode,
            model: body.model ?? config.agent.model ?? null,
          });
          bus.publish({ type: "session.updated", session });
          return json({ session }, 201);
        }

        const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.+))?$/);
        if (sessionMatch) {
          const sessionID = decodeURIComponent(sessionMatch[1]!);
          const rest = sessionMatch[2] ?? "";
          const session = store.getSession(sessionID);
          if (!session) return json({ error: "Session not found" }, 404);

          if (!rest && req.method === "GET") {
            const detail = store.getSessionDetail(sessionID);
            return json({ ...detail, running: agent.isRunning(sessionID) });
          }

          if (!rest && req.method === "PATCH") {
            const body = await readBody<{ title?: string; model?: string | null; mode?: SessionMode; archived?: boolean }>(req);
            const updated = store.updateSession(sessionID, body);
            if (!updated) return json({ error: "Session not found" }, 404);
            bus.publish({ type: "session.updated", session: updated });
            return json({ session: updated });
          }

          if (!rest && req.method === "DELETE") {
            agent.abort(sessionID);
            store.deleteSession(sessionID);
            bus.publish({ type: "session.deleted", sessionID });
            return json({ ok: true });
          }

          if (rest === "prompt" && req.method === "POST") {
            if (agent.isRunning(sessionID)) return json({ error: "Session is already running" }, 409);
            const body = await readBody<{ text?: string; model?: string; mode?: SessionMode }>(req);
            if (!body.text?.trim()) return json({ error: "Prompt text is required" }, 400);
            const message = await agent.prompt(sessionID, body.text, { model: body.model, mode: body.mode });
            return json({ message }, 202);
          }

          if (rest === "abort" && req.method === "POST") {
            return json({ aborted: agent.abort(sessionID) });
          }

          if (rest === "answer" && req.method === "POST") {
            const body = await readBody<{ questionID?: string; answer?: string[]; custom?: string }>(req);
            if (!body.questionID) return json({ error: "questionID is required" }, 400);
            const answered = agent.answerQuestion(body.questionID, body.answer ?? [], body.custom);
            if (!answered) return json({ error: "That question is no longer open." }, 409);
            return json({ ok: true });
          }

          if (rest === "research" && req.method === "GET") {
            return json({ jobs: store.listResearchJobs(sessionID) });
          }

          const sourceMatch = rest.match(/^sources\/([^/]+)$/);
          if (sourceMatch && req.method === "GET") {
            const source = store.getSource(sessionID, decodeURIComponent(sourceMatch[1]!));
            if (!source) return json({ error: "Source not found" }, 404);
            return json({ source });
          }

          return json({ error: "Not found" }, 404);
        }

        const resumeMatch = pathname.match(/^\/api\/research\/([^/]+)\/resume$/);
        if (resumeMatch && req.method === "POST") {
          const jobID = decodeURIComponent(resumeMatch[1]!);
          const job = store.getResearchJob(jobID);
          if (!job) return json({ error: "Research job not found" }, 404);
          try {
            const message = await agent.resumeResearch(jobID);
            return json({ message }, 202);
          } catch (err) {
            return json({ error: (err as Error).message }, 409);
          }
        }

        const jobMatch = pathname.match(/^\/api\/research\/([^/]+)$/);
        if (jobMatch && req.method === "GET") {
          const job = store.getResearchJob(decodeURIComponent(jobMatch[1]!));
          if (!job) return json({ error: "Research job not found" }, 404);
          return json({
            job,
            notes: store.listNotes(job.id),
            sources: store.listSources(job.sessionID),
          });
        }

        // -------------------------------------------------------------------
        // Static assets and the compiled app
        // -------------------------------------------------------------------
        if (pathname === "/" || pathname === "/index.html") {
          return new Response(indexHTML, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        if (pathname === "/app.js") {
          return new Response(await currentBundle(), {
            headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
          });
        }
        if (pathname === "/styles.css") {
          return new Response(styles, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } });
        }
        if (pathname === "/favicon.svg") {
          return serveFile(path.join(ROOT, "web", "favicon.svg"));
        }
        if (pathname.startsWith("/assets/")) {
          return serveFile(path.join(ROOT, "web", pathname.slice(1)));
        }

        return json({ error: "Not found" }, 404);
      } catch (err) {
        console.error("[server] request failed:", err);
        return json({ error: (err as Error).message }, 500);
      }
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        send(socket, { type: "hello", data: { version: VERSION, models: [] } });
      },
      message(socket, raw) {
        void handleClientEvent(socket, String(raw));
      },
      close(socket) {
        sockets.delete(socket);
      },
    },
  });

  async function handleClientEvent(socket: Socket, raw: string): Promise<void> {
    let event: ClientEvent;
    try {
      event = JSON.parse(raw) as ClientEvent;
    } catch {
      return;
    }

    if (event.type === "ping") {
      socket.send(JSON.stringify({ type: "hello", data: { version: VERSION, models: [] } }));
      return;
    }
    if (event.type === "subscribe") {
      socket.data.sessionID = event.sessionID;
      return;
    }
    if (!store.getSession(event.sessionID)) {
      send(socket, { type: "toast", level: "error", message: "Session not found" });
      return;
    }

    try {
      if (event.type === "prompt") {
        await agent.prompt(event.sessionID, event.text, { model: event.model, mode: event.mode });
      } else if (event.type === "abort") {
        agent.abort(event.sessionID);
      } else if (event.type === "answer") {
        const ok = agent.answerQuestion(event.questionID, event.answer, event.custom);
        if (!ok) send(socket, { type: "toast", level: "error", message: "That question is no longer open." });
      }
    } catch (err) {
      send(socket, { type: "toast", level: "error", message: (err as Error).message });
    }
  }

  const host = options.host ?? config.server.host;
  const port = server.port ?? options.port ?? config.server.port;
  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  console.log(`[wandey] ${url}`);

  if (options.openBrowser) openBrowser(url);

  return {
    url,
    port,
    store,
    agent,
    bus,
    registry,
    stop() {
      agent.abortAll();
      registry.stop();
      store.recoverInterruptedResearchJobs("Interrupted by a server shutdown. Resume it to continue.");
      server.stop(true);
      store.close();
    },
  };
}

async function buildBrowserBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(ROOT, "web", "main.ts")],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    const details = result.logs.map((log) => String(log)).join("\n");
    throw new Error(`Could not bundle web/main.ts:\n${details}`);
  }
  const output = result.outputs.find((entry) => entry.path.endsWith(".js"));
  if (!output) throw new Error("Web bundle produced no JavaScript output");
  return output.text();
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function readBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

function slugProviderID(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
  } catch {
    return false;
  }
}

async function serveFile(file: string): Promise<Response> {
  const handle = Bun.file(file);
  if (!(await handle.exists())) return json({ error: "Not found" }, 404);
  return new Response(handle, { headers: { "cache-control": "public, max-age=60" } });
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    Bun.spawn([command, ...args], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // Headless environments don't have a browser; the URL is logged above.
  }
}
