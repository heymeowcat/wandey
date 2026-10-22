import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FetchedPage, SourcePartData } from "../core/types.ts";
import { slugify, truncate } from "../core/util.ts";
import { Crawler } from "../crawl/crawler.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";
import { optionalBoolean, optionalNumber, optionalString, optionalStringArray, requiredString } from "./types.ts";

/**
 * The web toolkit. Four verbs: search, fetch one page, crawl a site, read a
 * stored source. Every fetched page gets a short `[S1]` style id so the model
 * can cite it and the UI can link back without blowing up the prompt.
 */

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web. Returns titles, URLs and snippets, with several providers merged. Use it to discover sources before fetching. Follow up with fetch_url or crawl_site to read what matters.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query. Be specific; include dates or site names when relevant." },
      count: { type: "integer", description: "Number of results, 1-20. Default 8." },
    },
    required: ["query"],
  },

  async execute(args, ctx): Promise<ToolResult> {
    const query = requiredString(args, "query");
    const count = Math.min(Math.max(optionalNumber(args, "count") ?? 8, 1), 20);
    const response = await ctx.search.search(query, { count, signal: ctx.signal });
    if (response.results.length === 0) {
      return {
        title: `Search: ${query}`,
        output: `No results.${response.warnings.length ? `\nWarnings: ${response.warnings.join("; ")}` : ""}`,
        metadata: response,
        isError: true,
      };
    }
    const lines = response.results.map((result, index) => {
      const meta = [result.provider, result.publishedAt].filter(Boolean).join(" · ");
      return `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}${meta ? `\n   (${meta})` : ""}`;
    });
    return {
      title: `Search: ${truncate(query, 60)}`,
      output: `${lines.join("\n\n")}${response.warnings.length ? `\n\nSearch warnings: ${response.warnings.join("; ")}` : ""}`,
      metadata: response,
    };
  },
};

export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description:
    "Read one or more web pages and save them as sources. Returns readable Markdown with a source id like [S1] for citations. Use read_source later to page through long pages without refetching.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Page URL to read." },
      urls: { type: "array", items: { type: "string" }, description: "Several URLs to read at once (max 5)." },
      max_chars: { type: "integer", description: "Characters of content per page, 1000-40000. Default 12000." },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const urls = [...new Set([
      ...(optionalString(args, "url") ? [optionalString(args, "url")!] : []),
      ...(optionalStringArray(args, "urls") ?? []),
    ])].slice(0, 5);
    if (urls.length === 0) throw new Error('Provide "url" or "urls"');

    const maxChars = Math.min(Math.max(optionalNumber(args, "max_chars") ?? 12_000, 1_000), 40_000);
    const sources: SourcePartData[] = [];
    const chunks: string[] = [];
    let budget = 26_000;

    for (const url of urls) {
      const page = await ctx.fetcher.fetch(url, { signal: ctx.signal });
      if (page.error) {
        chunks.push(`### Failed: ${url}\n${page.error}`);
        continue;
      }
      const added = ctx.store.addSource(ctx.sessionID, page);
      sources.push(added.source);
      chunks.push(formatPage(page, added.source.sourceID, Math.min(maxChars, Math.max(1000, budget))));
      budget -= Math.min(maxChars, 12_000);
      if (budget <= 1000) break;
    }

    return {
      title: urls.length === 1 ? `Fetched ${urls[0]}` : `Fetched ${urls.length} pages`,
      output: chunks.join("\n\n---\n\n"),
      sources,
      metadata: { urls, sourceIDs: sources.map((source) => source.sourceID) },
    };
  },
};

