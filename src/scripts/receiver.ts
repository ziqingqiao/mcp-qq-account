#!/usr/bin/env node
/**
 * Standalone inbound event receiver.
 *
 * The MCP server starts the same receiver on boot, but that copy only lives as
 * long as the host keeps the MCP process alive. On a desktop host the host is
 * closed most of the day, so for most of the day nothing is listening on the
 * event port. OneBot does not buffer and does not retry a failed report - it
 * logs `connect ECONNREFUSED` and moves on - so every message that arrives
 * during that window is lost outright. It is still in QQ's own history, but it
 * never reaches the queue, and no tool here can recover it.
 *
 * Running this process instead keeps the port bound around the clock. The MCP
 * server notices the bind failure, logs it, and carries on reading the same
 * on-disk queue - see the `bound` branch in ../events/server.ts.
 *
 * Keep it alive however your platform prefers: a Windows scheduled task with
 * "run whether user is logged on or not", launchd, systemd, pm2, or a plain
 * terminal you leave open. `npm run receiver` starts it in the foreground.
 */

import { loadConfig } from '../config.js';
import { createLogger } from '../core/logger.js';
import { startEventServer } from '../events/server.js';
import { buildDependencies } from '../server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, {
    server: config.server.name,
    role: 'event-receiver',
  });

  // buildDependencies constructs the OneBot client and the inbox without
  // touching the network, so a logged-out account does not stop the receiver
  // from collecting events.
  const deps = buildDependencies(config, logger);
  const events = await startEventServer(config, logger, deps.inbox);

  if (events.url === undefined) {
    // Either the receiver is disabled by config, or something already holds the
    // port. Both mean this process has no job to do, and exiting non-zero makes
    // the failure visible to whatever supervisor started it.
    logger.error(
      config.events.enabled
        ? 'receiver did not bind; another process already holds the event port'
        : 'receiver is disabled by QQ_EVENT_ENABLED; nothing to do',
      { host: config.events.host, port: config.events.port },
    );
    process.exit(1);
  }

  logger.info('standalone receiver ready', {
    url: events.url,
    inboxDir: config.inbox.dir,
  });

  const stop = (signal: string): void => {
    logger.info('shutting down', { signal });
    void events.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
