import { parseHTML } from "linkedom";
import type { Config, SearchProviderConfig } from "../core/config.ts";
import type { SearchResult } from "../core/types.ts";
import { canonicalURL } from "../core/url.ts";

/**
 * Search is pluggable and degrades gracefully.
 *
 * Out of the box wandey uses Bing's RSS endpoint plus Wikipedia, both of which
 * need no key. Add Brave, Tavily, Exa, or a SearXNG instance for better recall;
 * results from every provider are merged round-robin so one API can't crowd out
 * the others.
 */
export interface SearchOptions {
  count?: number;
  signal?: AbortSignal;
  providers?: SearchProviderConfig[];
}

export interface SearchResponse {
  results: SearchResult[];
  warnings: string[];
}

export class SearchService {
  constructor(private readonly config: Config) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const providers = (options.providers ?? this.config.search.providers).filter((provider) => provider.enabled !== false);
    const count = Math.max(1, options.count ?? this.config.search.maxResults);
    const warnings: string[] = [];

    if (!query.trim()) return { results: [], warnings: ["Empty search query"] };
    if (providers.length === 0) return { results: [], warnings: ["No search providers are configured"] };

    const settled = await Promise.allSettled(
      providers.map(async (provider) => ({
        provider: provider.type,
        results: await this.runProvider(provider, query, count, options.signal),
      })),
    );

