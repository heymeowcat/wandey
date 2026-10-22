import type { CrawlConfig } from "../core/config.ts";
import type { FetchedPage } from "../core/types.ts";
import { canonicalURL, hostOf, isAssetURL, matchesPattern, originOf, sameSite } from "../core/url.ts";
import { Semaphore, sleep } from "../core/util.ts";
import { isAllowed, loadRobots, robotsPath, type RobotsPolicy } from "./robots.ts";
import type { PageFetcher } from "./fetcher.ts";

/**
 * The crawler: a bounded queue with a frontier, politeness, and optional
 * sitemap discovery.
 *
 * "Unlimited" means every bound here is a knob. With a large `maxPages`,
 * `maxDepth`, concurrency and time budget, this will happily walk a site of any
 * size. Defaults stay polite so a throwaway question doesn't DoS a blog.
 */
export interface CrawlOptions {
  seeds: string[];
  maxPages?: number;
  maxDepth?: number;
  sameDomain?: boolean;
  allowPatterns?: string[];
  denyPatterns?: string[];
  respectRobots?: boolean;
  includeSitemaps?: boolean;
  delayMs?: number;
  concurrency?: number;
  perHost?: number;
  timeBudgetMs?: number;
  maxCharsPerPage?: number;
  /** Allow links that resolve to private/local hosts. Off by default. */
  allowPrivateHosts?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: CrawlEvent) => void;
}

export interface CrawlEvent {
  kind: "discovered" | "fetching" | "fetched" | "failed" | "skipped";
  url: string;
  queued: number;
  active: number;
  fetched: number;
  failed: number;
  message?: string;
}

export interface CrawlError {
  url: string;
  error: string;
  status?: number;
}

export interface CrawlResult {
  pages: FetchedPage[];
  errors: CrawlError[];
  skipped: number;
  stopped: "exhausted" | "max-pages" | "time" | "aborted";
  startedAt: number;
  durationMs: number;
}

interface QueueItem {
  url: string;
  depth: number;
  seed: string;
}

interface HostState {
  sem: Semaphore;
  lastRequest: number;
  delayMs: number;
}

export class Crawler {
  private hostStates = new Map<string, HostState>();

  constructor(
    private readonly fetcher: PageFetcher,
    private readonly config: CrawlConfig,
  ) {}

