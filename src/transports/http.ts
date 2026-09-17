/**
 * Streamable HTTP transport.
 *
 * Phase two of the deployment path: the same tool set, hosted centrally so
 * that many clients - and many users - share one deployment and one set of
 * credentials.
 *
 * Security posture, in order of how often people get it wrong:
 *
 *  1. The transport binds to loopback by default. Exposing it is an explicit
 *     act that also requires naming your hostnames, because binding to
 *     0.0.0.0 disables the SDK's DNS-rebinding protection.
 *  2. The MCP endpoint requires a bearer key once MCP_API_KEYS is set. An
 *     unauthenticated remote MCP endpoint is a remote-code-shaped hole: the
 *     tools can write to your business systems.
 *  3. Static keys are a bootstrap, not a destination. They identify a caller
 *     but cannot be revoked per user, scoped, or audited. Replace the verifier
 *     with real OAuth (JWT or RFC 7662 introspection) before real users.
 *  4. Upstream SaaS credentials stay server-side. The bearer key authenticates
 *     the MCP client to us; it is never forwarded upstream.
 */

import { createServer as createHttpListener, type Server as HttpListener } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { createMcpExpressApp, requireBearerAuth, type OAuthTokenVerifier } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { OAuthError, type AuthInfo } from '@modelcontextprotocol/server';

import type { AppConfig } from '../config.js';
import type { Logger } from '../core/logger.js';
import { buildServer, type ServerDependencies } from '../server.js';

/**
 * Static keys carry no natural expiry, but the bearer-auth helper rejects any
 * `AuthInfo` without one. Sessions therefore last 24 hours and clients simply
 * re-present the same key, which is invisible to the user and far better than
 * a token with a fake decade-long lifetime.
 */
const STATIC_KEY_TTL_SECONDS = 24 * 60 * 60;

/** Constant-time membership check; prevents leaking key bytes via timing. */
function matchesAnyKey(candidate: string, allowed: readonly string[]): boolean {
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  let matched = false;
  for (const key of allowed) {
    const keyBuffer = Buffer.from(key, 'utf8');
    // timingSafeEqual throws on length mismatch, so compare lengths first and
    // still run the comparison when they differ.
    if (keyBuffer.length === candidateBuffer.length && timingSafeEqual(keyBuffer, candidateBuffer)) {
      matched = true;
    }
  }
  return matched;
}

function createStaticKeyVerifier(keys: readonly string[], path: string): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (!matchesAnyKey(token, keys)) {
        // OAuthError is what turns a rejection into a 401 + WWW-Authenticate
        // challenge; any other throw would surface as a 500.
        throw new OAuthError('invalid_token', 'The supplied MCP API key is not valid.');
      }
      return {
        token,
        // Never echo the key itself: the fingerprint is what lands in logs.
        clientId: `api-key:${token.slice(0, 4)}...${token.slice(-4)}`,
        scopes: ['mcp'],
        expiresAt: Math.floor(Date.now() / 1000) + STATIC_KEY_TTL_SECONDS,
      };
    },
  };
}

export interface HttpServerHandle {
  readonly listener: HttpListener;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Start the Streamable HTTP endpoint.
 *
 * Uses a per-request server factory: a fresh `McpServer` serves each request,
 * so no state leaks between concurrent callers.
 */
export async function startHttpServer(
  config: AppConfig,
  logger: Logger,
  deps: ServerDependencies,
): Promise<HttpServerHandle> {
  const { host, port, path, apiKeys, allowedHosts } = config.http;

  const handler = createMcpHandler((context) => {
    logger.debug('mcp session opened', { clientId: context?.authInfo?.clientId ?? 'anonymous' });
    return buildServer(deps);
  });

  const app = createMcpExpressApp({
    host,
    ...(allowedHosts.length > 0 ? { allowedHosts: [...allowedHosts] } : {}),
  });

  const nodeHandler = toNodeHandler(handler);

  const middleware = [];
  if (apiKeys.length > 0) {
    middleware.push(requireBearerAuth({ verifier: createStaticKeyVerifier(apiKeys, path), requiredScopes: ['mcp'] }));
    logger.info('http auth enabled', { keyCount: apiKeys.length });
  } else {
    logger.warn(
      'HTTP transport is running WITHOUT authentication because MCP_API_KEYS is empty. ' +
        'Anyone who can reach this port can call every tool, including write tools. ' +
        'Set MCP_API_KEYS or bind to loopback only.',
      { host, port },
    );
  }

  // Liveness/readiness probe for orchestrators. Unauthenticated by design: it
  // reports reachability, never configuration or credentials.
  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      server: config.server.name,
      version: config.server.version,
      degraded: deps.degraded,
    });
  });

  app.all(path, ...middleware, (req, res) => void nodeHandler(req, res, req.body));

  const listener = createHttpListener(app);
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, host, () => {
      listener.off('error', reject);
      resolve();
    });
  });

  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}${path}`;
  logger.info('http transport listening', { url, healthz: `http://${host}:${port}/healthz` });

  return {
    listener,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