    const buckets: SearchResult[][] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        if (result.value.results.length > 0) buckets.push(result.value.results);
      } else {
        const label = providers[index]?.type ?? "unknown";
        warnings.push(`${label}: ${(result.reason as Error)?.message ?? String(result.reason)}`);
      }
    });

    const merged: SearchResult[] = [];
    const seen = new Set<string>();
    let cursor = 0;
    while (merged.length < count && buckets.some((bucket) => cursor < bucket.length)) {
      for (const bucket of buckets) {
        const result = bucket[cursor];
        if (!result) continue;
        const key = canonicalURL(result.url);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({ ...result, url: key });
        if (merged.length >= count) break;
      }
      cursor++;
    }

    if (merged.length === 0 && providers.length > 0) {
      warnings.push("Every search provider returned no usable results");
    }
    return { results: merged, warnings };
  }

  private async runProvider(
    provider: SearchProviderConfig,
    query: string,
    count: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    switch (provider.type) {
      case "bing":
        return this.bing(query, count, signal);
      case "wikipedia":
        return this.wikipedia(query, count, signal);
      case "duckduckgo":
        return this.duckduckgo(query, count, signal);
      case "searxng":
        return this.searxng(provider.baseUrl, query, count, signal);
      case "brave":
        return this.brave(this.requireKey(provider, ["BRAVE_API_KEY"]), query, count, signal);
      case "tavily":
        return this.tavily(this.requireKey(provider, ["TAVILY_API_KEY"]), query, count, signal);
      case "exa":
        return this.exa(this.requireKey(provider, ["EXA_API_KEY"]), query, count, signal);
      default:
        throw new Error(`Unknown search provider "${(provider as { type?: string }).type}"`);
    }
  }

  private async bing(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}&count=${Math.min(count * 2, 50)}`;
    const xml = await this.getText(url, signal, "bing");
    const results: SearchResult[] = [];
    for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
      const item = match[1] ?? "";
      const title = xmlValue(item, "title");
      const link = xmlValue(item, "link");
      const description = stripHTML(xmlValue(item, "description"));
      if (!title || !link) continue;
      results.push({
        title,
        url: link,
        snippet: description,
        provider: "bing",
        publishedAt: xmlValue(item, "pubDate") || undefined,
      });
      if (results.length >= count) break;
    }
    return results;
  }

  private async wikipedia(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${Math.min(count, 20)}&origin=*`;
    const json = await this.getJSON<{ query?: { search?: Array<{ title: string; snippet: string; timestamp?: string }> } }>(url, signal, "wikipedia");
    return (json.query?.search ?? []).map((row) => ({
      title: row.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(row.title.replace(/ /g, "_"))}`,
      snippet: stripHTML(row.snippet ?? ""),
      provider: "wikipedia",
      publishedAt: row.timestamp,
    }));
  }

  private async duckduckgo(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const html = await this.getText(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`,
      signal,
      "duckduckgo",
    );
    const { document } = parseHTML(html);
    const results: SearchResult[] = [];
    const nodes = document.querySelectorAll(".result");
    for (let i = 0; i < nodes.length && results.length < count; i++) {
      const node = nodes[i] as unknown as Element;
      const anchor = node.querySelector(".result__a");
      const title = anchor?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const href = anchor?.getAttribute("href") ?? "";
      const snippet = node.querySelector(".result__snippet")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (!title || !href) continue;
      results.push({ title, url: decodeDDGRedirect(href), snippet, provider: "duckduckgo" });
    }
    return results;
  }

  private async searxng(baseUrl: string, query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const base = baseUrl.replace(/\/+$/, "");
    const url = `${base.endsWith("/search") ? base : `${base}/search`}?q=${encodeURIComponent(query)}&format=json&safesearch=0`;
    const json = await this.getJSON<{ results?: Array<{ title?: string; url?: string; content?: string; engine?: string; publishedDate?: string; score?: number }> }>(
      url,
      signal,
      "searxng",
    );
    return (json.results ?? [])
      .filter((row) => row.title && row.url)
      .slice(0, count)
      .map((row) => ({
        title: row.title!,
        url: row.url!,
        snippet: row.content ?? "",
        provider: `searxng${row.engine ? `:${row.engine}` : ""}`,
        publishedAt: row.publishedDate,
        score: row.score,
      }));
  }

  private async brave(apiKey: string, query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}&text_decorations=false`;
    const json = await this.getJSON<{ web?: { results?: Array<{ title: string; url: string; description?: string; age?: string }> } }>(
      url,
      signal,
      "brave",
      { "X-Subscription-Token": apiKey },
    );
    return (json.web?.results ?? []).slice(0, count).map((row) => ({
      title: row.title,
      url: row.url,
      snippet: stripHTML(row.description ?? ""),
      provider: "brave",
      publishedAt: row.age,
    }));
  }

  private async tavily(apiKey: string, query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const json = await this.postJSON<{ results?: Array<{ title?: string; url?: string; content?: string; published_date?: string; score?: number }> }>(
      "https://api.tavily.com/search",
      { api_key: apiKey, query, max_results: Math.min(count, 20), search_depth: "advanced", include_answer: false, include_raw_content: false },
      signal,
      "tavily",
    );
    return (json.results ?? []).filter((row) => row.title && row.url).slice(0, count).map((row) => ({
      title: row.title!,
      url: row.url!,
      snippet: row.content ?? "",
      provider: "tavily",
      publishedAt: row.published_date,
      score: row.score,
    }));
  }

  private async exa(apiKey: string, query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const json = await this.postJSON<{ results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string; score?: number }> }>(
      "https://api.exa.ai/search",
      { query, numResults: Math.min(count, 20), contents: { text: { maxCharacters: 600 } } },
      signal,
      "exa",
      { "x-api-key": apiKey },
    );
    return (json.results ?? []).filter((row) => row.title && row.url).slice(0, count).map((row) => ({
      title: row.title!,
      url: row.url!,
      snippet: (row.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      provider: "exa",
      publishedAt: row.publishedDate,
      score: row.score,
    }));
  }

  private requireKey(provider: { apiKey?: string; apiKeyEnv?: string; type: string }, envNames: string[]): string {
    if (provider.apiKey?.trim()) return provider.apiKey.trim();
    if (provider.apiKeyEnv && Bun.env[provider.apiKeyEnv]?.trim()) return Bun.env[provider.apiKeyEnv]!.trim();
    for (const name of envNames) {
      if (Bun.env[name]?.trim()) return Bun.env[name]!.trim();
    }
    throw new Error(`${provider.type}: no API key configured`);
  }

  private async getText(url: string, signal: AbortSignal | undefined, label: string): Promise<string> {
    const response = await this.request(url, {}, signal, label);
    return response.text();
  }

  private async getJSON<T>(url: string, signal: AbortSignal | undefined, label: string, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.request(url, { headers }, signal, label);
    return (await response.json()) as T;
  }

  private async postJSON<T>(
    url: string,
    body: unknown,
    signal: AbortSignal | undefined,
    label: string,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await this.request(
      url,
      { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) },
      signal,
      label,
    );
    return (await response.json()) as T;
  }

  private async request(url: string, init: RequestInit, signal: AbortSignal | undefined, label: string): Promise<Response> {
    const timeout = AbortSignal.timeout(15_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: combined,
        redirect: "follow",
        headers: {
          "user-agent": this.config.crawl.userAgent,
          accept: "application/json, application/xml, text/html;q=0.9, */*;q=0.5",
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      if (signal?.aborted || (err as Error).name === "AbortError") {
        throw new DOMException("Aborted", "AbortError");
      }
      throw new Error(`${label}: ${(err as Error).message}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${label}: HTTP ${response.status}${body ? ` — ${body.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
    }
    return response;
  }
}

function xmlValue(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  return decodeEntities(match[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim());
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHTML(html: string): string {
  if (!html) return "";
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeDDGRedirect(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return href;
  }
}
