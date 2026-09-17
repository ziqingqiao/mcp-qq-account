#!/usr/bin/env node
/**
 * Inbox mechanism verification.
 *
 * These are the checks that would otherwise fail silently. A queue that stores
 * the same message twice, or that consumes on read, still *works* in a demo -
 * the damage only shows up as a model answering the same person twice, or as
 * messages vanishing before anyone saw them. Neither produces an error, so
 * neither gets caught by trying it once by hand.
 *
 * Runs entirely on a temporary directory. No network, no OneBot, no account.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '../core/logger.js';
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

const log = createLogger('error');

function message(overrides: Partial<Parameters<Inbox['enqueue']>[0]> = {}): Parameters<Inbox['enqueue']>[0] {
  return {
    at: new Date('2026-09-17T10:00:00.000Z'),
    kind: 'group',
    conversationId: '900001',
    senderId: '800001',
    senderName: '张三',
    text: '在吗',
    platformMessageId: 'msg-1',
    ...overrides,
  };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'qq-inbox-verify-'));

  try {
    const inbox = new Inbox({ dir, logger: log });

    // --- basics -------------------------------------------------------------
    process.stderr.write('basics\n');
    const first = await inbox.enqueue(message());
    check('a message is queued', typeof first === 'string');
    check('pending count is 1', (await inbox.stats()).pending === 1);

    // --- deduplication ------------------------------------------------------
    // The platform explicitly documents that the same event may be pushed more
    // than once. Storing it twice means the model reads it twice and may answer
    // twice, so this is the single most important property here.
    process.stderr.write('\ndeduplication\n');
    const duplicate = await inbox.enqueue(message());
    check('the same platform message id is not queued twice', duplicate === undefined);
    check('pending count is still 1', (await inbox.stats()).pending === 1);

    const laterArrival = await inbox.enqueue(
      message({ at: new Date('2026-09-17T10:05:00.000Z') }),
    );
    check(
      'a redelivery with a different arrival time is still deduplicated',
      laterArrival === undefined,
      'the file name must depend only on the message id',
    );

    const distinct = await inbox.enqueue(
      message({ platformMessageId: 'msg-2', text: '第二条', at: new Date('2026-09-17T10:00:02.000Z') }),
    );
    check('a different message id is queued', typeof distinct === 'string');

    const noId = await inbox.enqueue(
      message({ platformMessageId: undefined, text: '无 id', at: new Date('2026-09-17T10:00:03.000Z') }),
    );
    const noIdAgain = await inbox.enqueue(
      message({ platformMessageId: undefined, text: '无 id', at: new Date('2026-09-17T10:00:04.000Z') }),
    );
    check(
      'a message with no id is never deduplicated, and both copies are kept',
      typeof noId === 'string' && typeof noIdAgain === 'string',
      'dropping a distinct message is worse than an occasional duplicate',
    );

    // --- read does not consume ---------------------------------------------
    process.stderr.write('\nread semantics\n');
    const readOnce = await inbox.read(10);
    check('read returns the queued messages', readOnce.messages.length === 4, `got ${readOnce.messages.length}`);
    check('read reports the full pending total', readOnce.pendingTotal === 4);

    const readTwice = await inbox.read(10);
    check(
      'reading twice returns the same messages',
      readTwice.messages.length === 4,
      'read must not consume, or qq_read_messages could not honestly claim to be read-only',
    );

    check(
      'messages come back oldest first',
      readOnce.messages[0]?.text === '在吗' && readOnce.messages[1]?.text === '第二条',
      readOnce.messages.map((entry) => entry.text).join(' | '),
    );

    // Arrival order and send order can disagree: a reconnect replays a backlog,
    // or two people type at once. Ordering by arrival would scramble the
    // conversation, so the platform's own timestamp has to win.
    const orderingDir = await mkdtemp(join(tmpdir(), 'qq-inbox-order-'));
    try {
      const ordering = new Inbox({ dir: orderingDir, logger: log });
      await ordering.enqueue(
        message({ platformMessageId: 'later', text: '后发但先到', at: new Date('2026-09-17T10:00:10.000Z') }),
      );
      await ordering.enqueue(
        message({ platformMessageId: 'earlier', text: '先发但后到', at: new Date('2026-09-17T10:00:01.000Z') }),
      );
      const ordered = await ordering.read(10);
      check(
        'a message sent earlier sorts first even when it arrived later',
        ordered.messages[0]?.text === '先发但后到',
        ordered.messages.map((entry) => entry.text).join(' | '),
      );
    } finally {
      await rm(orderingDir, { recursive: true, force: true });
    }

    const limited = await inbox.read(2);
    check('the limit is honoured', limited.messages.length === 2);
    check('the limit does not hide the remaining count', limited.pendingTotal === 4);

    // --- ack ----------------------------------------------------------------
    process.stderr.write('\nacknowledgement\n');
    const ids = readOnce.messages.map((entry) => entry.id);
    const acked = await inbox.ack(ids.slice(0, 2));
    check('ack moves the named messages out of pending', acked.acknowledged.length === 2);
    check('pending drops to 2', (await inbox.stats()).pending === 2);
    check('the archive keeps them', (await inbox.stats()).read === 2);

    const afterAck = await inbox.read(10);
    check('acked messages are no longer returned', afterAck.messages.length === 2);

    const unknown = await inbox.ack(['does-not-exist.json']);
    check('an unknown id is reported rather than thrown', unknown.unknown.length === 1);
    const traversal = await inbox.ack(['../../etc/passwd', 'a/b.json', 'notjson']);
    check('path traversal and non-json names are refused', traversal.acknowledged.length === 0);

    // --- content handling ---------------------------------------------------
    process.stderr.write('\ncontent handling\n');
    const empty = await inbox.enqueue(message({ platformMessageId: 'msg-empty', text: '   ' }));
    check('whitespace-only text is not queued', empty === undefined);

    const long = await inbox.enqueue(
      message({ platformMessageId: 'msg-long', text: 'x'.repeat(5_000) }),
    );
    check('an oversized message is accepted', typeof long === 'string');
    const storedLong = (await inbox.read(50)).messages.find((entry) => entry.id === long);
    check('an oversized message is truncated on the way in', storedLong?.truncated === true);
    check('the stored text is capped', (storedLong?.text.length ?? 0) === 2_000, `got ${storedLong?.text.length}`);

    // --- malformed files ----------------------------------------------------
    process.stderr.write('\nmalformed input\n');
    await writeFile(join(inbox.pendingDir, 'broken.json'), '{"text": "half a fi', 'utf8');
    const withBroken = await inbox.read(50);
    check('a truncated file is skipped, not fatal', withBroken.malformed.includes('broken.json'));
    check('the rest of the queue is still readable', withBroken.messages.length >= 2);

    // --- bounding -----------------------------------------------------------
    process.stderr.write('\nbounding\n');
    const boundedDir = await mkdtemp(join(tmpdir(), 'qq-inbox-bounded-'));
    try {
      const bounded = new Inbox({ dir: boundedDir, logger: log, maxPending: 3 });
      for (let index = 0; index < 6; index += 1) {
        await bounded.enqueue(message({ platformMessageId: `bounded-${index}`, text: `第 ${index} 条` }));
      }
      const stats = await bounded.stats();
      check('the queue is trimmed to its bound', stats.pending === 3, `got ${stats.pending}`);
      const survivors = await bounded.read(10);
      check(
        'the newest messages are the ones kept',
        survivors.messages.some((entry) => entry.text === '第 5 条'),
        survivors.messages.map((entry) => entry.text).join(' | '),
      );
    } finally {
      await rm(boundedDir, { recursive: true, force: true });
    }

    process.stderr.write(`\n${failures} failure(s)\n`);
    if (failures > 0) {
      process.exitCode = 1;
      return;
    }
    process.stderr.write('INBOX VERIFICATION PASSED\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