  async crawl(options: CrawlOptions): Promise<CrawlResult> {
    const startedAt = Date.now();
    const maxPages = Math.max(1, options.maxPages ?? this.config.maxPagesPerCall);
    const maxDepth = Math.max(0, options.maxDepth ?? this.config.maxDepth);
    const concurrency = Math.max(1, options.concurrency ?? this.config.concurrency);
    const perHost = Math.max(1, options.perHost ?? this.config.perHost);
    const delayMs = options.delayMs ?? this.config.delayMs;
    const respectRobots = options.respectRobots ?? this.config.respectRobots;
    const deadline = options.timeBudgetMs ? startedAt + options.timeBudgetMs : Infinity;

    const seeds = [...new Set(options.seeds.map((seed) => canonicalURL(seed)).filter(Boolean))];
    if (seeds.length === 0) {
      return { pages: [], errors: [], skipped: 0, stopped: "exhausted", startedAt, durationMs: 0 };
    }

    // One abort controller for timeouts + caller cancellation.
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const crawlState: { stopReason: CrawlResult["stopped"] } = { stopReason: "exhausted" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (deadline !== Infinity) {
      timer = setTimeout(() => {
        crawlState.stopReason = "time";
        controller.abort();
      }, Math.max(0, deadline - Date.now()));
    }

    const queue: QueueItem[] = [];
    const seen = new Set<string>();
    const pages: FetchedPage[] = [];
    const errors: CrawlError[] = [];
    let skipped = 0;
    let started = 0;
    let active = 0;
    let sitemapsReady = !(options.includeSitemaps ?? this.config.useSitemaps);

    const counts = () => ({ queued: queue.length, active, fetched: pages.length, failed: errors.length });

    const enqueue = (rawUrl: string, depth: number, seed: string, emit = true): void => {
      const url = canonicalURL(rawUrl);
      if (!url || seen.has(url)) return;
      if (depth > maxDepth) return;
      if (isAssetURL(url)) {
        skipped++;
        return;
      }
      if (!options.allowPrivateHosts && depth > 0 && isPrivateHost(hostOf(url))) {
        skipped++;
        return;
      }
      if (!passesPatterns(url, options)) {
        skipped++;
        return;
      }
      seen.add(url);
      queue.push({ url, depth, seed });
      if (emit && options.onProgress) {
        options.onProgress({ kind: "discovered", url, ...counts() });
      }
    };

    for (const seed of seeds) enqueue(seed, 0, seed, false);

    const hostState = (host: string): HostState => {
      let state = this.hostStates.get(host);
      if (!state) {
        state = { sem: new Semaphore(perHost), lastRequest: 0, delayMs };
        this.hostStates.set(host, state);
      }
      return state;
    };

    const robots = new Map<string, { policy: RobotsPolicy; denied: boolean }>();
    const getRobots = async (url: string) => {
      if (!respectRobots) return null;
      const origin = originOf(url);
      const cached = robots.get(origin);
      if (cached) return cached;
      const loaded = await loadRobots(url, this.config.userAgent, { signal: controller.signal });
      robots.set(origin, loaded);
      return loaded;
    };

    const process = async (item: QueueItem): Promise<void> => {
      if (controller.signal.aborted) return;
      const host = hostOf(item.url);
      const state = hostState(host);
      let release: (() => void) | null = null;
      try {
        const policyResult = await getRobots(item.url);
        if (policyResult) {
          const path = robotsPath(item.url);
          if (policyResult.denied || !isAllowed(path, policyResult.policy)) {
            skipped++;
            options.onProgress?.({ kind: "skipped", url: item.url, ...counts(), message: "blocked by robots.txt" });
            return;
          }
          if (policyResult.policy.crawlDelayMs) {
            state.delayMs = Math.max(state.delayMs, policyResult.policy.crawlDelayMs);
          }
        }

        release = await state.sem.acquire(controller.signal);
        const wait = state.lastRequest + state.delayMs - Date.now();
        if (wait > 0) await sleep(wait, controller.signal);
        state.lastRequest = Date.now();

        options.onProgress?.({ kind: "fetching", url: item.url, ...counts() });
        const page = await this.fetcher.fetch(item.url, {
          signal: controller.signal,
          maxChars: options.maxCharsPerPage,
        });

        if (page.error) {
          errors.push({ url: item.url, error: page.error, status: page.status });
          options.onProgress?.({ kind: "failed", url: item.url, ...counts(), message: page.error });
          return;
        }

        pages.push(page);
        options.onProgress?.({ kind: "fetched", url: item.url, ...counts() });

        if (item.depth < maxDepth) {
          for (const link of page.links) {
            if (queue.length > 10_000) break;
            if (options.sameDomain && !sameSite(link, item.seed)) continue;
            enqueue(link, item.depth + 1, item.seed);
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        errors.push({ url: item.url, error: (err as Error).message });
        options.onProgress?.({ kind: "failed", url: item.url, ...counts(), message: (err as Error).message });
      } finally {
        release?.();
      }
    };

    // Sitemap discovery runs alongside the first pages instead of blocking the
    // whole crawl; it feeds the frontier and is bounded by the page budget.
    const sitemapPromise = options.includeSitemaps ?? this.config.useSitemaps
      ? this.discoverSitemaps(seeds, options, controller.signal, maxPages)
          .then((urls) => {
            for (const url of urls) enqueue(url, 0, seeds[0]!, true);
          })
          .catch(() => undefined)
          .finally(() => {
            sitemapsReady = true;
          })
      : Promise.resolve();

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const pump = () => {
        if (settled) return;
        if (controller.signal.aborted) {
          if (active === 0) finish();
          return;
        }
        if (Date.now() >= deadline) {
          crawlState.stopReason = "time";
          controller.abort();
          if (active === 0) finish();
          return;
        }
        while (active < concurrency && queue.length > 0 && started < maxPages) {
          const item = queue.shift()!;
          active++;
          started++;
          void process(item).then(() => {
            active--;
            pump();
          });
        }
        if (active === 0 && queue.length === 0 && sitemapsReady) {
          finish();
        }
        if (started >= maxPages && active === 0 && queue.length > 0) {
          crawlState.stopReason = "max-pages";
          finish();
        }
      };
      void sitemapPromise.then(() => pump());
      pump();
    });

    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);

    if (options.signal?.aborted) crawlState.stopReason = "aborted";
    else if (crawlState.stopReason !== "time" && started >= maxPages && queue.length > 0) crawlState.stopReason = "max-pages";
    else if (crawlState.stopReason !== "time") crawlState.stopReason = "exhausted";

    return {
      pages,
      errors,
      skipped,
      stopped: crawlState.stopReason,
      startedAt,
      durationMs: Date.now() - startedAt,
    };
  }

