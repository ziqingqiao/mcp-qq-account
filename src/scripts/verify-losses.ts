#!/usr/bin/env node
/**
 * Delivery-loss reporting verification.
 *
 * This suite exists because of how the thing it tests fails. A message that
 * never reached the queue leaves no trace in the queue, so an empty inbox and a
 * quiet inbox are indistinguishable - and the report that claims to tell them
 * apart is the only instrument there is. If it is wrong in the direction of
 * "nothing was lost", it does not fail loudly; it certifies the loss as health.
 *
 * So the assertions are mostly about attribution: which failure belongs to
 * which message, and which failure belongs to no message at all. Over-attaching
 * a failure invents losses; under-attaching one hides them.
 *
 * The rest guard the wording. The upstream logs failures and nothing else, so
 * "no failure recorded" cannot be reported as "delivered" - and the case that
 * would tempt a tool into saying so is exactly the clean case, where the reader
 * most wants reassurance. There is an assertion for that sentence.
 *
 * All fixtures are synthetic. The log format is the upstream's; the ids and the
 * text are not anyone's.
 *
 * Runs on no network and no account.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLog, since } from '../providers/onebot/delivery-log.js';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    process.stderr.write(`  ok    ${label}\n`);
    return;
  }
  failures += 1;
  process.stderr.write(`  FAIL  ${label}${detail === undefined ? '' : ` - ${detail}`}\n`);
}

/** The upstream's own wording for a failed report. */
const FAILED = '[OneBot] [Http Client] 新消息事件HTTP上报返回快速操作失败';

const RECEIVED = (stamp: string, what: string): string => `${stamp} [info] tester | 接收 <- ${what}`;
const FAILURE = (stamp: string, why: string): string => `${stamp} [error] tester | ${FAILED} Error: ${why}`;

const CONN_REFUSED = 'connect ECONNREFUSED 127.0.0.1:8790';
const UNAUTHORISED = 'Unexpected status code: 401';

