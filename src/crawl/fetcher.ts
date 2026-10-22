import type { CrawlConfig } from "../core/config.ts";
import type { FetchedPage } from "../core/types.ts";
import { canonicalURL, hostOf, isPDFURL } from "../core/url.ts";
import { truncate, wordCount } from "../core/util.ts";
import { extractHTML, extractPDF, markdownLinks, markdownTitle, markdownToText } from "./extract.ts";

/**
 * One HTTP fetcher, many content types.
 *
 * The fetcher is deliberately polite (identified UA, timeouts, response caps)
 * and resilient: if Readability comes back with a JavaScript shell it tries the
 * optional reader/backend path. Everything is cached in memory for a few
 * minutes so a crawler and the agent's own follow-up reads share work.
 */
export interface FetchPageOptions {
  signal?: AbortSignal;
  /** Skip the in-memory cache (used by refresh tools). */
  refresh?: boolean;
  /** Force the configured renderer/reader for this page. */
  forceReader?: boolean;
  /** Override the per-page content cap. */
  maxChars?: number;
}

interface CacheEntry {
  at: number;
  page: FetchedPage;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 300;

export class PageFetcher {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly config: CrawlConfig) {}

  async fetch(url: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
    const key = canonicalURL(url);
    if (!options.refresh) {
      const cached = this.cache.get(key);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return { ...cached.page, fromCache: true, via: "cache" };
      }
    }

