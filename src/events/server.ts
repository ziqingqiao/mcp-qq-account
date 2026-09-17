/**
 * Inbound event receiver.
 *
 * WHY A SECOND HTTP LISTENER EXISTS
 *
 * MCP cannot be pushed to. If the account is to be *read* by an agent, the
 * messages have to arrive somewhere the agent can later collect them from, and
 * the only direction OneBot offers is an HTTP report. So this server opens one
 * small listener, whose entire job is: authenticate, parse, queue, answer 204.
 *
 * It is not the MCP endpoint and shares no port with it. Point the OneBot
 * implementation's "HTTP report" setting at this path.
 *
 * WHY BINDING IS ALLOWED TO FAIL
 *
 * Hosts spawn one MCP server process each, so Claude Desktop, Cursor and
 * WorkBuddy may each start a copy. Only one can hold the port. A failure here
 * is therefore logged and tolerated rather than fatal: the queue is a shared
 * directory, so a copy that could not bind still reads everything the bound one
 * receives. Refusing to boot would turn a normal multi-host setup into a
 * broken one.
 *
 * THE SECURITY POSTURE
 *
 * Anything that can POST here can put text into the model's context, which is
 * why an off-loopback bind requires a token at config time. Whichever scheme the
 * caller uses, the comparison is constant-time and a rejection never echoes the
 * expected value.
 *
 * TWO SCHEMES, AND THE ONE THAT MATTERS IS THE ONE THAT IS EASY TO MISS
 *
 * `Authorization: Bearer <token>` is what a person or an agent reaches for, so
 * it is what gets implemented first - and a receiver with only that rejects
 * every real report, because OneBot's HTTP POST clients never send the token at
 * all. They send `x-signature: sha1=<HMAC-SHA1 of the body, keyed by the token>`
 * instead. See `signatureMatches`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AppConfig } from '../config.js';
import type { Logger } from '../core/logger.js';
import type { Inbox, ConversationKind } from '../inbox/store.js';

export interface EventServerHandle {
  readonly listener: Server | undefined;
  readonly url: string | undefined;
  close(): Promise<void>;
}

/** Cap on a report body. Real events are a few kilobytes; this is a backstop. */
const MAX_BODY_BYTES = 1_048_576;

/** Past this, the body is not worth draining and the socket is dropped. */
const HARD_BODY_LIMIT = 8_388_608;

function constantTimeEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on length mismatch, so compare lengths first and
  // still run a comparison when they differ.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * A short, non-reversible fingerprint of a token.
 *
 * A 401 has exactly one interesting explanation - the sender presented a token
 * we did not expect - and the obvious way to check that is to look at both
 * values. That would put a live credential in a log file, which is worse than
 * the outage. A truncated hash answers the only question that matters (same or
 * different?) without being usable as the credential itself.
 */
function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Verify the signature OneBot's HTTP POST clients send instead of a token.
 *
 * This is the only scheme a real report ever uses, and it took a day to notice
 * because it fails in the least informative way possible: 401. NapCat (and
 * go-cqhttp before it) never puts the token on the wire. It signs the body:
 *
 *     x-signature: sha1=<hex HMAC-SHA1, keyed by the token, over the raw body>
 *
 * A receiver that only understands `Authorization: Bearer` rejects every single
 * report - deterministically, with the exact status code that means "your token
 * is wrong" - while the token is in fact correct. Bearer was accepted here and
 * the OneBot scheme was not, which is precisely backwards.
 *
 * The body must be the raw bytes as sent; re-serialising the parsed JSON would
 * change the bytes and the digest with them.
 */
function signatureMatches(header: string, token: string, body: string): boolean {
  const prefix = 'sha1=';
  if (!header.toLowerCase().startsWith(prefix)) return false;
  const presented = header.slice(prefix.length).trim().toLowerCase();
  const expected = createHmac('sha1', token).update(body, 'utf8').digest('hex');
  return constantTimeEquals(presented, expected);
}

/** How the caller tried to authenticate, named without echoing the value. */
function authScheme(req: IncomingMessage): 'bearer' | 'signature' | 'other' | 'absent' {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    return header.toLowerCase().startsWith('bearer ') ? 'bearer' : 'other';
  }
  return typeof req.headers['x-signature'] === 'string' ? 'signature' : 'absent';
}

/**
 * Does this request prove it is allowed to write into the queue?
 *
 * Two schemes, because the two ends of the world disagree about which is
 * normal: agents and curl present the token, OneBot signs the body. Both are
 * compared in constant time against the same secret.
 */