  private async discoverSitemaps(
    seeds: string[],
    options: CrawlOptions,
    signal: AbortSignal,
    maxPages: number,
  ): Promise<string[]> {
    if (maxPages < 3) return [];
    const origins = [...new Set(seeds.map(originOf).filter(Boolean))].slice(0, 4);
    const output: string[] = [];
    const added = new Set<string>();

    const addUrl = (url: string) => {
      if (output.length >= Math.min(maxPages, 500)) return;
      const canonical = canonicalURL(url);
      if (!canonical || added.has(canonical) || isAssetURL(canonical)) return;
      if (!passesPatterns(canonical, options)) return;
      const seed = seeds.find((candidate) => sameSite(canonical, candidate));
      if (!seed) return;
      added.add(canonical);
      output.push(canonical);
    };

    for (const origin of origins) {
      const candidates = new Set<string>();
      if (this.config.useSitemaps) {
        try {
          const loaded = await loadRobots(origin, this.config.userAgent, { signal });
          for (const sitemap of loaded.policy.sitemaps) candidates.add(sitemap);
        } catch {
          // ignore
        }
        candidates.add(`${origin}/sitemap.xml`);
      }
      for (const sitemap of [...candidates].slice(0, 5)) {
        try {
          const xml = await this.fetchText(sitemap, signal);
          if (!xml) continue;
          const isIndex = /<sitemapindex[\s>]/i.test(xml);
          const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => decodeEntities(match[1]!.trim()));
          if (isIndex) {
            for (const child of locs.slice(0, 4)) {
              const childXML = await this.fetchText(child, signal);
              if (!childXML) continue;
              for (const loc of childXML.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
                addUrl(decodeEntities(loc[1]!.trim()));
              }
            }
          } else {
            for (const loc of locs) addUrl(loc);
          }
        } catch {
          // sitemaps are a bonus, never fatal
        }
      }
    }
    return output;
  }

  private async fetchText(url: string, signal: AbortSignal): Promise<string | null> {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": this.config.userAgent, accept: "application/xml,text/xml,*/*;q=0.5" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: "follow",
      });
      if (!response.ok || !response.body) return null;
      const stream = url.endsWith(".gz") ? response.body.pipeThrough(new DecompressionStream("gzip")) : response.body;
      const text = await new Response(stream).text();
      return text.slice(0, 5_000_000);
    } catch {
      return null;
    }
  }
}

function passesPatterns(url: string, options: CrawlOptions): boolean {
  if (options.denyPatterns?.some((pattern) => matchesPattern(url, pattern))) return false;
  if (options.allowPatterns && options.allowPatterns.length > 0) {
    return options.allowPatterns.some((pattern) => matchesPattern(url, pattern));
  }
  return true;
}

function isPrivateHost(host: string): boolean {
  if (!host) return false;
  const clean = host.toLowerCase();
  if (clean === "localhost" || clean.endsWith(".localhost") || clean.endsWith(".local") || clean.endsWith(".internal")) return true;
  if (clean === "::1" || clean.startsWith("fc") || clean.startsWith("fd")) return true;
  const ipv4 = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}
