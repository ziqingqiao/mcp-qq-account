#!/usr/bin/env node
/**
 * Inbound event receiver verification.
 *
 * The receiver is the only path by which another person's words reach the
 * model, so what it accepts and what it drops is a security property, not a
 * detail. This exercises it over real HTTP against a real listener.
 *
 * What it proves:
 *  1. A group or private message is parsed out of an OneBot report and queued.
 *  2. A redelivery of the same event is dropped - the platform documents that
 *     it may push the same event more than once.
 *  3. The account's own messages, heartbeats and notices are not queued. Queuing
 *     the account's own replies would let the model read them as if a person
 *     had sent them and answer itself.
 *  4. A missing or wrong token is rejected before the body is even parsed.
 *  5. Oversized and malformed bodies are refused rather than stored.
 *
 * Runs on a random high port on loopback. No network, no OneBot, no account.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig } from '../config.js';
import { createLogger } from '../core/logger.js';
import { startEventServer } from '../events/server.js';
import { Inbox } from '../inbox/store.js';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    process.stderr.write(`  ok    ${label}\n`);
    return;
  }
  failures += 1;
  process.stderr.write(`  FAIL  ${label}${detail === undefined ? '' : ` - ${detail}`}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Is anything accepting connections on this port? */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Bind an arbitrary free port and hand back both the server and its number. */
function occupyPort(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
    });
  });
}

const log = createLogger('error');
const TOKEN = 'verify-token-9f3a';

function buildConfig(port: number, dir: string, token: string | undefined): AppConfig {
  return {
    transport: 'stdio',
    logLevel: 'error',
    server: { name: 'qq-account', version: '0.0.0-test' },
    onebot: { baseUrl: 'http://127.0.0.1:1', accessToken: undefined, sendEnabled: true },
    upstream: { timeoutMs: 5_000, maxRetries: 0 },
    events: { enabled: true, host: '127.0.0.1', port, path: '/onebot/events', token, bindRetrySeconds: 0 },
    inbox: { dir, maxBatch: 50 },
    http: { host: '127.0.0.1', port: 0, path: '/mcp', apiKeys: [], allowedHosts: [] },
  };
}

interface PostResult {
  status: number;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<PostResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  // Drain the body so the socket is released.
  await response.text();
  return { status: response.status };
}

const SELF_ID = 700001;

function groupMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 1001,
    group_id: 900001,
    user_id: 800001,
    self_id: SELF_ID,
    sender: { nickname: '张三' },
    message: [{ type: 'text', data: { text: '在吗' } }],
    raw_message: '在吗',
    time: 1758096000,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'qq-events-verify-'));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const config = buildConfig(port, dir, TOKEN);
  const inbox = new Inbox({ dir, logger: log });

  const handle = await startEventServer(config, log, inbox);
  if (handle.url === undefined) {
    process.stderr.write(`could not bind port ${port}; skipping the receiver checks\n`);
    await rm(dir, { recursive: true, force: true });
    return;
  }

  const url = handle.url;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  try {
    // --- authentication -----------------------------------------------------
    process.stderr.write('authentication\n');
    const noToken = await post(url, groupMessage());
    check('a report with no token is rejected', noToken.status === 401, `got ${noToken.status}`);

    const wrongToken = await post(url, groupMessage(), { Authorization: 'Bearer nope' });
    check('a report with a wrong token is rejected', wrongToken.status === 401, `got ${wrongToken.status}`);

    const queryToken = await post(`${url}?access_token=${TOKEN}`, groupMessage({ message_id: 1002, time: 1758096002 }));
    check('a token in the query string is accepted', queryToken.status === 204, `got ${queryToken.status}`);

    const authorised = await post(url, groupMessage({ time: 1758096001 }), auth);
    check('an authorised report is accepted', authorised.status === 204, `got ${authorised.status}`);

    // --- routing ------------------------------------------------------------
    process.stderr.write('\nrouting and body handling\n');
    const wrongPath = await fetch(url.replace('/onebot/events', '/nope'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(groupMessage()),
    });
    await wrongPath.text();
    check('an unknown path is 404', wrongPath.status === 404, `got ${wrongPath.status}`);

    const badJson = await post(url, '{not json', auth);
    check('malformed JSON is 400', badJson.status === 400, `got ${badJson.status}`);

    const huge = await post(url, JSON.stringify({ pad: 'x'.repeat(1_100_000) }), auth);
    check('an oversized body is refused', huge.status === 413, `got ${huge.status}`);

    // --- what gets queued ---------------------------------------------------
    process.stderr.write('\nwhat gets queued\n');
    const afterBasics = await inbox.stats();
    check(
      'only the two real messages were queued',
      afterBasics.pending === 2,
      `expected 2, got ${afterBasics.pending}`,
    );

    const duplicate = await post(url, groupMessage(), auth);
    check('a redelivered event is accepted but not queued again', duplicate.status === 204);
    check('the queue did not grow', (await inbox.stats()).pending === 2);

    // The account's own messages come back through the report in some
    // implementations. Queuing them would let the model read its own reply as
    // if a person had written it - and then answer it.
    await post(url, groupMessage({ message_id: 1003, user_id: SELF_ID }), auth);
    check('the account\'s own message is not queued', (await inbox.stats()).pending === 2);

    await post(url, { post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: SELF_ID, time: 1758096000 }, auth);
    await post(url, { post_type: 'notice', notice_type: 'group_recall', group_id: 900001, user_id: 800001 }, auth);
    await post(url, { post_type: 'request', request_type: 'friend', user_id: 800003 }, auth);
    check('heartbeats, notices and requests are not queued', (await inbox.stats()).pending === 2);

    const empty = await post(url, groupMessage({ message_id: 1004, raw_message: '', message: [] }), auth);
    check('a message with no text is accepted and dropped', empty.status === 204);
    check('the queue did not grow', (await inbox.stats()).pending === 2);

    // A private chat has no group_id; the sender is the conversation.
    await post(
      url,
      {
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: 1005,
        user_id: 800002,
        self_id: SELF_ID,
        sender: { nickname: '李四' },
        message: [{ type: 'text', data: { text: '你好' } }],
        raw_message: '你好',
        time: 1758096005,
      },
      auth,
    );

    // Image-only messages arrive with an empty raw_message but a text segment
    // alongside the image, or with nothing usable at all. Falling back to the
    // segment list is what keeps "sent a photo with a caption" from being
    // silently discarded as an empty message.
    await post(
      url,
      groupMessage({
        message_id: 1006,
        time: 1758096006,
        raw_message: '',
        message: [
          { type: 'image', data: { file: 'x.jpg' } },
          { type: 'text', data: { text: '看这个' } },
        ],
      }),
      auth,
    );

    // --- the queue's contents ----------------------------------------------
    process.stderr.write('\nqueue contents\n');
    const read = await inbox.read(50);
    check('four messages are queued', read.messages.length === 4, `got ${read.messages.length}`);

    const group = read.messages.find((entry) => entry.kind === 'group');
    check('a group message keeps its conversation id', group?.conversationId === '900001');
    check('a group message keeps its sender', group?.senderName === '张三');
    check('a group message keeps its text', group?.text === '在吗');
    check('the platform message id is preserved', group?.platformMessageId === '1001');

    const priv = read.messages.find((entry) => entry.kind === 'user');
    check('a private message is keyed by the sender', priv?.conversationId === '800002');

    const captioned = read.messages.find((entry) => entry.platformMessageId === '1006');
    check('a caption alongside an image is kept', captioned?.text === '看这个');

    check(
      'messages are ordered oldest first',
      read.messages.map((entry) => entry.platformMessageId).join(',') === '1001,1002,1005,1006',
      read.messages.map((entry) => entry.platformMessageId).join(','),
    );

    // -------------------------------------------------------------------------
    // The standalone receiver waits for the port instead of exiting
    // -------------------------------------------------------------------------
    process.stderr.write('\nstandalone receiver\n');

    {
      // The receiver normally runs as a long-lived process precisely so that
      // the port is owned while the host is closed. A copy that lost the race
      // at boot and exited would leave nothing listening the moment the host
      // went away - the exact window it exists to cover - and it would do so
      // silently. Hence: it must wait, not die.
      const { server: blocker, port: blockerPort } = await occupyPort();

      const receiver = spawn(process.execPath, [fileURLToPath(new URL('./receiver.js', import.meta.url))], {
        env: {
          ...process.env,
          LOG_LEVEL: 'info',
          QQ_EVENT_ENABLED: 'true',
          QQ_EVENT_HOST: '127.0.0.1',
          QQ_EVENT_PORT: String(blockerPort),
          QQ_EVENT_BIND_RETRY_SECONDS: '1',
          QQ_INBOX_DIR: dir,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let receiverStderr = '';
      receiver.stderr?.on('data', (chunk: Buffer) => {
        receiverStderr += chunk.toString('utf8');
      });

      await sleep(2_500);
      check(
        'a receiver that lost the port race stays alive',
        receiver.exitCode === null,
        `exited with ${String(receiver.exitCode)}: ${receiverStderr}`,
      );

      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });

      let tookOver = false;
      for (let attempt = 0; attempt < 40 && !tookOver; attempt += 1) {
        await sleep(250);
        tookOver = await canConnect(blockerPort);
      }
      check('it takes the port over once it is released', tookOver, receiverStderr);

      receiver.kill('SIGTERM');
      await sleep(500);
    }

    process.stderr.write(`\n${failures} failure(s)\n`);
    if (failures > 0) {
      process.exitCode = 1;
      return;
    }
    process.stderr.write('EVENT RECEIVER VERIFICATION PASSED\n');
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
