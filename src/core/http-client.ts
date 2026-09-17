/**
 * Authenticated HTTP client for upstream SaaS APIs.
 *
 * Responsibilities kept out of every provider:
 *   - timeouts (a hanging upstream must not hang the MCP session)
 *   - bounded retries with exponential backoff + jitter, honouring Retry-After
 *   - cancellation propagation from the MCP request context
 *   - credential injection in exactly one place, so it can never be logged
 *   - converting transport/HTTP failures into `UpstreamError` with a hint
 *
 * Deliberately no caching layer here: cache policy is per-provider, and a
 * wrongly cached read is worse than a slow one.
 */

import { UpstreamError, hintForStatus } from './errors.js';
import type { Logger } from './logger.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  /** Path relative to the base URL, e.g. `/repos/owner/name`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Extra headers for this call only; never put credentials here. */
  headers?: Record<string, string>;
  /** Overrides the client timeout for slow endpoints (search, reports). */
  timeoutMs?: number;
  /**
   * Set to `false` for a call that changes state.
   *
   * Retrying a write is a guess about whether the first attempt took effect,
   * and a timeout cannot answer that: the upstream may have performed the
   * action and lost only the response. Reads can be repeated for free, so a
   * wrong guess costs a slow call; a write repeated wrongly is a duplicate the
   * caller cannot take back.
   */
  retry?: boolean;
  /** MCP request cancellation signal, forwarded downstream. */
  signal?: AbortSignal | undefined;
}

export interface HttpClientOptions {
  readonly service: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly logger: Logger;
  /**
   * Called per request. This is the ONLY place a credential is attached, so
   * the token never travels through tool arguments or logs.
   */
  readonly authorise: () => Record<string, string>;
  /** Sent as User-Agent / X-Client; identifies us to the upstream. */
  readonly userAgent?: string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function buildUrl(baseUrl: string, path: string, query: RequestOptions['query']): string {
  const url = new URL(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function backoffDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30_000);

    const httpDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(httpDate)) return Math.min(Math.max(httpDate - Date.now(), 0), 30_000);
  }
  const base = Math.min(250 * 2 ** attempt, 8_000);
  return base + Math.floor(Math.random() * 250);
}

export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}

  async request<T>(options: RequestOptions, parse: (raw: unknown) => T): Promise<T> {
    const method = options.method ?? 'GET';
    const url = buildUrl(this.options.baseUrl, options.path, options.query);
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    const attempts = options.retry === false ? 1 : this.options.maxRetries + 1;

    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const startedAt = Date.now();
      // Composing the caller's signal with a timeout keeps cancellation and
      // the deadline independent: whichever fires first aborts the fetch.
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

      try {
        const response = await fetch(url, {
          method,
          signal,
          headers: {
            Accept: 'application/json',
            'User-Agent': this.options.userAgent ?? 'mcp-saas-gateway',
            ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...this.options.authorise(),
            ...options.headers,
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });

        const durationMs = Date.now() - startedAt;
        const retryable = RETRYABLE_STATUS.has(response.status);
        const remaining = attempts - attempt - 1;

        if (response.ok) {
          this.options.logger.debug('upstream ok', { method, path: options.path, status: response.status, durationMs });
          if (response.status === 204) return parse(null);
          const text = await response.text();
          return parse(text.length === 0 ? null : JSON.parse(text));
        }

        const errorBody = await response.text().catch(() => '');
        const message = extractUpstreamMessage(errorBody) ?? truncate(errorBody, 400) ?? response.statusText ?? 'upstream request failed';
        const error = new UpstreamError({
          service: this.options.service,
          status: response.status,
          message,
          retryable: retryable && remaining > 0,
          hint: hintForStatus(response.status, this.options.service),
          // A server-side failure (5xx) or an overload signal (408/425/429) can
          // mean the request was accepted and the response lost. A plain 4xx
          // is the upstream telling us it did nothing.
          outcomeUncertain: retryable,
        });

        this.options.logger.warn('upstream error', {
          method,
          path: options.path,
          status: response.status,
          durationMs,
          attempt,
          willRetry: retryable && remaining > 0,
        });

        if (!retryable || remaining === 0) throw error;
        lastError = error;
        await sleep(backoffDelayMs(attempt, response.headers.get('retry-after')), options.signal);
      } catch (caught) {
        // A caller-initiated cancellation is not ours to retry or rebrand.
        if (options.signal?.aborted) throw caught;

        if (caught instanceof UpstreamError) {
          if (!caught.retryable) throw caught;
          lastError = caught;
          continue;
        }

        const isTimeout = caught instanceof Error && (caught.name === 'TimeoutError' || caught.name === 'AbortError');
        const remaining = attempts - attempt - 1;

        this.options.logger.warn('upstream transport failure', {
          method,
          path: options.path,
          attempt,
          willRetry: remaining > 0,
          reason: caught instanceof Error ? caught.name : 'unknown',
        });

        if (remaining === 0) {
          throw new UpstreamError({
            service: this.options.service,
            message: isTimeout
              ? `the request exceeded the ${timeoutMs} ms timeout`
              : `the request could not reach the ${this.options.service} API`,
            retryable: false,
            hint: 'Check network egress and the configured base URL before retrying.',
            // We never saw a response, so we cannot say whether the request was
            // processed. A read does not care; a write must not assume either
            // way, because guessing "it failed" produces a duplicate.
            outcomeUncertain: true,
            cause: caught,
          });
        }
        lastError = caught;
        await sleep(backoffDelayMs(attempt, null), options.signal);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new UpstreamError({ service: this.options.service, message: 'request failed with an unknown error' });
  }
}

/** Pull `message` / `error_description` out of a provider's error envelope. */
function extractUpstreamMessage(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const key of ['message', 'error_description', 'detail', 'error']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return truncate(value.trim(), 300);
      }
    }
  } catch {
    // Not JSON - fall through to the raw body.
  }
  return undefined;
}

function truncate(value: string, max: number): string | undefined {
  if (!value) return undefined;
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
