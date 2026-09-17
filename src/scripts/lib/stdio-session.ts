/**
 * Reusable stdio session against a built MCP server.
 *
 * Speaks the raw JSON-RPC wire protocol rather than using the client SDK, on
 * purpose. Three scripts depend on this module - the smoke test, the tool
 * contract audit, and the tool-selection evaluation - and all three need to
 * observe what a *real host* sees. Using our own client SDK would let a shared
 * bug hide in both sides, and would make a failure ambiguous: is the server
 * wrong, or are our client calls wrong?
 *
 * It also collects `anomalies`: anything the server writes to stdout that is
 * not a JSON-RPC frame. That is the single most common stdio defect - one
 * stray `console.log` corrupts the channel - so it is captured centrally
 * instead of being re-implemented per script.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type JsonSchema = Record<string, unknown>;

export interface ToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
}

export interface ToolCallResult {
  isError: boolean;
  /** Flattened text of every `text` content block. */
  text: string;
  /** Present when the tool declared an `outputSchema` and returned data. */
  structuredContent?: Record<string, unknown>;
  /** True when the call failed at the JSON-RPC level rather than as a tool error. */
  protocolError?: { code: number; message: string };
}

export interface SessionSnapshot {
  serverInfo: Record<string, unknown>;
  /** Version the server actually settled on, which may be lower than requested. */
  protocolVersion: string;
  instructions: string | undefined;
  tools: ToolDescriptor[];
}

export interface StdioSession {
  readonly snapshot: SessionSnapshot;
  /** Non-JSON lines seen on stdout. Any entry here is a defect. */
  readonly anomalies: readonly string[];
  /** Raw stderr captured from the child, for diagnostics on failure. */
  readonly stderr: () => string;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  /** `timeoutMsOverride` lets the handshake use a wider ceiling than a normal call. */
  request(method: string, params?: Record<string, unknown>, timeoutMsOverride?: number): Promise<unknown>;
  close(): Promise<void>;
}

export interface StdioSessionOptions {
  /** Absolute path to the built server entry (dist/index.js). */
  entry: string;
  env?: NodeJS.ProcessEnv;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Ceiling for the whole handshake. */
  handshakeTimeoutMs?: number;
  /** Echo child stderr into our own stderr - useful while debugging. */
  forwardStderr?: boolean;
  /** Trace every frame in both directions. */
  debug?: boolean;
  /**
   * Protocol version to request. Defaults to a version above what the published
   * SDK implements, so the negotiation path is exercised by default rather than
   * only when someone happens to test it.
   */
  requestProtocolVersion?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

const DEFAULTS = {
  timeoutMs: 10_000,
  handshakeTimeoutMs: 15_000,
  requestProtocolVersion: '2026-07-28',
} as const;

function toText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } => {
      if (typeof block !== 'object' || block === null) return false;
      const record = block as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string';
    })
    .map((block) => block.text)
    .join('\n');
}

