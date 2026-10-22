/**
 * Streaming helpers shared by every provider adapter.
 *
 * All of the model APIs wandey speaks to stream either Server-Sent Events or
 * newline-delimited JSON. Both are small enough to parse by hand, which keeps
 * the provider layer dependency-free and identical across runtimes.
 */

export interface SSEMessage {
  event?: string;
  id?: string;
  data: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly options: { provider?: string; status?: number; body?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function joinURL(base: string, path: string): string {
  const cleanBase = base.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (cleanBase.endsWith("/v1") && cleanPath.startsWith("/v1/")) {
    return `${cleanBase}${cleanPath.slice(3)}`;
  }
  return `${cleanBase}${cleanPath}`;
}

/**
 * Parse an SSE byte stream into messages. Handles CRLF and multi-line data.
 *
 * `idleTimeoutMs` guards against streams that connect and then go silent. The
 * read is cancelled rather than left dangling, so an abandoned model request
 * cannot keep a session "running" forever.
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  label = "stream",
  options: { idleTimeoutMs?: number } = {},
): AsyncGenerator<SSEMessage, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    if (!options.idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => {});
    }, options.idleTimeoutMs);
  };

  try {
    arm();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const message = parseBlock(block);
        if (message) yield message;
      }
    }
    if (timedOut) {
      throw new ProviderError(`${label} stalled for ${Math.round((options.idleTimeoutMs ?? 0) / 1000)}s with no data`);
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const message = parseBlock(buffer);
      if (message) yield message;
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if ((err as Error)?.name === "AbortError") return;
    throw new ProviderError(`${label} failed while reading: ${(err as Error).message}`, { cause: err });
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}

function parseBlock(block: string): SSEMessage | null {
  const lines = block.split(/\r?\n/);
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let hasField = false;

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") {
      data.push(value);
      hasField = true;
    } else if (field === "event") {
      event = value;
      hasField = true;
    } else if (field === "id") {
      id = value;
      hasField = true;
    }
  }

  if (!hasField) return null;
  return { data: data.join("\n"), event, id };
}

/** Fetch a streaming endpoint and turn HTTP failures into useful errors. */
export async function openStream(
  url: string,
  init: RequestInit,
  options: { provider: string; label?: string; signal?: AbortSignal },
): Promise<{ response: Response; body: ReadableStream<Uint8Array> }> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: options.signal,
      headers: {
        accept: "text/event-stream",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ProviderError(
      `${options.provider}: could not reach ${safeURL(url)} — ${(err as Error).message}`,
      { provider: options.provider, cause: err },
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ProviderError(
      `${options.provider}: HTTP ${response.status} ${response.statusText}${body ? ` — ${truncateBody(body)}` : ""}`,
      { provider: options.provider, status: response.status, body },
    );
  }

  if (!response.body) {
    throw new ProviderError(`${options.provider}: response had no body`, { provider: options.provider });
  }

  return { response, body: response.body };
}

/** Fetch JSON with a timeout and consistent errors. */
export async function fetchJSON<T>(
  url: string,
  init: RequestInit,
  options: { provider: string; timeoutMs?: number; label?: string },
): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (err) {
    throw new ProviderError(
      `${options.provider}: could not reach ${safeURL(url)} — ${(err as Error).message}`,
      { provider: options.provider, cause: err },
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ProviderError(
      `${options.provider}: HTTP ${response.status} ${response.statusText}${body ? ` — ${truncateBody(body)}` : ""}`,
      { provider: options.provider, status: response.status, body },
    );
  }
  return (await response.json()) as T;
}

export function safeURL(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "endpoint";
  }
}

export function truncateBody(body: string, max = 400): string {
  const clean = body.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
