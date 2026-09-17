/**
 * Shared plumbing every tool goes through.
 *
 * Three jobs:
 *   1. Build results the model can read AND a host can parse (`content` +
 *      `structuredContent`).
 *   2. Funnel every throw into one `isError` result so no provider needs its
 *      own try/catch and no stack trace ever reaches the model.
 *   3. Read the per-request context (cancellation signal, authenticated
 *      caller) without hard-binding to one transport, because the same tool
 *      set has to run over stdio where `ctx.http` is undefined.
 */

import { asToolFailure, describeFailure, type ToolFailurePayload } from './errors.js';
import { serialiseError, type Logger } from './logger.js';

/** The verified caller, when the server runs over HTTP with auth enabled. */
export interface AuthenticatedCaller {
  readonly clientId?: string;
  readonly scopes?: readonly string[];
}

export interface ToolRequestContext {
  /** Present when the host supports cancellation; forward it to upstream calls. */
  readonly signal: AbortSignal | undefined;
  readonly caller: AuthenticatedCaller | undefined;
}

/**
 * Read the SDK's context object defensively.
 *
 * The context surface still moves between SDK minors, so we probe rather than
 * assert: a missing field degrades to "no caller info", it never crashes a
 * tool call.
 */
export function readRequestContext(ctx: unknown): ToolRequestContext {
  const record = (ctx ?? {}) as Record<string, unknown>;
  const http = (record.http ?? {}) as Record<string, unknown>;
  const authInfo = http.authInfo as Record<string, unknown> | undefined;

  const signal = record.signal instanceof AbortSignal ? record.signal : undefined;

  const caller: AuthenticatedCaller | undefined = authInfo
    ? {
        ...(typeof authInfo.clientId === 'string' ? { clientId: authInfo.clientId } : {}),
        ...(Array.isArray(authInfo.scopes) ? { scopes: authInfo.scopes.filter((s): s is string => typeof s === 'string') } : {}),
      }
    : undefined;

  return { signal, caller };
}

/**
 * Success result carrying both renderings.
 *
 * `content` is what the model reads; `structuredContent` is what the host can
 * validate against the tool's `outputSchema`. When the payload is large the
 * text rendering is the expensive part, so callers may pass a summary.
 *
 * Declared as a type alias, not an interface: the SDK's result type carries an
 * index signature (`[x: string]: unknown`), and only object *literal types* get
 * an implicit one. Switching this to an interface makes every handler fail to
 * typecheck.
 */
export type ToolSuccess<TStructured extends Record<string, unknown>> = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: TStructured;
};

/**
 * Build a success result. Pass `text` whenever a hand-written summary reads
 * better than raw JSON - which, for anything a human will look at, is usually.
 */
export function toolResult<TStructured extends Record<string, unknown>>(
  structured: TStructured,
  text?: string,
): ToolSuccess<TStructured> {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/**
 * Run a tool body with one central error funnel.
 *
 * Everything thrown below this line becomes an `isError` result whose text is
 * written for the model (see `describeFailure`), while the full error including
 * the stack goes to stderr for the operator. The model never sees a stack
 * trace; the operator never loses one.
 */
export async function runGuarded<T>(
  toolName: string,
  logger: Logger,
  fn: () => Promise<T>,
): Promise<T | ToolFailurePayload> {
  try {
    return await fn();
  } catch (error) {
    logger.error('tool failed', { tool: toolName, ...serialiseError(error) });
    return asToolFailure(describeFailure(toolName, error));
  }
}

/**
 * Trim a free-text field before it enters the model's context.
 *
 * A single issue body can be tens of kilobytes. Passing it through verbatim
 * burns the caller's context window on one tool call, so every unbounded
 * upstream text field is truncated at the boundary with a visible marker.
 */
export function clipText(value: string | null | undefined, maxChars: number): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n[...truncated ${trimmed.length - maxChars} of ${trimmed.length} characters]`;
}
