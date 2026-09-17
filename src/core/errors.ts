/**
 * Error taxonomy and the "model-facing message" contract.
 *
 * MCP gives a tool handler exactly two failure channels:
 *
 *   tool error      -> a successful result with `isError: true`. The MODEL sees
 *                      the text and can change its arguments and retry.
 *   protocol error  -> a JSON-RPC error response. The MODEL never sees it; the
 *                      host application handles it.
 *
 * Because the model is the primary reader of a tool error, the message is a
 * prompt, not a stack trace. Every message produced here answers three things:
 *   1. which tool failed,
 *   2. what the upstream actually said (without leaking the credential),
 *   3. what the model should do differently.
 */

export type ToolFailurePayload = {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
};

/** Raised when the upstream SaaS API answers with a non-2xx status. */
export class UpstreamError extends Error {
  readonly status: number | undefined;
  readonly service: string;
  readonly retryable: boolean;
  readonly hint: string | undefined;
  /**
   * Whether the upstream's side of the action is genuinely unknown.
   *
   * `false` means we know: either the upstream answered and declined, or the
   * request never got there. `true` means we do not know - a timeout or a
   * broken connection cannot distinguish "never processed" from "processed,
   * response lost".
   *
   * Only writes care, and for them it is the difference between a safe resend
   * and a duplicate. A read can be repeated whatever this says.
   */
  readonly outcomeUncertain: boolean;

  constructor(options: {
    service: string;
    message: string;
    status?: number | undefined;
    retryable?: boolean;
    hint?: string | undefined;
    outcomeUncertain?: boolean;
    cause?: unknown;
  }) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'UpstreamError';
    this.service = options.service;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.hint = options.hint;
    this.outcomeUncertain = options.outcomeUncertain ?? false;
  }
}

/** Raised when a write-capable tool is called without usable credentials. */
export class MissingCredentialError extends Error {
  constructor(
    readonly service: string,
    readonly envVar: string,
    readonly capability: string,
  ) {
    super(`${service} credentials are not configured, so ${capability} is unavailable.`);
    this.name = 'MissingCredentialError';
  }
}

/**
 * Raised when an operator has switched a capability off in configuration.
 *
 * Distinct from a missing credential and from an upstream failure, because the
 * recovery is different in each case: this one is fixed by a human changing a
 * setting, and no amount of retrying by the model will move it.
 */
export class CapabilityDisabledError extends Error {
  constructor(
    readonly capability: string,
    readonly envVar: string,
  ) {
    super(`${capability} is disabled by configuration (${envVar}).`);
    this.name = 'CapabilityDisabledError';
  }
}

/**
 * Give a fragment terminal punctuation before fragments are joined.
 *
 * The pieces come from different places - a transport error message, a
 * status-derived hint, a retry instruction - and not all of them end with
 * punctuation. Joining them with a space then produces
 *
 *   "...the request could not reach the GitHub API Check network egress..."
 *
 * which reads as one run-on sentence and buries the actionable half. The model
 * is the reader here, so making it parse the sentence for the instruction is a
 * real cost.
 */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return trimmed;
  return /[.!?。！?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Translate any thrown value into an actionable sentence for the model.
 *
 * Deliberately lossy on internals (no stack, no request headers, no URLs that
 * embed a token) and deliberately generous on recovery instructions.
 */
export function describeFailure(toolName: string, error: unknown): string {
  if (error instanceof MissingCredentialError) {
    return sentence(
      `${toolName} failed: ${error.message} ` +
        'Do not retry - this is a server-side deployment issue. Tell the user that the ' +
        `${error.service} integration needs an operator to set ${error.envVar}, then continue with read-only tools.`,
    );
  }

  if (error instanceof CapabilityDisabledError) {
    return sentence(
      `${toolName} failed: ${error.message} ` +
        'Do not retry - this is a deliberate operator setting, not a transient fault, so the same call will fail ' +
        `every time. Tell the user that ${error.capability} has been switched off through ${error.envVar}, and ` +
        'continue with the read-only tools, which are unaffected.',
    );
  }

  if (error instanceof UpstreamError) {
    const statusText = error.status === undefined ? 'no HTTP status' : `HTTP ${error.status}`;
    const parts = [`${toolName} failed: the ${error.service} API returned ${statusText}.`, error.message];
    if (error.hint) parts.push(error.hint);
    if (error.retryable) {
      parts.push('This looks transient - one retry is reasonable, then stop and report the failure.');
    } else {
      parts.push('Do not retry the identical call; adjust the arguments or report the problem.');
    }
    return parts.map(sentence).join(' ');
  }

  // Schema violations never reach here (the SDK validates before the handler
  // runs), so any remaining throw is a genuine bug on our side.
  const detail = error instanceof Error ? error.message : String(error);
  return sentence(
    `${toolName} failed unexpectedly: ${detail} ` +
      'This is an internal error, not a problem with your arguments. Do not retry the same call; ' +
      'report it to the user and use a different tool if one is available.',
  );
}

/** Wrap a sentence into the `isError` result shape the SDK expects. */
export function asToolFailure(text: string): ToolFailurePayload {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Map an HTTP status to a hint that tells the model what to change. */
export function hintForStatus(status: number, service: string): string | undefined {
  switch (status) {
    case 401:
      return `The ${service} credential is missing, expired, or revoked - an operator must refresh it.`;
    case 403:
      return `Either the ${service} credential lacks the required scope, or the rate limit is exhausted. Check the scope before retrying.`;
    case 404:
      return 'The resource does not exist, or the credential cannot see it. Verify the identifier before retrying.';
    case 409:
      return 'The request conflicts with the current state of the resource (it may already exist).';
    case 422:
      return 'The request was well-formed but semantically rejected - narrow or correct the arguments.';
    case 429:
      return `The ${service} rate limit was hit.`;
    default:
      if (status >= 500) return `The ${service} service is failing server-side; nothing about your arguments will fix it.`;
      return undefined;
  }
}
