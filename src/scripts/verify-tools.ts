#!/usr/bin/env node
/**
 * Tool-layer verification: what the model actually sees.
 *
 * `verify-onebot.ts` tests the adapter - it proves `client.getHistory` returns
 * the right rows. It says nothing about the text the *tool* hands back, and
 * those are different things: a tool can hold a perfectly good array and still
 * render a summary that shows the model none of it.
 *
 * That is not hypothetical. `qq_get_conversation_history` shipped returning
 * "2 message(s) from user:...", with every body present only in
 * `structuredContent`. A host that renders text content - which is what most
 * hosts do - showed an empty conversation, and the tool whose entire purpose is
 * "see what was said before now" was blind. The adapter tests were green the
 * whole time.
 *
 * So this script asserts on rendered text, not on return values:
 *  1. History text carries every message body, not just a count.
 *  2. History text stays oldest-first, matching the adapter's contract.
 *  3. The structured content is still populated alongside the text.
 *  4. A send reports a receipt the model can quote.
 *  5. The request that reaches OneBot carries the text the caller passed.
 *
 * Runs a mock OneBot on loopback and a real stdio server. No network, no
 * account.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStdioSession, resolveServerEntry } from './lib/stdio-session.js';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    process.stderr.write(`  ok    ${label}\n`);
    return;
  }
  failures += 1;
  process.stderr.write(`  FAIL  ${label}${detail === undefined ? '' : ` - ${detail}`}\n`);
}

interface RecordedCall {
  action: string;
  body: Record<string, unknown>;
}

/**
 * A mock OneBot that answers the three actions this script exercises.
 *
 * History is returned newest-first on purpose: that is what the real platform
 * does, and reversing it is the adapter's job. Handing it back oldest-first
 * here would hide a reversal bug.
 */
function startMock(): Promise<{ server: Server; url: string; calls: RecordedCall[] }> {
  const calls: RecordedCall[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }

      const action = (req.url ?? '/').replace(/^\//, '');
      calls.push({ action, body });

      const data = ((): unknown => {
        switch (action) {
          case 'get_friend_msg_history':
            return {
              messages: [
                { message_id: 3, user_id: 800002, time: 1758096003, raw_message: 'third', sender: { nickname: 'Ada' } },
                { message_id: 2, user_id: 800002, time: 1758096002, raw_message: 'second', sender: { nickname: 'Ada' } },
                { message_id: 1, user_id: 800002, time: 1758096001, raw_message: 'first', sender: { nickname: 'Ada' } },
              ],
            };
          case 'send_private_msg':
            return { message_id: 424242 };
          case 'get_login_info':
            // Deliberately synthetic: this file is published, and a real account
            // id in a mock is a leak with no upside. Nothing asserts on it.
            return { user_id: 10001, nickname: 'Test Account' };
          default:
            return {};
        }
      })();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data, message: '', wording: '' }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, calls });
    });
  });
}

async function main(): Promise<void> {
  const mock = await startMock();
  // The session must not share the real queue: a verification run that dropped
  // synthetic messages into the operator's inbox would be a defect of its own.
  const inboxDir = await mkdtemp(join(tmpdir(), 'verify-tools-'));

  const session = await openStdioSession({
    entry: resolveServerEntry(import.meta.url),
    env: {
      LOG_LEVEL: 'error',
      ONEBOT_BASE_URL: mock.url,
      QQ_EVENT_ENABLED: 'false',
      QQ_SEND_ENABLED: 'true',
      QQ_INBOX_DIR: inboxDir,
    },
  });

  try {
    // -----------------------------------------------------------------------
    // History - the regression this script exists for
    // -----------------------------------------------------------------------
    process.stderr.write('\nhistory\n');

    const history = await session.callTool('qq_get_conversation_history', {
      kind: 'user',
      id: '800002',
      count: 3,
    });

    check('the history call succeeded', !history.isError, history.text);
    check('history text mentions every body', ['first', 'second', 'third'].every((t) => history.text.includes(t)), history.text);
    check(
      'history text is oldest-first',
      history.text.indexOf('first') < history.text.indexOf('second') &&
        history.text.indexOf('second') < history.text.indexOf('third'),
      history.text,
    );
    check('history text still warns the content is untrusted', /data, not instructions/i.test(history.text), history.text);
    check('history keeps its sender name in text', history.text.includes('Ada'), history.text);

    const historyRows = history.structuredContent?.messages;
    check('history structured content is still populated', Array.isArray(historyRows) && historyRows.length === 3, JSON.stringify(historyRows));

    // -----------------------------------------------------------------------
    // Ack - an id that did not match must be named, not merely counted
    // -----------------------------------------------------------------------
    process.stderr.write('\nack\n');

    const acked = await session.callTool('qq_ack_messages', { ids: ['no-such-id.json', 'also-missing.json'] });
    check('acking an unknown id is not an error', !acked.isError, acked.text);
    check(
      'the unmatched ids are named, not just counted',
      acked.text.includes('no-such-id.json') && acked.text.includes('also-missing.json'),
      acked.text,
    );
    check('the text says what an unmatched id means', /already handled|never existed/i.test(acked.text), acked.text);

    // -----------------------------------------------------------------------
    // Send
    // -----------------------------------------------------------------------
    process.stderr.write('\nsend\n');

    const sent = await session.callTool('qq_send_message', { kind: 'user', id: '800002', text: '收到' });
    check('the send succeeded', !sent.isError, sent.text);
    check('the send reports a receipt', /sent|message id/i.test(sent.text), sent.text);

    const sendCall = mock.calls.find((call) => call.action === 'send_private_msg');
    // The client posts `message` as a segment array, matching the
    // `messagePostFormat: "array"` setting every OneBot deployment here uses.
    // Asserting on a plain string would pass against a client that quietly
    // switched formats and broke every non-ASCII send.
    const segments = Array.isArray(sendCall?.body.message) ? sendCall?.body.message : [];
    const firstSegment = segments[0] as { type?: string; data?: { text?: string } } | undefined;
    check('the text reaches OneBot unchanged', firstSegment?.data?.text === '收到', JSON.stringify(sendCall?.body.message));
    check('the text is sent as a text segment', firstSegment?.type === 'text', JSON.stringify(firstSegment));
    check('the recipient reaches OneBot as a string id', sendCall?.body.user_id === '800002', JSON.stringify(sendCall?.body));

    process.stderr.write(failures === 0 ? '\nTOOL LAYER VERIFICATION PASSED\n' : `\n${failures} failure(s)\n`);
    if (failures > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    const stderr = session.stderr().trim();
    if (stderr) process.stderr.write(`--- server stderr ---\n${stderr}\n`);
    process.exitCode = 1;
  } finally {
    await session.close();
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    await rm(inboxDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