export const crawlSiteTool: Tool = {
  name: "crawl_site",
  description:
    "Crawl a website starting from one or more URLs. Follows links, respects robots.txt, deduplicates pages, extracts readable Markdown, and saves every page as a source. Every bound is configurable; for deep research prefer deep_research instead. Use read_source to read full pages from the returned source ids.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Seed URL." },
      urls: { type: "array", items: { type: "string" }, description: "Multiple seed URLs." },
      max_pages: { type: "integer", description: "Page budget, 1-2000. Defaults to crawl.maxPagesPerCall (12 out of the box)." },
      max_depth: { type: "integer", description: "Link depth from the seeds, 0-8. Defaults to crawl.maxDepth (1 out of the box)." },
      same_domain: { type: "boolean", description: "Stay on the seed sites. Default true." },
      include_paths: { type: "array", items: { type: "string" }, description: "Only follow URL paths matching these prefixes/globs, e.g. /docs/*." },
      exclude_paths: { type: "array", items: { type: "string" }, description: "Skip URL paths matching these prefixes/globs." },
      include_sitemaps: { type: "boolean", description: "Also seed from sitemap.xml. Defaults to crawl.useSitemaps (true out of the box)." },
      time_budget_seconds: { type: "integer", description: "Hard time budget, 10-600 seconds. Default 60." },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const seeds = [...new Set([
      ...(optionalString(args, "url") ? [optionalString(args, "url")!] : []),
      ...(optionalStringArray(args, "urls") ?? []),
    ])];
    if (seeds.length === 0) throw new Error('Provide "url" or "urls"');

    const maxPages = Math.min(Math.max(optionalNumber(args, "max_pages") ?? ctx.config.crawl.maxPagesPerCall, 1), 2000);
    const maxDepth = Math.min(Math.max(optionalNumber(args, "max_depth") ?? ctx.config.crawl.maxDepth, 0), 8);
    const sameDomain = optionalBoolean(args, "same_domain") ?? true;
    const includePaths = optionalStringArray(args, "include_paths");
    const excludePaths = optionalStringArray(args, "exclude_paths");
    const includeSitemaps = optionalBoolean(args, "include_sitemaps") ?? ctx.config.crawl.useSitemaps;
    const timeBudget = Math.min(Math.max(optionalNumber(args, "time_budget_seconds") ?? 60, 10), 600) * 1000;

    const crawler = new Crawler(ctx.fetcher, ctx.config.crawl);
    const result = await crawler.crawl({
      seeds,
      maxPages,
      maxDepth,
      sameDomain,
      allowPatterns: includePaths,
      denyPatterns: excludePaths,
      includeSitemaps,
      timeBudgetMs: timeBudget,
      signal: ctx.signal,
      onProgress: (event) => {
        ctx.emit({
          type: "crawl.progress",
          sessionID: ctx.sessionID,
          progress: {
            jobID: ctx.callID,
            kind: event.kind,
            url: event.url,
            queued: event.queued,
            active: event.active,
            fetched: event.fetched,
            failed: event.failed,
            message: event.message,
          },
        });
      },
    });

    const sources: SourcePartData[] = [];
    const lines: string[] = [];
    let budget = 20_000;
    for (const page of result.pages) {
      const added = ctx.store.addSource(ctx.sessionID, page);
      sources.push(added.source);
      if (budget > 500) {
        const excerpt = page.markdown
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 350);
        lines.push(
          `[${added.source.sourceID}] ${page.title}\n${page.finalUrl} · ${page.words} words\n${excerpt}${excerpt.length >= 350 ? "…" : ""}`,
        );
        budget -= excerpt.length + 120;
      }
    }

    const summary = [
      `Crawled ${result.pages.length} page(s) from ${seeds.length} seed(s) in ${(result.durationMs / 1000).toFixed(1)}s (${result.stopped}).`,
      result.errors.length > 0
        ? `Errors: ${result.errors.slice(0, 5).map((error) => `${error.url} — ${error.error}`).join("; ")}${result.errors.length > 5 ? ` (+${result.errors.length - 5} more)` : ""}`
        : "",
      result.skipped > 0 ? `Skipped ${result.skipped} URLs (assets, robots.txt, filters).` : "",
      "",
      "Sources saved. Use read_source with a source id for full text.",
      "",
      ...lines,
    ].filter(Boolean).join("\n");

    return {
      title: `Crawled ${result.pages.length} pages`,
      output: truncate(summary, 26_000),
      sources,
      metadata: {
        stopped: result.stopped,
        durationMs: result.durationMs,
        errors: result.errors.slice(0, 20),
        skipped: result.skipped,
      },
    };
  },
};

