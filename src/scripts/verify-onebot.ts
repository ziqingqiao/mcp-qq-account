#!/usr/bin/env node
/**
 * OneBot adapter verification.
 *
 * WHY THIS SUITE EXISTS
 *
 * Every other suite in this project deliberately avoids the upstream: they
 * prove the queue, the receiver, the transport and the tool contract, all with
 * no OneBot anywhere. That leaves `providers/onebot/client.ts` - the module
 * that actually talks to the account, and the one whose bugs are expensive -
 * covered by nothing. `npm run probe` cannot stand in for it either: probe
 * needs a live account, so it is the one thing that can never run in CI.
 *
 * WHAT MAKES THIS ADAPTER WORTH ITS OWN SUITE
 *
 * OneBot answers **HTTP 200 for failures**. The status line is not the outcome;
 * the outcome is `retcode` inside the body. So the entire correctness of this
 * adapter rests on one line in `call()`, and the failure mode when it is wrong
 * is the worst kind: `qq_send_message` reports success for a message that was
 * never delivered. Nothing else in the project has that property.
 *
 * WHAT IT PROVES
 *
 *  1. A non-zero `retcode` becomes an error even though the HTTP status is 200
 *     - the single most important behaviour here.
 *  2. Codes that look successful but are not (`status: "failed"` with a zero
 *     retcode) are still errors.
 *  3. Each mapped retcode produces its own actionable hint, and an unmapped one
 *     still produces something actionable rather than a dead end.
 *  4. Text is sent as a **segment**, never a bare string, so a body containing
 *     `[CQ:at,qq=all]` is delivered literally instead of being executed.
 *  5. Ids survive the JSON round trip as strings, including the large numeric
 *     values QQ actually uses.
 *  6. A missing `user_id` on login is an error, not an unnamed account.
 *  7. `remark` (the owner's own label) wins over `nickname`, because that is
 *     what the account owner sees and would recognise.
 *  8. Malformed upstream shapes degrade to empty lists instead of throwing -
 *     one odd row must not blank the whole conversation list.
 *  9. History is returned oldest-first even though OneBot sends newest-first.
 * 10. An implementation without history reports "unsupported" in words the
 *     model can act on, rather than a generic upstream failure.
 * 11. The credential is attached as a header and never appears in tool-visible
 *     output.
 *
 * Runs a real HTTP server that speaks OneBot on loopback. No network, no
 * account, and - importantly - the mock answers the way the platform does,
 * including its 200-with-an-error-envelope habit.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { createLogger } from '../core/logger.js';
import { UpstreamError, describeFailure } from '../core/errors.js';
import { OneBotClient } from '../providers/onebot/client.js';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    process.stderr.write(`  ok    ${label}\n`);
    return;
  }
  failures += 1;
  process.stderr.write(`  FAIL  ${label}${detail === undefined ? '' : ` - ${detail}`}\n`);
}

const log = createLogger('error');
const ACCESS_TOKEN = 'verify-onebot-token-7a2b';

/** One recorded call, so tests can assert on what was *sent*, not just what came back. */
interface RecordedCall {
  action: string;
  body: Record<string, unknown>;
  authorization: string | undefined;
}

/**
 * A mock OneBot implementation.
 *
 * `handler` decides the response for each action, which lets a test choose
 * between a success envelope, a failure envelope, and a status-code error.
 * Every call is recorded first, so assertions about the request do not depend
 * on the handler.
 */
type Handler = (body: Record<string, unknown>) => { status?: number; payload: unknown };