function isAuthorised(req: IncomingMessage, url: URL, token: string, body: string): boolean {
  const presented = presentedToken(req, url);
  if (presented !== undefined) return constantTimeEquals(presented, token);

  const signature = req.headers['x-signature'];
  if (typeof signature === 'string') return signatureMatches(signature, token, body);

  return false;
}

/**
 * Append one line per rejection to a file next to the queue.
 *
 * The logger is not enough on its own. Which stream a host captures, and
 * whether it captures one at all, varies - this process has run for hours
 * without a single line reaching the host's log - so a rejection that is only
 * logged can be invisible exactly when it matters. The queue directory is
 * already the one place both sides agree on, so the record goes there.
 *
 * Never fatal: failing to write a diagnostic must not turn a 401 into a 500.
 */
function recordRejection(config: AppConfig, entry: Record<string, unknown>): void {
  const line = `${JSON.stringify(entry)}\n`;
  void appendFile(join(config.inbox.dir, 'rejections.log'), line, 'utf8').catch(() => undefined);
}

function presentedToken(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice('bearer '.length).trim();
  }
  const query = url.searchParams.get('access_token');
  return query === null || query === '' ? undefined : query;
}

/**
 * Read a report body, refusing oversized ones.
 *
 * An oversized body is DRAINED rather than aborted, up to a hard ceiling. That
 * detail matters: destroying the request the moment it goes over the limit
 * resets the connection, so the sender sees "connection reset" instead of the
 * 413 that explains the problem. Real reports are a few kilobytes, so draining
 * costs nothing; the hard ceiling exists so a deliberately enormous upload
 * cannot tie up the listener indefinitely.
 */
