/**
 * Reading the upstream's own record of what it failed to deliver.
 *
 * OneBot does not buffer and does not retry a failed report: it logs the
 * failure and moves on, and the message never reaches the queue. That makes the
 * implementation's log the only complete record of what arrived - and the error
 * line it writes next to a received message the only definitive record of what
 * was lost.
 *
 * So this module answers one question: of everything the upstream saw, how much
 * of it did the upstream itself record as undeliverable? It parses; it does not
 * fetch. The caller decides where the log lives, because that path is a property
 * of the deployment, not of this package.
 *
 * The answer is one-sided, and the asymmetry is the whole point. A recorded
 * failure is proof of loss. The absence of one is *not* proof of delivery:
 * these implementations log failures and nothing else, so a message that was
 * reported successfully is indistinguishable in the log from a message the
 * upstream never tried to report at all. Callers must not present the remainder
 * as "delivered" - an empty inbox already teaches that lesson the hard way.
 *
 * The parse is deliberately lenient about surrounding noise (colour codes, the
 * account nickname prefix, unrelated log lines) and strict about the one thing
 * that matters: a failure is only attributed to a message when the upstream
 * itself wrote both lines, adjacent, about the same event.
 */

/** Colour codes are common in these logs and would break every anchored match. */
const ANSI = /\u001b\[[0-9;]*m/g;

/** `09-17 20:47:23 [info] tester | 接收 <- 私聊 (200000001) 你好` */
const LOG_LINE = /^(\d\d-\d\d \d\d:\d\d:\d\d)\s+\[(\w+)\]\s+(.*)$/;

/** What the upstream calls each kind of conversation. */
const KINDS: Record<string, string> = {
  私聊: 'private',
  群聊: 'group',
  临时消息: 'temp',
  群临时消息: 'group-temp',
};

export interface FailureReason {
  /**
   * A phrase naming the likely cause. The raw text is kept alongside it because
   * the guess can be wrong and the original cannot.
   */
  summary: string;
  detail: string;
}

export interface ReceivedEvent {
  /** The upstream's own timestamp, kept verbatim - it is what a human greps for. */
  stamp: string;
  /** 'private' | 'group' | 'temp' | the upstream's own word if unrecognised. */
  kind: string;
  peerId: string | null;
  /** The message text as the upstream logged it. Empty for content-free events. */
  preview: string;
  /** null when the upstream recorded no failure for this message. */
  failure: FailureReason | null;
}

export interface LossReport {
  received: ReceivedEvent[];
  /**
   * Messages the upstream recorded no failure for.
   *
   * Deliberately not called "delivered". These implementations log failures and
   * nothing else, so a message that was reported successfully and a message the
   * upstream never attempted to report look identical here. Only `lostCount` is
   * a fact; this is the remainder.
   */
  noFailureCount: number;
  lostCount: number;
}

/**
 * Name the cause, but never hide the original text.
 *
 * The two failures seen in practice are `ECONNREFUSED` (nothing listening on
 * the report port, which is what a host restart looks like from outside) and
 * `401` (something *was* listening and refused the report). They call for
 * opposite investigations, so they get separate sentences rather than a shared
 * "report failed".
 */
function classify(detail: string): string {
  if (detail.includes('ECONNREFUSED')) {
    return 'nothing was listening on the report port';
  }
  if (detail.includes('ECONNRESET') || detail.includes('socket hang up')) {
    return 'the connection dropped before the report was accepted';
  }
  if (detail.includes('ETIMEDOUT') || detail.includes('timeout')) {
    return 'the report timed out';
  }

  const status = /status code:\s*(\d{3})/.exec(detail);
  const code = status?.[1];
  if (code === '401') return 'the receiver refused the report (credential mismatch)';
  if (code === '413') return 'the report was larger than the receiver accepts';
  if (code !== undefined) return `the receiver answered HTTP ${code}`;

  return 'the report failed';
}

function parseReceived(rest: string): Omit<ReceivedEvent, 'stamp' | 'failure'> | null {
  const marker = rest.indexOf('接收 <-');
  if (marker < 0) return null;

  const tail = rest.slice(marker + '接收 <-'.length).trim();
  // `私聊 (200000001) 你好` / `临时消息 (400000001)` / an id we do not recognise
  const shape = /^(\S+)\s*(?:\((\d+)\))?\s*(.*)$/.exec(tail);
  if (shape === null) return null;

  const word = shape[1] ?? '';
  const peerId = shape[2] ?? null;
  const preview = (shape[3] ?? '').trim();

  return { kind: KINDS[word] ?? word, peerId, preview };
}

/**
 * How far after a received line a failure may appear and still belong to it.
 *
 * The upstream writes the error on the very next line, so one line of slack
 * covers a stray line between them without letting an unrelated failure - say,
 * from a different subsystem seconds later - be blamed on this message.
 */
const ATTRIBUTION_WINDOW = 2;

export function parseLog(text: string): LossReport {
  const lines = text.replace(ANSI, '').split(/\r?\n/);
  const received: ReceivedEvent[] = [];
  /** Line number of the most recent received event, or -1 when there is none. */
  let lastReceivedLine = -1;

  lines.forEach((line, index) => {
    const match = LOG_LINE.exec(line);
    if (match === null) return;

    const stamp = match[1];
    const level = match[2];
    const rest = match[3];
    if (stamp === undefined || level === undefined || rest === undefined) return;

    const event = parseReceived(rest);
    if (event !== null) {
      received.push({ stamp, ...event, failure: null });
      lastReceivedLine = index;
      return;
    }

    if (level !== 'error' || !rest.includes('HTTP上报')) return;

    const gap = index - lastReceivedLine;
    if (gap < 1 || gap > ATTRIBUTION_WINDOW) return;

    const last = received[received.length - 1];
    // A message can only be lost once, and only the first failure explains it.
    if (last === undefined || last.failure !== null) return;

    const at = rest.indexOf('Error:');
    const detail = (at < 0 ? rest : rest.slice(at + 'Error:'.length)).trim();
    last.failure = { summary: classify(detail), detail };
  });

  const lostCount = received.filter((event) => event.failure !== null).length;
  return { received, noFailureCount: received.length - lostCount, lostCount };
}

/** Everything the upstream received at or after `since`, in log order. */
export function since(report: LossReport, since: string): LossReport {
  const received = report.received.filter((event) => event.stamp >= since);
  const lostCount = received.filter((event) => event.failure !== null).length;
  return { received, noFailureCount: received.length - lostCount, lostCount };
}
