#!/usr/bin/env node
/**
 * OneBot connectivity probe.
 *
 * Answers the only question that matters before wiring this into a host: is
 * there a logged-in QQ account on the other end, and can we see it?
 *
 * Deliberately separate from `verify`: that suite must pass with no network and
 * no account, so it cannot contain anything that talks upstream. This script is
 * the opposite - it is entirely about the upstream, and it is expected to fail
 * until a session is up.
 *
 *   npm run probe
 */

import { loadConfig } from '../config.js';
import { createLogger, serialiseError } from '../core/logger.js';
import { Inbox } from '../inbox/store.js';
import { OneBotClient } from '../providers/onebot/client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger('warn');

  const client = new OneBotClient({
    baseUrl: config.onebot.baseUrl,
    accessToken: config.onebot.accessToken,
    timeoutMs: config.upstream.timeoutMs,
    maxRetries: 0,
    logger,
    sendEnabled: config.onebot.sendEnabled,
  });

  const out = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  out(`OneBot base URL : ${config.onebot.baseUrl}`);
  out(`Access token    : ${config.onebot.accessToken === undefined ? 'not set' : 'set'}`);
  out(`Sending         : ${client.canSend ? 'enabled' : 'DISABLED by QQ_SEND_ENABLED'}`);
  out('');

  // --- the account session --------------------------------------------------
  const probe = await client.probe();
  if (!probe.reachable) {
    out('FAIL  no usable account session.');
    out(`      ${probe.detail}`);
    out('');
    out('What to check, in order:');
    out('  1. Is the OneBot implementation (NapCat / Lagrange) running?');
    out(`  2. Is it listening on ${config.onebot.baseUrl}? Its HTTP server is often on a`);
    out('     different port than its WebSocket, and off by default.');
    out('  3. Is the QQ account actually logged in there? A running implementation with no');
    out('     session answers /get_login_info with an error, not a login.');
    out('  4. If ONEBOT_ACCESS_TOKEN is set, does it match the implementation\'s token?');
    process.exitCode = 1;
    return;
  }
  out(`ok    account session: ${probe.detail}`);

  // --- visibility -----------------------------------------------------------
  try {
    const friends = await client.listFriends();
    const groups = await client.listGroups();
    out(`ok    visible conversations: ${friends.length} friend(s), ${groups.length} group(s)`);
    if (friends.length === 0 && groups.length === 0) {
      out('      note: the account has no friends or groups visible, so qq_list_conversations');
      out('      will return nothing and there is no recipient to send to.');
    }
  } catch (error) {
    out(`warn  could not list conversations: ${error instanceof Error ? error.message : String(error)}`);
  }

  // --- the inbound side -----------------------------------------------------
  const inbox = new Inbox({ dir: config.inbox.dir, logger });
  const stats = await inbox.stats();
  out(`ok    inbox: ${stats.pending} unread, ${stats.read} archived (${config.inbox.dir})`);

  if (!config.events.enabled) {
    out('warn  the inbound event receiver is DISABLED (QQ_EVENT_ENABLED=false).');
    out('      Nothing new will arrive; qq_read_messages will only see what is already queued.');
  } else {
    const host = config.events.host === '0.0.0.0' ? '127.0.0.1' : config.events.host;
    out('');
    out('Point the OneBot implementation\'s HTTP report at:');
    out(`  http://${host}:${config.events.port}${config.events.path}`);
    if (config.events.token === undefined) {
      out('  (no token configured - loopback only, do not expose this port)');
    } else {
      out('  (send Authorization: Bearer <QQ_EVENT_TOKEN>, or append ?access_token=<value>)');
    }
  }

  out('');
  out('All checks passed. Start the server and call qq_get_account from your host.');
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(`${JSON.stringify(serialiseError(error))}\n`);
  process.exit(1);
});
