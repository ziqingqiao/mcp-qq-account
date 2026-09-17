#!/usr/bin/env node
/**
 * Did any message fail to reach the queue?
 *
 * This is the question that started this project's whole inbound path, and it
 * is not answerable from the queue: a message that was never delivered leaves
 * no trace there at all, so an empty inbox looks exactly like a quiet one.
 * The only place the loss is recorded is the upstream implementation's log.
 *
 * The report is one-sided on purpose. A recorded failure is proof of loss; the
 * absence of one is not proof of delivery, because these implementations log
 * failures and nothing else. The output says so rather than implying a clean
 * bill of health - a report that overstates its own coverage is worse than no
 * report, since it is the only instrument for this question.
 *
 *   npm run losses
 *   npm run losses -- --since "09-17 22:25"
 *   npm run losses -- --fail-on-loss     # exit 1 when anything was lost
 *
 * Point ONEBOT_LOG_DIR at the directory your implementation writes its text log
 * to. The newest `.log` in there is used, because these implementations rotate
 * per session and the interesting one is always the current session.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { loadConfig } from '../config.js';
import { parseLog, since as atOrAfter, type LossReport } from '../providers/onebot/delivery-log.js';

function out(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Newest `.log` in a directory, or null when there is nothing to read. */
async function newestLog(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  const candidates = names.filter((name) => name.toLowerCase().endsWith('.log'));
  const stamped = await Promise.all(
    candidates.map(async (name) => {
      const path = join(dir, name);
      try {
        const info = await stat(path);
        return { path, mtime: info.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  let newest: { path: string; mtime: number } | null = null;
  for (const entry of stamped) {
    if (entry === null) continue;
    if (newest === null || entry.mtime > newest.mtime) newest = entry;
  }
  return newest === null ? null : newest.path;
}

function readFlag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function quote(text: string): string {
  return text === '' ? '(no text)' : `"${text}"`;
}

function printLosses(report: LossReport): void {
  const lost = report.received.filter((event) => event.failure !== null);
  if (lost.length === 0) return;

  out('');
  out('lost messages (the upstream recorded a failed report for each):');
  for (const event of lost) {
    const peer = event.peerId === null ? '' : ` (${event.peerId})`;
    out(`  ${event.stamp}  ${event.kind}${peer}  ${quote(event.preview)}`);
    out(`                ${event.failure?.summary ?? ''}`);
    out(`                ${event.failure?.detail ?? ''}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const dir = process.env['ONEBOT_LOG_DIR'];

  out(`Queue directory : ${config.inbox.dir}`);
  out(`Log directory   : ${dir ?? '(ONEBOT_LOG_DIR is not set)'}`);

  if (dir === undefined || dir.trim() === '') {
    out('');
    out('FAIL  ONEBOT_LOG_DIR is not set, so there is no log to read.');
    out('      Set it to the directory your OneBot implementation writes its text log to,');
    out('      for example `ONEBOT_LOG_DIR=E:\\qqapp\\NapCat.Shell\\logs`.');
    out('      Without it this question cannot be answered at all: the queue records what');
    out('      arrived, and a lost message is defined by its absence from the queue.');
    process.exitCode = 1;
    return;
  }

  const path = await newestLog(dir);
  if (path === null) {
    out('');
    out(`FAIL  no .log file in ${dir}.`);
    out('      Either the path is wrong, or the implementation is not logging to a file.');
    process.exitCode = 1;
    return;
  }

  const report = parseLog(await readFile(path, 'utf8'));
  const since = readFlag('--since');
  const window = since === undefined ? report : atOrAfter(report, since);

  out(`Log file        : ${path}`);
  out(`Window          : ${since === undefined ? 'the whole file' : `from ${since}`}`);
  out('');
  out(`received        : ${window.received.length}`);
  out(`lost            : ${window.lostCount}`);
  out(`no failure      : ${window.noFailureCount}`);

  printLosses(window);

  if (window.received.length === 0) {
    out('');
    out('No inbound messages in this window, so this says nothing either way.');
    return;
  }

  out('');
  if (window.lostCount === 0) {
    out('The upstream recorded no failed reports in this window.');
    out('');
    out('That is weaker than it sounds. These implementations log failures and nothing');
    out('else, so a message the upstream reported successfully looks exactly like one it');
    out('never tried to report. Zero failures means nothing was provably lost - not that');
    out('everything arrived. To close that gap, compare against the queue itself.');
    return;
  }

  out(`${window.lostCount} of ${window.received.length} message(s) never reached the queue.`);
  out('OneBot does not buffer or retry, so they are not recoverable from here - but they');
  out('are still in QQ\'s own history. Read them back with qq_get_conversation_history.');

  if (process.argv.includes('--fail-on-loss')) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