    const started = Date.now();
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(this.config.timeoutMs)])
      : AbortSignal.timeout(this.config.timeoutMs);

    const useReaderFirst =
      options.forceReader ||
      this.config.render.backend === "reader" ||
      Boolean(this.config.render.backend === "firecrawl" || this.config.render.backend === "crawl4ai");

    if (useReaderFirst) {
      const rendered = await this.fetchRendered(url, options.signal);
      if (rendered && rendered.markdown.length > 80) {
        this.remember(key, rendered);
        return rendered;
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "follow",
        signal,
        headers: {
          "user-agent": this.config.userAgent,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/markdown;q=0.8,text/plain;q=0.8,application/pdf;q=0.7,*/*;q=0.5",
          "accept-language": "en-US,en;q=0.9",
        },
      });
    } catch (err) {
      return errorPage(url, (err as Error).name === "TimeoutError" ? `Timed out after ${this.config.timeoutMs}ms` : (err as Error).message, 0);
    }

    const finalUrl = response.url || url;
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const status = response.status;

    if (!response.ok) {
      // Read a little of the error body for a useful message, then discard.
      const body = response.body ? await readLimited(response.body, 20_000) : null;
      const detail = body ? decodeBody(body.bytes, contentType).replace(/\s+/g, " ").slice(0, 300) : "";
      return errorPage(finalUrl, `HTTP ${status}${detail ? `: ${detail}` : ""}`, status);
    }

    const body = response.body ? await readLimited(response.body, this.config.maxContentBytes) : null;
    if (!body) return errorPage(finalUrl, "Empty response body", status);
    const rawText = decodeBody(body.bytes, contentType);

    let page: FetchedPage;
    if (contentType.includes("pdf") || isPDFURL(finalUrl)) {
      page = await this.pdfPage(finalUrl, status, contentType, body.bytes, options);
    } else if (contentType.includes("html") || contentType.includes("xhtml") || lookLikeHTML(rawText)) {
      page = this.htmlPage(finalUrl, status, contentType, rawText, options);
    } else if (contentType.includes("json")) {
      page = this.jsonPage(finalUrl, status, contentType, rawText, options);
    } else if (isTextual(contentType)) {
      page = this.textPage(finalUrl, status, contentType, rawText, options);
    } else {
      return errorPage(finalUrl, `Unsupported content type: ${contentType || "unknown"}`, status);
    }

    // A JS-heavy page that Readability couldn't read: ask a renderer for help.
    const htmlNeedsHelp =
      page.contentType.includes("html") &&
      this.config.readerFallback &&
      !page.error &&
      (page.words < 15 || (page.isProbablyJSApp === true && page.words < 400));

    if (htmlNeedsHelp) {
      const rendered = await this.fetchRendered(finalUrl, options.signal);
      if (rendered && rendered.words > page.words + 50) {
        this.remember(key, rendered);
        return rendered;
      }
    }

    if (body.truncated && !page.error) {
      page.site = page.site || hostOf(finalUrl);
    }
    page.fetchedAt = Date.now();
    this.remember(key, page);
    if (process.env.WANDEY_DEBUG_FETCH) {
      console.error(`[fetch] ${status} ${contentType} ${page.words}w ${Date.now() - started}ms ${finalUrl}`);
    }
    return page;
  }

  private htmlPage(
    url: string,
    status: number,
    contentType: string,
    html: string,
    options: FetchPageOptions,
  ): FetchedPage {
    const extracted = extractHTML(html, url);
    const maxChars = options.maxChars ?? this.config.maxCharsPerPage;
    return {
      url,
      finalUrl: url,
      status,
      contentType,
      title: extracted.title,
      site: hostOf(url),
      markdown: truncate(extracted.markdown, maxChars),
      text: truncate(extracted.text, maxChars),
      links: extracted.links,
      words: extracted.words,
      fetchedAt: Date.now(),
      via: "http",
      isProbablyJSApp: extracted.isProbablyJSApp,
      headings: extracted.headings,
      excerpt: extracted.excerpt,
      byline: extracted.byline,
      publishedAt: extracted.publishedTime,
    } as FetchedPage;
  }

  private jsonPage(url: string, status: number, contentType: string, body: string, options: FetchPageOptions): FetchedPage {
    let pretty = body;
    try {
      pretty = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // keep raw
    }
    const markdown = truncate(`\`\`\`json\n${pretty}\n\`\`\``, options.maxChars ?? this.config.maxCharsPerPage);
    return {
      url,
      finalUrl: url,
      status,
      contentType,
      title: pathTitle(url),
      site: hostOf(url),
      markdown,
      text: truncate(pretty, options.maxChars ?? this.config.maxCharsPerPage),
      links: [],
      words: wordCount(pretty),
      fetchedAt: Date.now(),
      via: "http",
    };
  }

  private textPage(url: string, status: number, contentType: string, body: string, options: FetchPageOptions): FetchedPage {
    const maxChars = options.maxChars ?? this.config.maxCharsPerPage;
    const isMarkdown = contentType.includes("markdown") || /\.(md|markdown|mdx)$/i.test(new URL(url).pathname);
    const markdown = truncate(body, maxChars);
    return {
      url,
      finalUrl: url,
      status,
      contentType,
      title: isMarkdown ? markdownTitle(body, pathTitle(url)) : pathTitle(url),
      site: hostOf(url),
      markdown,
      text: truncate(isMarkdown ? markdownToText(body) : body, maxChars),
      links: isMarkdown ? markdownLinks(body, url) : [],
      words: wordCount(isMarkdown ? markdownToText(body) : body),
      fetchedAt: Date.now(),
      via: "http",
    };
  }

  private async pdfPage(
    url: string,
    status: number,
    contentType: string,
    bytes: Uint8Array,
    options: FetchPageOptions,
  ): Promise<FetchedPage> {
    if (this.config.pdf.enabled) {
      const extracted = await extractPDF(bytes, { command: this.config.pdf.command, signal: options.signal });
      if (extracted.text.trim()) {
        const text = truncate(extracted.text, options.maxChars ?? this.config.maxCharsPerPage);
        return {
          url,
          finalUrl: url,
          status,
          contentType,
          title: pathTitle(url),
          site: hostOf(url),
          markdown: text,
          text,
          links: [],
          words: wordCount(text),
          fetchedAt: Date.now(),
          via: "http",
        };
      }
      if (extracted.error && !this.config.readerFallback) {
        return errorPage(url, extracted.error, status);
      }
    }

    const rendered = await this.fetchRendered(url, options.signal);
    if (rendered) return rendered;
    return errorPage(url, "PDF content could not be extracted (install poppler/pdftotext or enable the reader fallback)", status);
  }

  /** Reader services turn JavaScript pages and PDFs into clean Markdown. */
  private async fetchRendered(url: string, signal?: AbortSignal): Promise<FetchedPage | null> {
    const backend = this.config.render.backend;
    if (backend === "firecrawl") {
      const page = await this.fetchFirecrawl(url, signal);
      if (page) return page;
    }
    if (backend === "crawl4ai") {
      const page = await this.fetchCrawl4AI(url, signal);
      if (page) return page;
    }
    if (backend === "none" && !this.config.readerFallback) return null;

    const base = this.config.render.backend === "reader" && this.config.render.endpoint
      ? this.config.render.endpoint
      : this.config.readerEndpoint;
    if (!base) return null;

    const timeout = AbortSignal.timeout(Math.max(this.config.timeoutMs, 25_000));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(`${base.replace(/\/+$/, "")}/${url}`, {
        headers: {
          accept: "text/markdown, text/plain;q=0.9",
          "user-agent": this.config.userAgent,
          ...(this.config.render.apiKey ? { authorization: `Bearer ${this.config.render.apiKey}` } : {}),
        },
        signal: combined,
      });
      if (!response.ok) return null;
      const raw = await response.text();
      if (raw.trim().length < 100) return null;
      return this.readerPage(url, raw);
    } catch {
      return null;
    }
  }

  private readerPage(url: string, raw: string): FetchedPage {
    const titleMatch = raw.match(/^Title:\s*(.+)$/m);
    const marker = raw.indexOf("Markdown Content:");
    let body = marker !== -1 ? raw.slice(marker + "Markdown Content:".length) : raw;
    body = body.replace(/^\s*URL Source:.*$/m, "").trim();
    const text = markdownToText(body);
    return {
      url,
      finalUrl: url,
      status: 200,
      contentType: "text/markdown; rendered",
      title: titleMatch?.[1]?.trim() || markdownTitle(body, hostOf(url) || pathTitle(url)),
      site: hostOf(url),
      markdown: truncate(body, this.config.maxCharsPerPage),
      text: truncate(text, this.config.maxCharsPerPage),
      links: markdownLinks(body, url),
      words: wordCount(text),
      fetchedAt: Date.now(),
      via: "reader",
    } as FetchedPage;
  }

  private async fetchFirecrawl(url: string, signal?: AbortSignal): Promise<FetchedPage | null> {
    const endpoint = this.config.render.endpoint || "https://api.firecrawl.dev";
    try {
      const response = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/scrape`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.render.apiKey ? { authorization: `Bearer ${this.config.render.apiKey}` } : {}),
        },
        body: JSON.stringify({ url, formats: ["markdown"] }),
        signal: AbortSignal.timeout(Math.max(this.config.timeoutMs, 60_000)),
      });
      if (!response.ok) return null;
      const json = (await response.json()) as {
        data?: { markdown?: string; metadata?: { title?: string; sourceURL?: string } };
      };
      const markdown = json.data?.markdown;
      if (!markdown?.trim()) return null;
      const text = markdownToText(markdown);
      return {
        url,
        finalUrl: json.data?.metadata?.sourceURL ?? url,
        status: 200,
        contentType: "text/markdown; firecrawl",
        title: json.data?.metadata?.title || markdownTitle(markdown, pathTitle(url)),
        site: hostOf(url),
        markdown: truncate(markdown, this.config.maxCharsPerPage),
        text: truncate(text, this.config.maxCharsPerPage),
        links: markdownLinks(markdown, url),
        words: wordCount(text),
        fetchedAt: Date.now(),
        via: "backend",
      };
    } catch {
      return null;
    }
  }

  private async fetchCrawl4AI(url: string, signal?: AbortSignal): Promise<FetchedPage | null> {
    const endpoint = this.config.render.endpoint || "http://127.0.0.1:11235";
    try {
      const response = await fetch(`${endpoint.replace(/\/+$/, "")}/md`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.render.apiKey ? { authorization: `Bearer ${this.config.render.apiKey}` } : {}),
        },
        body: JSON.stringify({ url, f: "fit" }),
        signal: AbortSignal.timeout(Math.max(this.config.timeoutMs, 60_000)),
      });
      if (!response.ok) return null;
      const markdown = await response.text();
      if (!markdown.trim()) return null;
      const text = markdownToText(markdown);
      return {
        url,
        finalUrl: url,
        status: 200,
        contentType: "text/markdown; crawl4ai",
        title: markdownTitle(markdown, pathTitle(url)),
        site: hostOf(url),
        markdown: truncate(markdown, this.config.maxCharsPerPage),
        text: truncate(text, this.config.maxCharsPerPage),
        links: markdownLinks(markdown, url),
        words: wordCount(text),
        fetchedAt: Date.now(),
        via: "backend",
      };
    } catch {
      return null;
    }
  }

  private remember(key: string, page: FetchedPage): void {
    if (page.error) return;
    this.cache.set(key, { at: Date.now(), page });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const first = this.cache.keys().next().value;
      if (first === undefined) break;
      this.cache.delete(first);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}

function errorPage(url: string, error: string, status: number): FetchedPage {
  return {
    url,
    finalUrl: url,
    status,
    contentType: "",
    title: pathTitle(url),
    site: hostOf(url),
    markdown: "",
    text: "",
    links: [],
    words: 0,
    fetchedAt: Date.now(),
    via: "http",
    error,
  };
}

function lookLikeHTML(text: string): boolean {
  const head = text.slice(0, 1000).toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html") || head.includes("<head");
}

function isTextual(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("xml") ||
    contentType.includes("rss") ||
    contentType.includes("atom") ||
    contentType.includes("markdown") ||
    contentType.includes("yaml") ||
    contentType.includes("csv")
  );
}

function pathTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "");
    if (!last) return parsed.hostname.replace(/^www\./, "");
    return last.replace(/[-_]+/g, " ").replace(/\.(html?|php|aspx?|pdf|md)$/i, "").trim() || parsed.hostname;
  } catch {
    return url;
  }
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = contentType.match(/charset=([^;\s]+)/i)?.[1]?.replace(/["']/g, "");
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      chunks.push(value.byteLength > remaining ? value.subarray(0, remaining) : value);
      total += Math.min(value.byteLength, remaining);
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}