export const readSourceTool: Tool = {
  name: "read_source",
  description:
    "Read a saved source by id (for example S3). Supports character ranges so long pages don't flood the context. Sources are created by fetch_url, crawl_site, and deep_research.",
  parameters: {
    type: "object",
    properties: {
      source_id: { type: "string", description: "Source id like S3 (or just 3)." },
      offset: { type: "integer", description: "Start character. Default 0." },
      limit: { type: "integer", description: "Characters to return, 500-40000. Default 8000." },
    },
    required: ["source_id"],
  },

  async execute(args, ctx): Promise<ToolResult> {
    const rawID = normalizeSourceID(requiredString(args, "source_id"));
    const source = ctx.store.getSource(ctx.sessionID, rawID);
    if (!source) {
      throw new Error(`Source ${rawID} not found in this session. Use list_sources to see available ids.`);
    }
    const content = source.content || source.text;
    const offset = Math.max(optionalNumber(args, "offset") ?? 0, 0);
    const limit = Math.min(Math.max(optionalNumber(args, "limit") ?? 8000, 500), 40_000);
    const slice = content.slice(offset, offset + limit);
    return {
      title: `Read ${rawID}: ${truncate(source.title, 60)}`,
      output: `[${rawID}] ${source.title}\n${source.url}\nCharacters ${offset}-${Math.min(offset + limit, content.length)} of ${content.length}\n\n${slice}`,
      metadata: { sourceID: rawID, offset, limit, total: content.length, url: source.url },
    };
  },
};

export const listSourcesTool: Tool = {
  name: "list_sources",
  description: "List every source saved in this session with its id, title, URL and a short snippet.",
  parameters: { type: "object", properties: {} },

  async execute(_args, ctx): Promise<ToolResult> {
    const sources = ctx.store.listSources(ctx.sessionID);
    if (sources.length === 0) return { title: "No sources yet", output: "No sources have been saved in this session yet." };
    const lines = sources.map((source) => `[${source.sourceID}] ${source.title}\n${source.url}\n${truncate(source.snippet ?? "", 160)}`);
    return {
      title: `${sources.length} sources`,
      output: truncate(lines.join("\n\n"), 24_000),
      metadata: { count: sources.length },
    };
  },
};

export const saveReportTool: Tool = {
  name: "save_report",
  description:
    "Save a finished Markdown report to the research output directory. Use this when the user asks for a deliverable, or when a long investigation deserves a durable artifact. Returns the absolute file path.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Report title, used for the filename." },
      markdown: { type: "string", description: "Full Markdown report, including citations like [S1]." },
    },
    required: ["title", "markdown"],
  },

  async execute(args, ctx): Promise<ToolResult> {
    const title = requiredString(args, "title");
    const markdown = requiredString(args, "markdown");
    const dir = path.resolve(expandHome(ctx.config.research.outputDir) || path.join(os.tmpdir(), "wandey-research"));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const file = path.join(dir, `${slugify(title)}-${stamp}.md`);
    await Bun.write(file, `${markdown}\n`);
    return {
      title: `Saved report: ${title}`,
      output: `Report saved to ${file}\n(${markdown.length.toLocaleString()} characters)`,
      metadata: { path: file, title, chars: markdown.length },
    };
  },
};

export function createWebTools(): Tool[] {
  return [webSearchTool, fetchUrlTool, crawlSiteTool, readSourceTool, listSourcesTool, saveReportTool];
}

function formatPage(page: FetchedPage, sourceID: string, maxChars: number): string {
  const header = `### [${sourceID}] ${page.title}\nURL: ${page.finalUrl}\n${page.words.toLocaleString()} words · ${page.via}`;
  const body = truncate(page.markdown.trim(), maxChars);
  return `${header}\n\n${body}`;
}

function normalizeSourceID(input: string): string {
  const clean = input.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/^#/, "");
  if (/^s?\d+$/i.test(clean)) return `s${clean.replace(/^s/i, "")}`;
  return clean;
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}
