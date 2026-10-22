/** Small shared helpers. No dependencies on purpose. */

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Prefixed, sortable-ish id: `ses_l4k2j1a8x0`. */
export function newID(prefix: string, length = 10): string {
  let out = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) {
    out += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  }
  return `${prefix}_${out}`;
}

export function now(): number {
  return Date.now();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function slugify(text: string, max = 60): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

export function hashString(text: string): string {
  // FNV-1a, good enough for dedupe keys.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** Parse a "provider/model" ref, splitting on the first slash only. */
export function parseModelRef(ref: string): { provider: string | null; model: string } {
  const index = ref.indexOf("/");
  if (index === -1) return { provider: null, model: ref };
  return { provider: ref.slice(0, index), model: ref.slice(index + 1) };
}

/**
 * Extract the first JSON object/array from model output. Models wrap JSON in
 * prose, code fences, or trailing commentary; this survives all of it.
 */
export function extractJson<T = unknown>(text: string): T | null {
  const trimmed = text.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], trimmed].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const direct = tryParse<T>(candidate);
    if (direct !== undefined) return direct;
  }

  // Fall back to brace/bracket matching from the first opener.
  for (const candidate of candidates) {
    const start = findFirst(candidate, ["{", "["]);
    if (start === -1) continue;
    const open = candidate[start]!;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const parsed = tryParse<T>(candidate.slice(start, i + 1));
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

function tryParse<T>(text: string): T | undefined {
  try {
    const value = JSON.parse(text.trim()) as T;
    if (value && typeof value === "object") return value;
    return undefined;
  } catch {
    return undefined;
  }
}

function findFirst(text: string, chars: string[]): number {
  let best = -1;
  for (const ch of chars) {
    const index = text.indexOf(ch);
    if (index !== -1 && (best === -1 || index < best)) best = index;
  }
  return best;
}

/** Run async tasks with a concurrency cap, preserving result order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** A counting semaphore used to cap concurrent fetches per host and globally. */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(public readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.queue.indexOf(grant);
        if (index !== -1) this.queue.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active++;
        resolve(() => this.release());
      };
      this.queue.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** Await a promise with a hard timeout. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Retry an async operation with exponential backoff. */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (options.signal?.aborted) throw err;
      if (attempt < attempts) await sleep((options.baseDelayMs ?? 250) * attempt, options.signal);
    }
  }
  throw lastError;
}

/** Strip a leading slash and trailing slashes for route matching. */
export function normalizePath(path: string): string {
  const clean = path.replace(/\/+$/g, "");
  return clean || "/";
}

export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
