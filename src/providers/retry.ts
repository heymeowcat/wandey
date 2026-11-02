import type { ProviderEvent, Usage } from "../core/types.ts";
import { sleep } from "../core/util.ts";

/**
 * Shared retry and fallback policy for provider streams.
 *
 * A provider failure is only retried before the first content event. Once text,
 * reasoning, or a tool call has been emitted, retrying would duplicate output,
 * so the failure is surfaced as `MidStreamError` and the durable run becomes
 * resumable instead.
 */

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 8_000;

export class MidStreamError extends Error {
  constructor(
    message: string,
    readonly ref: string,
    readonly attempt: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MidStreamError";
  }
}

export function isRetryableProviderError(error: unknown): boolean {
  if (!error) return false;
  if (isAbortError(error)) return false;

  const status = errorStatus(error);
  if (status !== null) return RETRYABLE_STATUS.has(status);

  const message = errorMessage(error).toLowerCase();
  // Resolution and configuration mistakes are not transient.
  if (
    /unknown provider|model ref is empty|no model is available|not configured|invalid model/.test(
      message,
    )
  ) {
    return false;
  }

  // Fetch and stream failures usually arrive without an HTTP status.
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR)/i.test(code)) {
    return true;
  }
  if ((error as Error).name === "TypeError") return true;
  if ((error as { cause?: unknown }).cause) return true;
  return /network|fetch failed|socket|timed out|timeout|connection|stream|terminated|premature|closed|econn|etimedout|enotfound|eai_again|und_err|rate limit|too many requests|overloaded|temporarily unavailable|server error/.test(
    message,
  );
}

export interface AttemptInfo {
  ref: string;
  /** Global attempt number for this model step, across retries and fallbacks. */
  attempt: number;
  toolsEnabled: boolean;
}

export interface AttemptEndInfo {
  ref: string;
  attempt: number;
  /** Cumulative provider usage for this attempt, or null when none arrived. */
  usage: Usage | null;
  /** Characters emitted by text, reasoning, and tool-call events. */
  outputChars: number;
  error?: unknown;
}

export interface StreamWithFallbackOptions {
  /** Primary first, then ordered fallbacks. Duplicates and blanks are ignored. */
  candidates: string[];
  /** Attempts per candidate, including the first. */
  attempts: number;
  baseDelayMs: number;
  /** First global attempt number, so resumed runs keep attempt ids unique. */
  startAttempt?: number;
  signal?: AbortSignal;
  supportsTools: (ref: string) => Promise<boolean>;
  open: (ref: string, toolsEnabled: boolean) => AsyncIterable<ProviderEvent>;
  onAttempt?: (info: AttemptInfo) => void;
  onFirstContent?: (info: { ref: string; attempt: number }) => void;
  onAttemptEnd?: (info: AttemptEndInfo) => void;
}

export type TaggedProviderEvent = ProviderEvent & { model: string; attempt: number };

export async function* streamWithFallback(
  options: StreamWithFallbackOptions,
): AsyncGenerator<TaggedProviderEvent> {
  const candidates = [...new Set(options.candidates.map((ref) => ref.trim()).filter(Boolean))];
  const attempts = Math.max(1, Math.floor(options.attempts) || 1);
  let globalAttempt = Math.max(0, Math.floor(options.startAttempt ?? 0));
  let lastError: unknown = null;

  for (const ref of candidates) {
    for (let localAttempt = 1; localAttempt <= attempts; localAttempt++) {
      if (options.signal?.aborted) throw abortError();
      globalAttempt += 1;

      const toolsEnabled = await supportsToolsSafely(options.supportsTools, ref);
      options.onAttempt?.({ ref, attempt: globalAttempt, toolsEnabled });

      let firstContent = false;
      let outputChars = 0;
      let usage: Usage | null = null;
      let finishError: string | null = null;
      let failure: unknown = null;

      try {
        for await (const event of options.open(ref, toolsEnabled)) {
          if (event.type === "usage") {
            usage = mergeUsage(usage ?? {}, event.usage);
          } else if (event.type === "text" || event.type === "reasoning") {
            outputChars += event.delta.length;
          } else if (event.type === "tool_call") {
            outputChars += event.name.length + JSON.stringify(event.args).length;
          } else if (event.type === "finish" && event.error) {
            finishError = event.error;
          }

          if (!firstContent && isContentEvent(event)) {
            firstContent = true;
            options.onFirstContent?.({ ref, attempt: globalAttempt });
          }
          yield { ...event, model: ref, attempt: globalAttempt };
        }
        // Some adapters report failures as a finish event instead of throwing.
        if (finishError) throw new Error(finishError);
      } catch (err) {
        failure = err;
      } finally {
        options.onAttemptEnd?.({
          ref,
          attempt: globalAttempt,
          usage: usage && hasUsage(usage) ? usage : null,
          outputChars,
          error: failure ?? undefined,
        });
      }

      if (!failure) return;

      lastError = failure;
      if (options.signal?.aborted || isAbortError(failure)) throw failure;
      if (firstContent) {
        throw new MidStreamError(
          errorMessage(failure),
          ref,
          globalAttempt,
          failure,
        );
      }
      if (isRetryableProviderError(failure) && localAttempt < attempts) {
        await sleep(backoffDelay(localAttempt, options.baseDelayMs), options.signal);
        continue;
      }
      // Exhausted this candidate; move to the next fallback.
      break;
    }
  }

  throw lastError ?? new Error("No model candidates are available.");
}

function isContentEvent(event: ProviderEvent): boolean {
  return event.type === "text" || event.type === "reasoning" || event.type === "tool_call";
}

function errorStatus(error: unknown): number | null {
  const direct = [
    (error as { status?: unknown }).status,
    (error as { options?: { status?: unknown } }).options?.status,
    (error as { response?: { status?: unknown } }).response?.status,
    (error as { cause?: { status?: unknown } }).cause?.status,
  ];
  for (const value of direct) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }

  const message = errorMessage(error);
  const match =
    message.match(/\bHTTP\s+(\d{3})\b/i) ??
    message.match(/\bstatus\s*[:=]?\s*(\d{3})\b/i) ??
    message.match(/request failed \((\d{3})\)/i);
  return match ? Number(match[1]) : null;
}

function isAbortError(error: unknown): boolean {
  return (error as Error)?.name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function errorMessage(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

async function supportsToolsSafely(
  supportsTools: (ref: string) => Promise<boolean>,
  ref: string,
): Promise<boolean> {
  try {
    return await supportsTools(ref);
  } catch {
    return false;
  }
}

function mergeUsage(target: Usage, source: Usage): Usage {
  for (const key of Object.keys(source) as Array<keyof Usage>) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
  if (target.total === undefined && target.input !== undefined && target.output !== undefined) {
    target.total = target.input + target.output;
  }
  return target;
}

function hasUsage(usage: Usage): boolean {
  return Object.values(usage).some((value) => value !== undefined);
}

function backoffDelay(attempt: number, baseDelayMs: number): number {
  if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) return 0;
  const base = Math.min(MAX_BACKOFF_MS, baseDelayMs * 2 ** (attempt - 1));
  const jitter = base * 0.25;
  return Math.round(base - jitter + Math.random() * jitter * 2);
}