function startMock(handler: Handler): Promise<{ server: Server; url: string; calls: RecordedCall[] }> {
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
      calls.push({
        action,
        body,
        authorization: req.headers.authorization,
      });

      const { status = 200, payload } = handler(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
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

/** The envelope shape OneBot uses for success. */
function ok(data: unknown): { payload: unknown } {
  return { payload: { status: 'ok', retcode: 0, data } };
}

/** The envelope shape for a rejected action. Note: HTTP 200, like the real thing. */
function rejected(retcode: number, message: string): { payload: unknown } {
  return { payload: { status: 'failed', retcode, message, wording: message } };
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. The 200-with-an-error habit
  // ---------------------------------------------------------------------------
  process.stderr.write('the status line is not the outcome\n');

  {
    const mock = await startMock((body) => {
      const action = body.__action as string | undefined;
      void action;
      return rejected(1, 'something went wrong inside the implementation');
    });

    const client = new OneBotClient({
      baseUrl: mock.url,
      accessToken: undefined,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });

    // A non-zero retcode under HTTP 200 must be an error. If this is wrong,
    // qq_send_message reports a delivered message that never was.
    let threw = false;
    try {
      await client.getAccount();
    } catch (error) {
      threw = error instanceof UpstreamError;
    }
    check('a non-zero retcode under HTTP 200 is an error', threw);

    try {
      await client.getAccount();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      check('the rejection names the action', message.includes('get_login_info'), message.slice(0, 100));
      check('the rejection carries the implementation\'s reason', message.includes('something went wrong'), message.slice(0, 120));
    }

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }

  // `status: "failed"` with retcode 0 is the other shape a failure can take.
  {
    const mock = await startMock(() => ({
      payload: { status: 'failed', retcode: 0, message: 'no data available' },
    }));

    const client = new OneBotClient({
      baseUrl: mock.url,
      accessToken: undefined,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });

    let threw = false;
    try {
      await client.getAccount();
    } catch (error) {
      threw = error instanceof UpstreamError;
    }
    check('status "failed" is an error even when retcode is 0', threw);
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }

  // ---------------------------------------------------------------------------
  // 2. retcode -> hint
  // ---------------------------------------------------------------------------
  process.stderr.write('\nevery rejection says what to do about it\n');

  {
    // Each of these maps to a distinct, actionable hint. The point is not the
    // wording but that the model is told *what to change* - a bare "failed"
    // invites an identical retry.
    const mapped: Array<{ retcode: number; marker: RegExp; label: string }> = [
      { retcode: 103, marker: /group/i, label: '103 (group missing) mentions the group' },
      { retcode: 104, marker: /friend|list_conversations/i, label: '104 (user unreachable) points at the id' },
      { retcode: 106, marker: /online|login/i, label: '106 (not online) points at the session' },
      { retcode: 1401, marker: /empty/i, label: '1401 (empty body) says the body was empty' },
      { retcode: 1404, marker: /conversation|list_conversations/i, label: '1404 (not in conversation) points at re-checking' },
    ];

    for (const { retcode, marker, label } of mapped) {
      const mock = await startMock(() => rejected(retcode, 'rejected by the implementation'));
      const client = new OneBotClient({
        baseUrl: mock.url,
        accessToken: undefined,
        timeoutMs: 3_000,
        maxRetries: 0,
        logger: log,
      });

      let hint = '';
      try {
        await client.sendToGroup('900001', 'hi');
      } catch (error) {
        // Read the hint through `describeFailure`, not off the error. The raw
        // `UpstreamError.message` carries only the upstream's words - the hint
        // is composed in when the tool layer turns it into model-facing text,
        // and that composed sentence is what the model actually reads.
        hint = describeFailure('qq_send_message', error);
      }
      check(label, marker.test(hint), hint.slice(0, 200));
      await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    }

    // An unmapped code must still say something usable. Falling through to a
    // silent generic failure is how an unknown code becomes a dead end.
    const mock = await startMock(() => rejected(9999, 'unknown condition'));
    const client = new OneBotClient({
      baseUrl: mock.url,
      accessToken: undefined,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });
    let unknownHint = '';
    try {
      await client.getAccount();
    } catch (error) {
      unknownHint = describeFailure('qq_get_account', error);
    }
    check('an unmapped retcode still produces a message', unknownHint.length > 0, unknownHint.slice(0, 150));
    check('an unmapped retcode still names the code', unknownHint.includes('9999'), unknownHint.slice(0, 150));
    // Whatever the code, the model must be told whether retrying helps.
    check(
      'every rejection says whether to retry',
      /do not retry|retry is reasonable/i.test(unknownHint),
      unknownHint.slice(0, 200),
    );
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }

  // ---------------------------------------------------------------------------
  // 3. Text must be sent as a segment
  // ---------------------------------------------------------------------------
  process.stderr.write('\ntext is sent literally, never interpreted\n');

  {
    const mock = await startMock(() => ok({ message_id: 4242 }));
    const client = new OneBotClient({
      baseUrl: mock.url,
      accessToken: undefined,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });

    // This body is the reason the segment form exists. OneBot parses a bare
    // string for CQ codes, so sending this as a string would make the account
    // announce "@全体成员" instead of saying the words.
    const dangerous = '[CQ:at,qq=all] hello';
    await client.sendToGroup('900001', dangerous);

    const sent = mock.calls[0];
    check('sending a group message posts to send_group_msg', sent?.action === 'send_group_msg', sent?.action);
    check(
      'the message body is an array of segments, not a string',
      Array.isArray(sent?.body.message),
      typeof sent?.body.message,
    );

    const segment = (sent?.body.message as Array<{ type?: string; data?: { text?: string } }> | undefined)?.[0];
    check('the segment is typed as text', segment?.type === 'text', String(segment?.type));
    check(
      'the CQ code is preserved as literal text',
      segment?.data?.text === dangerous,
      String(segment?.data?.text),
    );
    check('the group id is passed through', sent?.body.group_id === '900001', String(sent?.body.group_id));

    // The same rule for private messages - a separate code path, so it is a
    // separate assertion rather than an assumption.
    await client.sendToUser('800002', dangerous);
    const privateCall = mock.calls[1];
    check('sending a private message posts to send_private_msg', privateCall?.action === 'send_private_msg', privateCall?.action);
    check('the private message body is also segmented', Array.isArray(privateCall?.body.message));
    check('the user id is passed through', privateCall?.body.user_id === '800002', String(privateCall?.body.user_id));

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }

  // ---------------------------------------------------------------------------
  // 4. Identity
  // ---------------------------------------------------------------------------
  process.stderr.write('\nidentity\n');

  {
    const mock = await startMock(() => ok({ user_id: 1234567890123, nickname: '测试号' }));
    const client = new OneBotClient({
      baseUrl: mock.url,
      accessToken: undefined,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });

    const account = await client.getAccount();
    // QQ ids exceed 2^32 and arrive as JSON numbers. Keeping them as strings
    // avoids a rounding surprise anywhere downstream.
    check('a large numeric user id becomes an exact string', account.userId === '1234567890123', account.userId);
    check('the nickname is read', account.nickname === '测试号', account.nickname);

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }

  {
    // No user_id means identity cannot be confirmed. Reporting an unnamed
    // account instead would let the model claim to know who it is speaking as.
    const mock = await startMock(() => ok({ nickname: 'no id here' }));
    const client = new OneBotClient({
      baseUrl: mock.url,
      accessToken: undefined,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });

    let message = '';
    try {
      await client.getAccount();
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    check('a login response with no user_id is an error', message !== '', message.slice(0, 120));
    check('the error explains that identity is unconfirmed', /user_id|identity/i.test(message), message.slice(0, 120));

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }

  // ---------------------------------------------------------------------------
  // 5. Conversation listing
  // ---------------------------------------------------------------------------
  process.stderr.write('\nconversation listing\n');

  {
    const friends = [
      { user_id: 800002, nickname: '正经名字', remark: '备注名' },
      { user_id: 800003, nickname: '只有昵称' },
      { nickname: 'no id, must be skipped' },
      { user_id: '800004', nickname: '' },
    ];
    const groups = [
      { group_id: 900001, group_name: '项目群', member_count: 42 },
      { group_id: 900002, group_name: '没有成员数' },
      { group_name: 'no id, must be skipped' },
    ];

    // Answers by action, the way a real implementation does.
    const routed = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const action = (req.url ?? '/').replace(/^\//, '');
        const data = action === 'get_friend_list' ? friends : action === 'get_group_list' ? groups : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
      });
    });
    await new Promise<void>((resolve) => routed.listen(0, '127.0.0.1', () => resolve()));
    const routedAddress = routed.address();
    const routedPort = typeof routedAddress === 'object' && routedAddress !== null ? routedAddress.port : 0;

    const client = new OneBotClient({
      baseUrl: `http://127.0.0.1:${routedPort}`,
      accessToken: undefined,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });

    const listedFriends = await client.listFriends();
    check('a friend row without an id is skipped', listedFriends.length === 3, `got ${listedFriends.length}`);
    // `remark` is the local alias and is what the owner sees, so it must win.
    check(
      'a friend remark wins over the nickname',
      listedFriends[0]?.name === '备注名',
      listedFriends[0]?.name,
    );
    check('a friend with only a nickname falls back to it', listedFriends[1]?.name === '只有昵称', listedFriends[1]?.name);
    check(
      'a friend with an empty name falls back to the id',
      listedFriends[2]?.name === '800004',
      listedFriends[2]?.name,
    );
    check('friend ids are exact strings', listedFriends[0]?.id === '800002', listedFriends[0]?.id);

    const listedGroups = await client.listGroups();
    check('a group row without an id is skipped', listedGroups.length === 2, `got ${listedGroups.length}`);
    check('a group name is read', listedGroups[0]?.name === '项目群', listedGroups[0]?.name);
    check('a group member count is read', listedGroups[0]?.memberCount === 42, String(listedGroups[0]?.memberCount));
    check(
      'a group without a member count omits the field',
      listedGroups[1]?.memberCount === undefined,
      String(listedGroups[1]?.memberCount),
    );
    check('groups are tagged as groups', listedGroups[0]?.kind === 'group');

    await new Promise<void>((resolve) => routed.close(() => resolve()));
  }

  // A malformed upstream shape must not throw: one odd payload should not make
  // the whole conversation list unavailable.
  {
    const mock = await startMock(() => ok('this should have been an array'));
    const client = new OneBotClient({
      baseUrl: mock.url,
      accessToken: undefined,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });

    let threw = false;
    let result: unknown[] = [];
    try {
      result = await client.listFriends();
    } catch {
      threw = true;
    }
    check('a non-array friend list degrades to empty rather than throwing', !threw && result.length === 0);
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }

  // ---------------------------------------------------------------------------
  // 6. History
  // ---------------------------------------------------------------------------
  process.stderr.write('\nhistory\n');

  {
    // OneBot returns newest-first; the model needs oldest-first, and the
    // adapter reverses. Getting this backwards would reverse the conversation.
    const mock = await startMock(() =>
      ok({
        messages: [
          { message_id: 3, user_id: 800002, time: 1758096003, raw_message: 'third', sender: { nickname: 'A' } },
          { message_id: 2, user_id: 800002, time: 1758096002, raw_message: 'second', sender: { nickname: 'A' } },
          { message_id: 1, user_id: 800002, time: 1758096001, raw_message: 'first', sender: { nickname: 'A' } },
        ],
      }),
    );

    const client = new OneBotClient({
      baseUrl: mock.url,
      accessToken: undefined,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });

    const history = await client.getHistory('user', '800002', 3);
    check('history is returned oldest first', history[0]?.text === 'first', history[0]?.text);
    check('history order is complete', history.map((m) => m.text).join(',') === 'first,second,third', history.map((m) => m.text).join(','));
    check('a history entry keeps its sender name', history[0]?.senderName === 'A', String(history[0]?.senderName));
    check('a unix seconds timestamp becomes an ISO string', /^\d{4}-\d{2}-\d{2}T/.test(history[0]?.at ?? ''), String(history[0]?.at));

    const sent = mock.calls[0];
    check('a private history request uses get_friend_msg_history', sent?.action === 'get_friend_msg_history', sent?.action);

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }

  {
    // A group history must hit the other action: mixing them up would fetch
    // from the wrong conversation entirely.
    const mock = await startMock(() => ok({ messages: [] }));
    const client = new OneBotClient({
      baseUrl: mock.url,
      accessToken: undefined,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });

    await client.getHistory('group', '900001', 5);
    const sent = mock.calls[0];
    check('a group history request uses get_group_msg_history', sent?.action === 'get_group_msg_history', sent?.action);
    check('a group history request carries the group id', sent?.body.group_id === '900001', String(sent?.body.group_id));

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }

  {
    // Implementations vary in whether history exists at all. A 404 must become
    // "this implementation does not support it", not a generic upstream error -
    // otherwise the model keeps retrying something that cannot work.
    const mock = await startMock(() => ({ status: 404, payload: { status: 'failed', retcode: 100, message: 'not found' } }));
    const client = new OneBotClient({
      baseUrl: mock.url,
      accessToken: undefined,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });

    let message = '';
    try {
      await client.getHistory('group', '900001', 5);
    } catch (error) {
      // Again through `describeFailure`: the "read the inbox instead"
      // suggestion lives in the hint, which is composed at the tool layer.
      message = describeFailure('qq_get_conversation_history', error);
    }
    check('an unsupported history action is reported as unsupported', /does not provide|not support/i.test(message), message.slice(0, 200));
    check('the unsupported message suggests an alternative', /inbox|qq_read_messages/i.test(message), message.slice(0, 220));
    // "Some implementations do not support this" is a permanent condition, so
    // the model must not be told to try again.
    check('an unsupported action is not marked retryable', /do not retry/i.test(message), message.slice(0, 220));
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }

  // ---------------------------------------------------------------------------
  // 7. Credential handling
  // ---------------------------------------------------------------------------
  process.stderr.write('\ncredentials\n');

  {
    const mock = await startMock(() => ok({ user_id: 1, nickname: 'x' }));
    const client = new OneBotClient({
      baseUrl: mock.url,
      accessToken: ACCESS_TOKEN,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });

    await client.getAccount();
    const sent = mock.calls[0];
    check(
      'the access token is sent as a bearer header',
      sent?.authorization === `Bearer ${ACCESS_TOKEN}`,
      String(sent?.authorization).slice(0, 20),
    );
    // The token travels in a header, never in the body - a body would surface
    // in upstream logs and in anything that echoes the request back.
    check(
      'the token is not placed in the request body',
      !JSON.stringify(sent?.body ?? {}).includes(ACCESS_TOKEN),
    );

    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }

  {
    // With no token configured, no Authorization header should be sent at all
    // - sending an empty bearer value would be rejected by the implementation.
    const mock = await startMock(() => ok({ user_id: 1, nickname: 'x' }));
    const client = new OneBotClient({
      baseUrl: mock.url,
      accessToken: undefined,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });

    await client.getAccount();
    check('no Authorization header is sent when no token is configured', mock.calls[0]?.authorization === undefined, String(mock.calls[0]?.authorization));
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }

  // ---------------------------------------------------------------------------
  // 8. probe()
  // ---------------------------------------------------------------------------
  process.stderr.write('\nreachability probe\n');

  {
    const mock = await startMock(() => ok({ user_id: 800001, nickname: '探针' }));
    const client = new OneBotClient({
      baseUrl: mock.url,
      accessToken: undefined,
      timeoutMs: 3_000,
      maxRetries: 0,
      logger: log,
    });

    const probe = await client.probe();
    check('probe reports reachable when the account answers', probe.reachable);
    check('probe names the account it found', probe.detail.includes('探针'), probe.detail);
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }

  {
    // The probe must return, not throw: it runs at boot, and a dead upstream
    // must not stop the server from answering tools/list.
    const client = new OneBotClient({
      baseUrl: 'http://127.0.0.1:1',
      accessToken: undefined,
      timeoutMs: 1_000,
      maxRetries: 0,
      logger: log,
    });
    const probe = await client.probe();
    check('probe returns unreachable instead of throwing', !probe.reachable);
    check('probe explains why it is unreachable', probe.detail.length > 0, probe.detail.slice(0, 100));
  }

  // ---------------------------------------------------------------------------
  // 9. The kill switch is a client property
  // ---------------------------------------------------------------------------
  process.stderr.write('\nthe send switch\n');

  {
    const client = new OneBotClient({
      baseUrl: 'http://127.0.0.1:1',
      accessToken: undefined,
      timeoutMs: 1_000,
      maxRetries: 0,
      logger: log,
      sendEnabled: false,
    });
    check('canSend is false when the operator disabled sending', client.canSend === false);

    const client2 = new OneBotClient({
      baseUrl: 'http://127.0.0.1:1',
      accessToken: undefined,
      timeoutMs: 1_000,
      maxRetries: 0,
      logger: log,
    });
    check('canSend defaults to true', client2.canSend === true);
  }

  process.stderr.write(`\n${failures} failure(s)\n`);
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stderr.write('ONEBOT ADAPTER VERIFICATION PASSED\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