export async function openStdioSession(options: StdioSessionOptions): Promise<StdioSession> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs;
  const debug = options.debug ?? false;

  const child: ChildProcess = spawn(process.execPath, [options.entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MCP_TRANSPORT: 'stdio', ...(options.env ?? {}) },
  });

  let stdoutBuffer = '';
  let stderrBuffer = '';
  let nextId = 1;
  let closed = false;

  const pending = new Map<number, PendingRequest>();
  const anomalies: string[] = [];

  const trace = (direction: string, detail: string): void => {
    if (debug) process.stderr.write(`[session ${direction}] ${detail}\n`);
  };

  /** Reject every in-flight request; called once on teardown so nothing hangs. */
  const failPending = (reason: Error): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error(`${entry.method} aborted: ${reason.message}`));
    }
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf('\n');

      if (line === '') continue;
      trace('recv', line.slice(0, 400));

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        anomalies.push(`non-JSON on stdout, which corrupts the stdio channel: ${line.slice(0, 200)}`);
        continue;
      }

      const id = message.id;
      if (typeof id !== 'number') continue;
      const entry = pending.get(id);
      if (!entry) continue;
      pending.delete(id);
      clearTimeout(entry.timer);

      if (message.error) {
        const error = message.error as { code: number; message: string };
        entry.resolve({ __protocolError: error });
      } else {
        entry.resolve(message.result);
      }
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrBuffer += chunk;
    if (options.forwardStderr) process.stderr.write(chunk);
  });

  child.on('exit', (code, signal) => {
    if (closed) return;
    failPending(new Error(`server exited unexpectedly (code=${code}, signal=${signal})`));
  });

  const exited = new Promise<never>((_resolve, reject) => {
    child.once('error', (error) => reject(error));
    child.once('exit', (code, signal) => {
      if (!closed) reject(new Error(`server exited early (code=${code}, signal=${signal})`));
    });
  });

  const sendRaw = (message: Record<string, unknown>): void => {
    trace('send', JSON.stringify(message).slice(0, 400));
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };

  const request = (
    method: string,
    params: Record<string, unknown> = {},
    timeoutMsOverride?: number,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const effectiveTimeoutMs = timeoutMsOverride ?? timeoutMs;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `no response to ${method} within ${effectiveTimeoutMs}ms | stdout tail: ${stdoutBuffer.trim().slice(0, 300) || '(empty)'} | ` +
              `stderr tail: ${stderrBuffer.trim().slice(-800) || '(empty)'}`,
          ),
        );
      }, effectiveTimeoutMs);

      pending.set(id, { resolve, reject, timer, method });
      sendRaw({ jsonrpc: '2.0', id, method, params });
    });

  const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
    const result = await request('tools/call', { name, arguments: args });

    // A protocol-level failure (as opposed to a tool error) comes back as the
    // synthetic marker installed by the frame reader above.
    const maybeError = (result as { __protocolError?: { code: number; message: string } } | null)?.__protocolError;
    if (maybeError) {
      return { isError: true, text: maybeError.message, protocolError: maybeError };
    }

    const payload = (result ?? {}) as Record<string, unknown>;
    return {
      isError: payload.isError === true,
      text: toText(payload.content),
      ...(payload.structuredContent && typeof payload.structuredContent === 'object'
        ? { structuredContent: payload.structuredContent as Record<string, unknown> }
        : {}),
    };
  };

  // --- handshake -----------------------------------------------------------
  // The handshake gets its own, wider ceiling. Spawning a Node process can be
  // slow - virus scanners on Windows routinely add seconds - and that delay
  // says nothing about whether the server is healthy. Without this, a slow
  // spawn is reported as "the server never answered", which sends you looking
  // in the wrong place.
  const initResult = (await Promise.race([
    request(
      'initialize',
      {
        protocolVersion: options.requestProtocolVersion ?? DEFAULTS.requestProtocolVersion,
        capabilities: {},
        clientInfo: { name: 'mcp-qq-account-session', version: '0.1.0' },
      },
      handshakeTimeoutMs,
    ),
    exited,
  ])) as Record<string, unknown>;

  const initError = (initResult as { __protocolError?: { code: number; message: string } }).__protocolError;
  if (initError) throw new Error(`initialize failed: ${JSON.stringify(initError)}`);

  sendRaw({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const listResult = (await request('tools/list')) as { tools?: ToolDescriptor[] };
  const tools = listResult?.tools ?? [];

  const snapshot: SessionSnapshot = {
    serverInfo: (initResult.serverInfo ?? {}) as Record<string, unknown>,
    protocolVersion: String(initResult.protocolVersion ?? ''),
    instructions: typeof initResult.instructions === 'string' ? initResult.instructions : undefined,
    tools,
  };

  return {
    snapshot,
    anomalies,
    stderr: () => stderrBuffer,
    callTool,
    request,
    close: async () => {
      closed = true;
      failPending(new Error('session closed'));
      child.stdin?.end();
      child.kill();
      // Give the process a moment to reap; do not hang teardown on it.
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}

/**
 * Path to the built server entry, resolved relative to a script running from
 * `dist/scripts/`.
 *
 * Uses `fileURLToPath` rather than reading `URL.pathname`: the latter leaves
 * percent-escapes in place, so any workspace path containing a space (very
 * common on Windows and macOS) resolves to a path that does not exist.
 */
export function resolveServerEntry(fromUrl: string): string {
  return join(dirname(fileURLToPath(fromUrl)), '..', 'index.js');
}
