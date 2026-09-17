#!/usr/bin/env node
/**
 * Entry point. Chooses one transport, starts the inbound event receiver, and
 * wires shutdown.
 *
 * Because stdout is the JSON-RPC channel in stdio mode, nothing in this process
 * may write to it except the transport. All diagnostics go to stderr through
 * the logger; `console.log` is never used anywhere in this codebase.
 *
 * The event receiver starts in BOTH transports. It is not part of MCP - it is
 * the side channel that lets OneBot push messages in - so it is independent of
 * how the host talks to us.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadConfig, type AppConfig } from './config.js';
import { createLogger, serialiseError, type Logger } from './core/logger.js';
import { startEventServer, type EventServerHandle } from './events/server.js';
import { buildDependencies, buildServer, type ServerDependencies } from './server.js';
import { startHttpServer } from './transports/http.js';

/**
 * Boot-time reachability check.
 *
 * Deliberately non-blocking and non-fatal: a logged-out or unreachable account
 * session must not stop the server from answering `tools/list`, otherwise the
 * host shows a broken integration with no reason attached.
 */
function probeUpstream(deps: ServerDependencies, logger: Logger): void {
  void deps.onebot
    .probe()
    .then((result) => {
      if (result.reachable) {
        logger.info('onebot probe ok', { detail: result.detail });
        return;
      }
      logger.warn('OneBot is not reachable at boot; tools will report errors until it recovers', {
        detail: result.detail,
      });
    })
    .catch((error: unknown) => logger.warn('onebot probe failed', serialiseError(error)));
}

async function runStdio(
  config: AppConfig,
  logger: Logger,
  deps: ServerDependencies,
  events: EventServerHandle,
): Promise<void> {
  // The factory runs once per connection, matching the HTTP path's semantics.
  serveStdio(() => buildServer(deps));

  logger.info('stdio transport ready', {
    server: config.server.name,
    version: config.server.version,
    sendEnabled: deps.onebot.canSend,
    inboxDir: config.inbox.dir,
    degraded: deps.degraded,
  });

  probeUpstream(deps, logger);

  if (deps.degraded.length > 0) {
    logger.warn('server started in degraded mode', { degraded: deps.degraded });
  }

  // The host may kill this process at any time; closing the receiver keeps the
  // port free for the next copy the host spawns.
  const stop = (): void => {
    void events.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

async function runHttp(
  config: AppConfig,
  logger: Logger,
  deps: ServerDependencies,
  events: EventServerHandle,
): Promise<void> {
  const handle = await startHttpServer(config, logger, deps);

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    void Promise.all([handle.close(), events.close()])
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error('shutdown failed', serialiseError(error));
        process.exit(1);
      });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, {
    server: config.server.name,
    transport: config.transport,
  });

  logger.info('starting', {
    version: config.server.version,
    transport: config.transport,
    node: process.version,
  });

  const deps = buildDependencies(config, logger);
  const events = await startEventServer(config, logger, deps.inbox);

  if (config.transport === 'stdio') {
    await runStdio(config, logger, deps, events);
    return;
  }
  await runHttp(config, logger, deps, events);
}

main().catch((error: unknown) => {
  // Configuration and boot failures are operator-facing, so they go to stderr
  // as plain text as well: if the logger itself failed to construct, a
  // structured line would never be emitted.
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
