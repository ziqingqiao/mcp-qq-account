/**
 * Central configuration.
 *
 * Rules enforced here, copied deliberately from the sibling `mcp-saas-gateway`
 * so the two deployments behave the same way:
 *
 *  1. Fail fast at boot - a misconfigured server must not start.
 *  2. Credentials come from the process environment only, never from the model.
 *  3. Everything derived is immutable and passed down explicitly (no globals),
 *     so the same build runs as stdio or HTTP without re-reading env.
 *
 * One rule is unique to this server: the inbound event receiver must not be
 * exposed without a token. That endpoint is the only way messages enter the
 * agent's context, so anything that can reach it can write into a prompt.
 */

import { join, resolve } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type TransportKind = 'stdio' | 'http';

export interface AppConfig {
  readonly transport: TransportKind;
  readonly logLevel: LogLevel;
  readonly server: {
    readonly name: string;
    readonly version: string;
  };
  readonly onebot: {
    /** Base URL of the OneBot HTTP API, e.g. http://127.0.0.1:3000. */
    readonly baseUrl: string;
    /** Bearer value for the OneBot API. Never a tool parameter. */
    readonly accessToken: string | undefined;
    /**
     * Operator kill switch. When false every send tool refuses, while reads
     * keep working - so the account can be observed before it is allowed to
     * speak.
     */
    readonly sendEnabled: boolean;
  };
  readonly upstream: {
    readonly timeoutMs: number;
    readonly maxRetries: number;
  };
  /**
   * Where OneBot pushes events.
   *
   * MCP is request/response and cannot be pushed to, so inbound messages need
   * a side channel: OneBot POSTs them here, this server queues them on disk,
   * and `qq_read_messages` reads the queue back out.
   */
  readonly events: {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
    readonly path: string;
    readonly token: string | undefined;
    /**
     * Seconds between bind attempts when the port is already held.
     *
     * `0` means give up immediately, which is right for the copy the host
     * spawns: something else owning the port is the expected steady state, not
     * a fault. The standalone receiver sets this so that a copy started while
     * the host is running waits its turn instead of exiting - otherwise it
     * dies at boot and nothing is listening once the host closes, which is
     * exactly the window it exists to cover.
     */
    readonly bindRetrySeconds: number;
  };
  readonly inbox: {
    /** Resolved to an absolute path: see the note in loadConfig. */
    readonly dir: string;
    readonly maxBatch: number;
  };
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly path: string;
    readonly apiKeys: readonly string[];
    readonly allowedHosts: readonly string[];
  };
}

class ConfigError extends Error {
  constructor(message: string) {
    super(`Configuration error: ${message}`);
    this.name = 'ConfigError';
  }
}

function readString(env: NodeJS.ProcessEnv, key: string, fallback?: string): string {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') {
    if (fallback === undefined) throw new ConfigError(`${key} is required but was not set.`);
    return fallback;
  }
  return raw;
}

function readOptionalString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ConfigError(`${key} must be an integer, got "${raw}".`);
  if (value < min || value > max) throw new ConfigError(`${key} must be between ${min} and ${max}, got ${value}.`);
  return value;
}

function readBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new ConfigError(`${key} must be true or false, got "${raw}".`);
}

