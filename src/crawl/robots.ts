import { originOf } from "../core/url.ts";

/**
 * A small, correct-enough robots.txt implementation.
 *
 * - picks the most specific user-agent group (falling back to "*")
 * - longest-match wins, with Allow winning ties
 * - supports * and $ wildcards (the parts real sites actually use)
 * - exposes Crawl-delay and Sitemap
 */

export interface RobotsRule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

export interface RobotsPolicy {
  rules: RobotsRule[];
  crawlDelayMs?: number;
  sitemaps: string[];
  fetchedAt: number;
  status: number;
}

export interface RobotsFetchResult {
  policy: RobotsPolicy;
  /** Set when robots.txt explicitly denied access (401/403). */
  denied: boolean;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, RobotsFetchResult>();

export function parseRobots(text: string, userAgent: string): RobotsPolicy {
  const groups: Array<{ agents: string[]; rules: RobotsRule[]; crawlDelay?: number }> = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: RobotsRule[]; crawlDelay?: number } | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    lastWasAgent = false;
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      if (!value) continue;
      current.rules.push({
        allow: field === "allow",
        pattern: value,
        regex: patternToRegExp(value),
      });
    } else if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) current.crawlDelay = seconds * 1000;
    }
  }

  const token = userAgent.toLowerCase().split("/")[0]!.trim();
  const specific = groups.filter((group) => group.agents.some((agent) => agent !== "*" && (token.startsWith(agent) || agent.startsWith(token))));
  const chosen = specific.length > 0 ? specific : groups.filter((group) => group.agents.includes("*"));
  const rules = chosen.flatMap((group) => group.rules);
  const crawlDelayMs = maxDefined(chosen.map((group) => group.crawlDelay));

  return { rules, crawlDelayMs, sitemaps, fetchedAt: Date.now(), status: 200 };
}

export function isAllowed(pathWithQuery: string, policy: RobotsPolicy): boolean {
  let best: { length: number; allow: boolean } | null = null;
  for (const rule of policy.rules) {
    if (!rule.regex.test(pathWithQuery)) continue;
    const length = rule.pattern.replace(/[*$]/g, "").length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
      best = { length, allow: rule.allow };
    }
  }
  return best?.allow ?? true;
}

/** Fetch and cache robots.txt for an origin. Fails open except for 401/403. */
export async function loadRobots(
  url: string,
  userAgent: string,
  options: { signal?: AbortSignal; timeoutMs?: number; refresh?: boolean } = {},
): Promise<RobotsFetchResult> {
  const origin = originOf(url);
  if (!origin) return { policy: emptyPolicy(0), denied: false };

  const cached = cache.get(origin);
  if (!options.refresh && cached && Date.now() - cached.policy.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 8000)])
    : AbortSignal.timeout(options.timeoutMs ?? 8000);

  try {
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": userAgent, accept: "text/plain,*/*;q=0.5" },
      signal,
      redirect: "follow",
    });
    if (response.status === 401 || response.status === 403) {
      const result = { policy: { ...emptyPolicy(response.status), rules: [{ allow: false, pattern: "/", regex: /^.*$/ }] }, denied: true };
      cache.set(origin, result);
      return result;
    }
    if (!response.ok) {
      const result = { policy: emptyPolicy(response.status), denied: false };
      cache.set(origin, result);
      return result;
    }
    const text = await response.text();
    const result = { policy: parseRobots(text.slice(0, 512_000), userAgent), denied: false };
    cache.set(origin, result);
    return result;
  } catch {
    // Network failure: fail open, but don't hammer robots.txt on every page.
    const policy = emptyPolicy(0);
    policy.fetchedAt = Date.now() - CACHE_TTL_MS + 5 * 60 * 1000;
    const result = { policy, denied: false };
    cache.set(origin, result);
    return result;
  }
}

export function robotsPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return "/";
  }
}

export function clearRobotsCache(): void {
  cache.clear();
}

function emptyPolicy(status: number): RobotsPolicy {
  return { rules: [], sitemaps: [], fetchedAt: Date.now(), status };
}

function patternToRegExp(pattern: string): RegExp {
  let source = pattern;
  let anchoredAtEnd = false;
  if (source.endsWith("$")) {
    anchoredAtEnd = true;
    source = source.slice(0, -1);
  }
  const escaped = source
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${anchoredAtEnd ? "$" : ""}`);
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.max(...defined) : undefined;
}