function readBody(req: IncomingMessage): Promise<{ ok: boolean; body: string }> {
  return new Promise((resolve) => {
    let size = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (size > HARD_BODY_LIMIT) {
        req.destroy();
        resolve({ ok: false, body: '' });
        return;
      }
      if (size > MAX_BODY_BYTES) {
        // Stop accumulating but keep reading, so the response can still be sent.
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (overflowed) {
        resolve({ ok: false, body: '' });
        return;
      }
      resolve({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => resolve({ ok: false, body: '' }));
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Flatten a OneBot message payload into plain text. */
function extractText(message: unknown, raw: unknown): string {
  const rawText = readString(raw);
  if (rawText !== undefined) return rawText;

  if (typeof message === 'string') return message.trim();
  if (!Array.isArray(message)) return '';

  return message
    .flatMap((segment) => {
      const record = asRecord(segment);
      if (record.type !== 'text') return [];
      const data = asRecord(record.data);
      const text = readString(data.text);
      return text === undefined ? [] : [text];
    })
    .join('')
    .trim();
}

export async function startEventServer(config: AppConfig, logger: Logger, inbox: Inbox): Promise<EventServerHandle> {
  const { enabled, host, port, path, token } = config.events;

  if (!enabled) {
    logger.info('inbound event receiver disabled; qq_read_messages will only see what is already queued');
    return { listener: undefined, url: undefined, close: async () => undefined };
  }

  const listener = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      logger.error('event receiver failed', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      respond(res, 500, 'internal error');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname !== path) {
      respond(res, 404, 'not found');
      return;
    }
    if (req.method !== 'POST') {
      respond(res, 405, 'method not allowed');
      return;
    }

    // The body is read before the credential is checked, because one of the two
    // accepted schemes signs the body instead of sending a secret. It is still
    // not PARSED until the check passes: the size cap is what keeps an
    // unauthenticated caller from making us buffer more than a report's worth.
    const read = await readBody(req);
    if (!read.ok) {
      respond(res, 413, 'payload too large');
      return;
    }

    if (token !== undefined && !isAuthorised(req, url, token, read.body)) {
      const presented = presentedToken(req, url);
      const signature = req.headers['x-signature'];
      // Recorded before responding: a rejection is the one event that is
      // otherwise invisible from the outside, and the sender only ever sees
      // "401", which says nothing about why.
      recordRejection(config, {
        ts: new Date().toISOString(),
        event: 'rejected',
        remote: req.socket.remoteAddress ?? 'unknown',
        method: req.method,
        path: url.pathname,
        scheme: authScheme(req),
        presentedLength: presented === undefined ? null : presented.length,
        presentedFingerprint: presented === undefined ? null : fingerprint(presented),
        // A signature that does not match can mean a wrong token OR a body that
        // was altered in transit, so both halves of the input get recorded.
        signatureLength: typeof signature === 'string' ? signature.length : null,
        signatureFingerprint: typeof signature === 'string' ? fingerprint(signature) : null,
        bodyBytes: Buffer.byteLength(read.body, 'utf8'),
        expectedLength: token.length,
        expectedFingerprint: fingerprint(token),
      });
      logger.warn('event report rejected: bad or missing token', { remote: req.socket.remoteAddress ?? 'unknown' });
      respond(res, 401, 'unauthorized');
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = asRecord(JSON.parse(read.body));
    } catch {
      respond(res, 400, 'invalid json');
      return;
    }

    // Everything that parses is answered 204, including events we deliberately
    // ignore. Reporting an error for a heartbeat would make the implementation
    // retry it forever.
    await queueIfRelevant(payload, inbox, logger);
    respond(res, 204, undefined);
  }

  const bound = await new Promise<boolean>((resolve) => {
    listener.once('error', (error: NodeJS.ErrnoException) => {
      logger.warn(
        'inbound event receiver could not bind; this process will read the shared queue but not receive new events',
        { host, port, code: error.code },
      );
      resolve(false);
    });
    listener.listen(port, host, () => {
      resolve(true);
    });
  });

  if (!bound) {
    return { listener: undefined, url: undefined, close: async () => undefined };
  }

  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}${path}`;
  logger.info('inbound event receiver listening', {
    url,
    authenticated: token !== undefined,
  });
  if (token === undefined) {
    logger.warn(
      'the event receiver has no token because QQ_EVENT_TOKEN is unset. ' +
        'On loopback that is acceptable for local development; do not expose this port.',
      { host, port },
    );
  }

  return {
    listener,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        listener.close(() => resolve());
      }),
  };
}

/**
 * Turn one OneBot event into a queued message, or decide it is not one.
 *
 * Returns 'queued', 'duplicate' or 'ignored' purely for logging clarity - the
 * HTTP response is the same either way.
 */
async function queueIfRelevant(
  payload: Record<string, unknown>,
  inbox: Inbox,
  logger: Logger,
): Promise<'queued' | 'duplicate' | 'ignored'> {
  const postType = readString(payload.post_type);

  // Heartbeats, notices and requests are not messages. Dropping them here keeps
  // the queue free of noise the model would otherwise have to wade through.
  if (postType !== 'message') return 'ignored';

  const selfId = readId(payload.self_id);
  const senderId = readId(payload.user_id);

  // The account's own messages come back through the same report in some
  // implementations. Queuing them would let the agent read its own replies as
  // if a person had sent them, and then answer them.
  if (selfId !== undefined && senderId !== undefined && selfId === senderId) {
    logger.debug('dropping own message echoed back by the report', { selfId });
    return 'ignored';
  }

  const messageType = readString(payload.message_type);
  const isGroup = messageType === 'group';
  const conversationId = isGroup ? readId(payload.group_id) : senderId;
  if (conversationId === undefined || senderId === undefined) return 'ignored';

  const text = extractText(payload.message, payload.raw_message);
  if (text === '') return 'ignored';

  const sender = asRecord(payload.sender);
  const kind: ConversationKind = isGroup ? 'group' : 'user';

  const name = await inbox.enqueue({
    at: readEventTime(payload.time),
    kind,
    conversationId,
    // Group and friend *names* are not in the event, and looking them up per
    // message would mean an upstream call for every line of chat. Left absent
    // on purpose: qq_list_conversations resolves names when they are needed.
    senderId,
    senderName: readString(sender.card) ?? readString(sender.nickname) ?? senderId,
    text,
    ...(readId(payload.message_id) !== undefined ? { platformMessageId: readId(payload.message_id) as string } : {}),
  });

  if (name === undefined) return 'duplicate';
  logger.info('inbound message queued', {
    kind,
    conversationId,
    chars: text.length,
  });
  return 'queued';
}

/** OneBot reports seconds; fall back to now when it is missing or absurd. */
function readEventTime(value: unknown): Date {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1_000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

function respond(res: ServerResponse, status: number, body: string | undefined): void {
  if (res.headersSent) return;
  try {
    if (body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  } catch {
    // The socket may already be gone (a destroyed oversized request). There is
    // nothing useful to do about it, and it must not take down the listener.
  }
}