function readList(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key]?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function readTransport(env: NodeJS.ProcessEnv, argv: readonly string[]): TransportKind {
  // CLI wins over env so the same image can be run either way.
  const flag = argv.find((arg) => arg.startsWith('--transport='));
  const raw = (flag ? flag.slice('--transport='.length) : env.MCP_TRANSPORT)?.trim() || 'stdio';
  if (raw !== 'stdio' && raw !== 'http') {
    throw new ConfigError(`MCP_TRANSPORT must be "stdio" or "http", got "${raw}".`);
  }
  return raw;
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = (env.LOG_LEVEL?.trim() || 'info') as LogLevel;
  const allowed: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
  if (!allowed.includes(raw)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${allowed.join(', ')}, got "${raw}".`);
  }
  return raw;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): AppConfig {
  const transport = readTransport(env, argv);

  const httpHost = readString(env, 'HTTP_HOST', '127.0.0.1');
  const allowedHosts = readList(env, 'HTTP_ALLOWED_HOSTS');

  // Binding to all interfaces silently drops the SDK's DNS-rebinding guard,
  // so an explicit allow-list becomes mandatory at that point.
  if (transport === 'http' && !isLoopback(httpHost) && allowedHosts.length === 0) {
    throw new ConfigError(
      'HTTP_ALLOWED_HOSTS must list your public hostnames when HTTP_HOST is not a loopback address ' +
        '(DNS-rebinding protection depends on it).',
    );
  }

  const eventHost = readString(env, 'QQ_EVENT_HOST', '127.0.0.1');
  const eventToken = readOptionalString(env, 'QQ_EVENT_TOKEN');
  const eventsEnabled = readBool(env, 'QQ_EVENT_ENABLED', true);

  // The receiver is an injection surface: a POST to it becomes text the model
  // reads. Off-loopback and unauthenticated is not a warning, it is a refusal.
  if (eventsEnabled && !isLoopback(eventHost) && eventToken === undefined) {
    throw new ConfigError(
      `QQ_EVENT_TOKEN is required when QQ_EVENT_HOST is "${eventHost}" rather than a loopback address. ` +
        'The event endpoint writes text straight into the agent context, so an exposed one must be authenticated.',
    );
  }

  const baseUrl = readString(env, 'ONEBOT_BASE_URL', 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const parsedBase = safeUrl(baseUrl);
  if (parsedBase === undefined) {
    throw new ConfigError(`ONEBOT_BASE_URL is not a valid URL: "${baseUrl}".`);
  }

  return Object.freeze({
    transport,
    logLevel: readLogLevel(env),
    server: Object.freeze({
      name: readString(env, 'MCP_SERVER_NAME', 'qq-account'),
      version: readString(env, 'MCP_SERVER_VERSION', '0.1.0'),
    }),
    onebot: Object.freeze({
      baseUrl,
      accessToken: readOptionalString(env, 'ONEBOT_ACCESS_TOKEN'),
      sendEnabled: readBool(env, 'QQ_SEND_ENABLED', true),
    }),
    upstream: Object.freeze({
      timeoutMs: readInt(env, 'UPSTREAM_TIMEOUT_MS', 15_000, 1_000, 120_000),
      maxRetries: readInt(env, 'UPSTREAM_MAX_RETRIES', 1, 0, 5),
    }),
    events: Object.freeze({
      enabled: eventsEnabled,
      host: eventHost,
      port: readInt(env, 'QQ_EVENT_PORT', 8_790, 1, 65_535),
      path: normalizePath(readString(env, 'QQ_EVENT_PATH', '/onebot/events')),
      token: eventToken,
      bindRetrySeconds: readInt(env, 'QQ_EVENT_BIND_RETRY_SECONDS', 0, 0, 86_400),
    }),
    inbox: Object.freeze({
      // Absolute at boot, never the raw env value: the server's working
      // directory depends on which host spawned it, so a relative path would
      // silently mean different queues for the IDE host and the chat gateway -
      // and the two would appear not to share anything.
      dir: resolve(readOptionalString(env, 'QQ_INBOX_DIR') ?? join(process.cwd(), 'inbox-data')),
      maxBatch: readInt(env, 'QQ_INBOX_MAX_BATCH', 50, 1, 500),
    }),
    http: Object.freeze({
      host: httpHost,
      port: readInt(env, 'HTTP_PORT', 3_000, 1, 65_535),
      path: normalizePath(readString(env, 'HTTP_PATH', '/mcp')),
      apiKeys: readList(env, 'MCP_API_KEYS'),
      allowedHosts,
    }),
  });
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Express routes want a leading slash and no trailing one. */
function normalizePath(value: string): string {
  const withSlash = value.startsWith('/') ? value : `/${value}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}