async function runScript(dir: string | undefined, extra: string[] = []): Promise<{ code: number; output: string }> {
  const script = fileURLToPath(new URL('./report-losses.js', import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['ONEBOT_LOG_DIR'];
  if (dir !== undefined) env['ONEBOT_LOG_DIR'] = dir;

  const child = spawn(process.execPath, [script, ...extra], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));

  const code = await new Promise<number>((resolve) => {
    child.once('close', (value) => resolve(value ?? -1));
  });
  return { code, output };
}

function attributionChecks(): void {
  process.stderr.write('\nattribution: which failure belongs to which message\n');

  const mixed = [
    // lost: the port had no listener
    RECEIVED('09-17 20:47:23', '私聊 (200000001) first'),
    FAILURE('09-17 20:47:23', CONN_REFUSED),
    // delivered: an unrelated line sits between it and the next message
    RECEIVED('09-17 20:48:00', '私聊 (200000001) second'),
    '09-17 20:48:01 [info] tester | some unrelated line',
    // lost: something was listening and refused it
    RECEIVED('09-17 20:49:00', '私聊 (200000001) third'),
    FAILURE('09-17 20:49:00', UNAUTHORISED),
    // delivered: no failure of any kind follows
    RECEIVED('09-17 20:50:00', '群聊 (300000001) group one'),
    // delivered: a content-free event still counts as received
    RECEIVED('09-17 20:51:00', '临时消息 (400000001)'),
  ].join('\n');

  const report = parseLog(mixed);
  check('every received message is counted', report.received.length === 5, `got ${report.received.length}`);
  check('only the two with failures are called lost', report.lostCount === 2, `got ${report.lostCount}`);
  check(
    'the remainder is counted as "no failure", never as "delivered"',
    report.noFailureCount === 3,
    `got ${report.noFailureCount}`,
  );
  check(
    'ECONNREFUSED is named as nothing listening',
    report.received[0]?.failure?.summary === 'nothing was listening on the report port',
    report.received[0]?.failure?.summary,
  );
  check(
    'a 401 is named as a credential mismatch, not as nothing listening',
    report.received[2]?.failure?.summary === 'the receiver refused the report (credential mismatch)',
    report.received[2]?.failure?.summary,
  );
  check(
    'the original upstream text is kept alongside the guess',
    report.received[0]?.failure?.detail === CONN_REFUSED,
    report.received[0]?.failure?.detail,
  );

  process.stderr.write('\nattribution: what must NOT be blamed on a message\n');

  const stray = [
    RECEIVED('09-17 21:00:00', '私聊 (200000001) only message'),
    // a failure from another subsystem: it names no HTTP report
    '09-17 21:00:00 [error] tester | [Some Other Adapter] could not do a thing Error: nope',
    RECEIVED('09-17 21:01:00', '私聊 (200000001) later message'),
    '09-17 21:01:01 [info] tester | filler',
    '09-17 21:01:02 [info] tester | filler',
    // a report failure that lands well after the last message: it cannot be
    // attributed to it, and guessing would invent a loss
    FAILURE('09-17 21:05:00', CONN_REFUSED),
  ].join('\n');

  const strayReport = parseLog(stray);
  check(
    'an error that names no HTTP report is not a delivery loss',
    strayReport.lostCount === 0,
    `got ${strayReport.lostCount}`,
  );

  const farApart = [
    RECEIVED('09-17 22:00:00', '私聊 (200000001) first'),
    RECEIVED('09-17 22:00:01', '私聊 (200000001) second'),
    FAILURE('09-17 22:00:01', CONN_REFUSED),
  ].join('\n');
  const farReport = parseLog(farApart);
  check(
    'a failure after a later message is blamed on that later message, not the earlier one',
    farReport.received[0]?.failure === null && farReport.received[1]?.failure !== null,
    `first=${String(farReport.received[0]?.failure)} second=${String(farReport.received[1]?.failure)}`,
  );

  const twice = [
    RECEIVED('09-17 22:10:00', '私聊 (200000001) once'),
    FAILURE('09-17 22:10:00', CONN_REFUSED),
    FAILURE('09-17 22:10:00', UNAUTHORISED),
  ].join('\n');
  const twiceReport = parseLog(twice);
  check(
    'a message is only lost once, and keeps the first explanation',
    twiceReport.lostCount === 1 && twiceReport.received[0]?.failure?.detail === CONN_REFUSED,
    `lost=${twiceReport.lostCount} detail=${twiceReport.received[0]?.failure?.detail}`,
  );
}

function parsingChecks(): void {
  process.stderr.write('\nparsing: the shapes the real logs actually have\n');

  const noisy = [
    `\u001b[32m${RECEIVED('09-17 23:00:00', '私聊 (200000001) coloured')}\u001b[0m`,
    `\u001b[31m${FAILURE('09-17 23:00:00', CONN_REFUSED)}\u001b[0m`,
  ].join('\n');
  const noisyReport = parseLog(noisy);
  check(
    'colour codes do not hide a message or its failure',
    noisyReport.received.length === 1 && noisyReport.lostCount === 1,
    `received=${noisyReport.received.length} lost=${noisyReport.lostCount}`,
  );

  const kinds = parseLog(
    [
      RECEIVED('09-17 23:10:00', '私聊 (200000001) a'),
      RECEIVED('09-17 23:10:01', '群聊 (300000001) b'),
      RECEIVED('09-17 23:10:02', '临时消息 (400000001)'),
      RECEIVED('09-17 23:10:03', '不认识的东西 (500000001) c'),
    ].join('\n'),
  );
  check('a private message is typed as private', kinds.received[0]?.kind === 'private', kinds.received[0]?.kind);
  check('a group message is typed as group', kinds.received[1]?.kind === 'group', kinds.received[1]?.kind);
  check('a temp message is typed as temp', kinds.received[2]?.kind === 'temp', kinds.received[2]?.kind);
  check(
    'an unrecognised kind keeps the upstream word rather than being dropped',
    kinds.received[3]?.kind === '不认识的东西',
    kinds.received[3]?.kind,
  );
  check(
    'a content-free event has no text but keeps its peer',
    kinds.received[2]?.preview === '' && kinds.received[2]?.peerId === '400000001',
    `preview="${kinds.received[2]?.preview ?? ''}" peer=${String(kinds.received[2]?.peerId)}`,
  );
  check(
    'a message with no id in the log keeps a null peer',
    parseLog(RECEIVED('09-17 23:20:00', '私聊 no id here')).received[0]?.peerId === null,
  );

  process.stderr.write('\nwindowing\n');

  const wide = parseLog(
    [
      RECEIVED('09-17 23:30:00', '私聊 (200000001) before'),
      FAILURE('09-17 23:30:00', CONN_REFUSED),
      RECEIVED('09-17 23:40:00', '私聊 (200000001) after'),
    ].join('\n'),
  );
  const narrowed = since(wide, '09-17 23:35:00');
  check(
    'a window drops earlier messages from the counts',
    narrowed.received.length === 1 && narrowed.lostCount === 0 && narrowed.noFailureCount === 1,
    `received=${narrowed.received.length} lost=${narrowed.lostCount}`,
  );
}

async function commandChecks(): Promise<void> {
  process.stderr.write('\nthe command itself\n');

  const root = await mkdtemp(join(tmpdir(), 'mcp-qq-losses-'));

  const noEnv = await runScript(undefined);
  check(
    'with no log directory configured it fails and says so',
    noEnv.code === 1 && noEnv.output.includes('ONEBOT_LOG_DIR is not set'),
    `code=${noEnv.code}`,
  );

  const emptyDir = join(root, 'empty');
  await mkdir(emptyDir, { recursive: true });
  const noLog = await runScript(emptyDir);
  check(
    'with an empty directory it fails rather than reporting zero losses',
    noLog.code === 1 && noLog.output.includes('no .log file'),
    `code=${noLog.code}`,
  );

  // Two files: the newer one must win, or a stale session would be reported.
  await writeFile(join(root, 'old.log'), RECEIVED('09-17 01:00:00', '私聊 (200000001) stale'), 'utf8');
  const current = join(root, 'current.log');
  await writeFile(
    current,
    [RECEIVED('09-17 23:50:00', '私聊 (200000001) current'), FAILURE('09-17 23:50:00', UNAUTHORISED)].join('\n'),
    'utf8',
  );

  const withLoss = await runScript(root);
  check('it reads the newest log, not an older one', withLoss.output.includes('current.log'), 'did not name current.log');
  check('it counts the message as received', withLoss.output.includes('received        : 1'));
  check('it counts the message as lost', withLoss.output.includes('lost            : 1'));
  check(
    'it reports the remainder as "no failure" rather than as delivered',
    withLoss.output.includes('no failure      : 0') && !withLoss.output.includes('delivered'),
    'the report used the word delivered',
  );
  check(
    'it tells the reader the messages are still in QQ history',
    withLoss.output.includes('qq_get_conversation_history'),
  );
  check('by default a loss is still a successful run', withLoss.code === 0, `code=${withLoss.code}`);

  const strict = await runScript(root, ['--fail-on-loss']);
  check('--fail-on-loss turns a loss into a non-zero exit', strict.code === 1, `code=${strict.code}`);

  const windowed = await runScript(root, ['--since', '09-18 00:00:00']);
  check(
    '--since narrows the window rather than silently reporting the whole file',
    windowed.output.includes('from 09-18 00:00:00') && windowed.output.includes('received        : 0'),
    'window not applied',
  );

  await writeFile(current, RECEIVED('09-17 23:55:00', '私聊 (200000001) clean'), 'utf8');
  const clean = await runScript(root);
  check(
    'a clean log reports zero losses',
    clean.output.includes('lost            : 0') && clean.code === 0,
    `code=${clean.code}`,
  );
  check(
    'a clean log says so without claiming everything arrived',
    clean.output.includes('nothing was provably lost') && clean.output.includes('never tried to report'),
    'the zero-loss wording overstates what this log can prove',
  );

  await rm(root, { recursive: true, force: true });
}

async function main(): Promise<void> {
  attributionChecks();
  parsingChecks();
  await commandChecks();

  process.stderr.write(`\n${failures} failure(s)\n`);
  if (failures > 0) {
    process.stderr.write('DELIVERY LOSS VERIFICATION FAILED\n');
    process.exit(1);
  }
  process.stderr.write('DELIVERY LOSS VERIFICATION PASSED\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
