/**
 * Inbox: where messages the account received wait to be read by the agent.
 *
 * WHY THIS EXISTS AT ALL
 *
 * MCP is request/response. The host calls a tool, the tool answers. There is no
 * channel for the server to push "someone just messaged you" into the model -
 * so inbound messages need somewhere to sit until a tool call comes looking.
 * That somewhere is this directory, and `qq_read_messages` is the call that
 * looks.
 *
 * ONE FILE PER MESSAGE, NOT AN APPENDED LOG
 *
 * Same reasoning as the outbox in the sibling project: an appended log needs
 * the writer and the reader to agree on which lines are new, and that agreement
 * breaks in exactly the situation this has to survive - a restart mid-file. One
 * file per message removes the question, and makes `ack` a `rename`, which is
 * atomic.
 *
 * DEDUPLICATION IS THE FILENAME
 *
 * The platform may deliver the same event more than once. The file name is
 * derived from the platform's message id, and the write uses the `wx` flag, so
 * a redelivery collides with the existing file and is dropped by the
 * filesystem rather than by a bookkeeping set that a restart would forget.
 *
 * WHAT IS STORED, AND WHY IT IS NOT NEUTRAL
 *
 * The full text of what other people sent. That is a deliberate, consequential
 * choice: it means a group's conversation is written to this machine's disk. It
 * is also the only way an agent can read it, so the trade is accepted - but it
 * is why `text` is truncated on the way in, why the queue is bounded, and why
 * the tools that surface it say loudly that the content is DATA, never
 * instructions. Anything that can POST to the event endpoint can put words into
 * the model's context; treating those words as commands is how that becomes an
 * attack.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '../core/logger.js';
import { QQ_LIMITS } from '../server-constants.js';

export type ConversationKind = 'user' | 'group';

export interface InboxMessage {
  /** File name it was read from; pass this back to `ack`. */
  id: string;
  /**
   * When the platform says the message was sent, ISO.
   *
   * Ordering uses this rather than the arrival time. A batch of events can
   * arrive out of order - two people typing at once, a reconnect replaying a
   * backlog - and the conversation only reads correctly in the order the
   * messages were actually sent. Falls back to the arrival time when the
   * platform supplied no usable time.
   */
  at: string;
  /** When this server received it, ISO. */
  receivedAt: string;
  kind: ConversationKind;
  conversationId: string;
  conversationName?: string;
  senderId: string;
  senderName: string;
  text: string;
  /** The platform's own message id, kept for traceability. */
  platformMessageId?: string;
  /** True when the text was cut down on the way in. */
  truncated: boolean;
}

export interface InboxOptions {
  readonly dir: string;
  readonly logger: Logger;
  /** Above this many unread files, the oldest are dropped. */
  readonly maxPending?: number;
  /** Above this many read files, the oldest are dropped. */
  readonly maxRead?: number;
}

const DEFAULT_MAX_PENDING = 500;
const DEFAULT_MAX_READ = 1_000;

export class Inbox {
  readonly pendingDir: string;
  readonly readDir: string;

  private readonly logger: Logger;
  private readonly maxPending: number;
  private readonly maxRead: number;
  private ready: Promise<void> | undefined;

  constructor(options: InboxOptions) {
    this.pendingDir = join(options.dir, 'pending');
    this.readDir = join(options.dir, 'read');
    this.logger = options.logger;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.maxRead = options.maxRead ?? DEFAULT_MAX_READ;
  }

  private async ensure(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.pendingDir, { recursive: true });
      await mkdir(this.readDir, { recursive: true });
    })();
    return this.ready;
  }

  /**
   * Queue one received message.
   *
   * Returns the file name, or undefined when the message was a duplicate or
   * carried nothing to read. Never throws for those cases: an event that cannot
   * be stored is not a reason to fail the HTTP response, because the platform
   * would simply redeliver it.
   */
  async enqueue(input: {
    at: Date;
    kind: ConversationKind;
    conversationId: string;
    conversationName?: string;
    senderId: string;
    senderName: string;
    text: string;
    platformMessageId?: string;
  }): Promise<string | undefined> {
    await this.ensure();

    const text = input.text.trim();
    if (text === '') return undefined;

    const clipped = text.length > QQ_LIMITS.maxStoredTextChars;
    const stored = clipped ? text.slice(0, QQ_LIMITS.maxStoredTextChars) : text;

    const message: Omit<InboxMessage, 'id'> = {
      at: input.at.toISOString(),
      receivedAt: new Date().toISOString(),
      kind: input.kind,
      conversationId: input.conversationId,
      ...(input.conversationName?.trim() ? { conversationName: input.conversationName.trim() } : {}),
      senderId: input.senderId,
      senderName: input.senderName,
      text: stored,
      ...(input.platformMessageId ? { platformMessageId: input.platformMessageId } : {}),
      truncated: clipped,
    };

    const name = this.fileNameFor(input);
    const target = join(this.pendingDir, name);

    try {
      // `wx` fails when the file exists, which is exactly the dedupe we want,
      // and it is atomic - unlike a read-then-write check.
      await writeFile(target, `${JSON.stringify(message, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        this.logger.debug('duplicate inbound event dropped', { name });
        return undefined;
      }
      throw error;
    }

    await this.trim(this.pendingDir, this.maxPending, 'inbound queue');
    return name;
  }

  /**
   * The oldest unread messages, up to `limit`.
   *
   * Reading does not consume: a host may call this to look, and only `ack`
   * removes anything. That split is what lets `qq_read_messages` honestly
   * declare itself read-only, so a client can auto-approve it.
   */
  async read(limit: number): Promise<{ messages: InboxMessage[]; pendingTotal: number; malformed: string[] }> {
    await this.ensure();

    const names = await this.listNames(this.pendingDir);
    const pendingTotal = names.length;
    const all: InboxMessage[] = [];
    const malformed: string[] = [];

    // Every pending file is read, not just the first `limit`. File names carry
    // no timestamp on purpose - deduplication requires them to depend only on
    // the platform message id - so ordering has to happen here, on the recorded
    // arrival time. The queue is bounded (see maxPending), which keeps this
    // cheap; a queue in the hundreds of small files is tens of milliseconds.
    for (const name of names) {
      const parsed = await this.readOne(name);
      if (parsed === undefined) {
        malformed.push(name);
        continue;
      }
      all.push(parsed);
    }

    all.sort((a, b) => {
      const byPlatform = a.at.localeCompare(b.at);
      return byPlatform !== 0 ? byPlatform : a.receivedAt.localeCompare(b.receivedAt);
    });
    return { messages: all.slice(0, limit), pendingTotal, malformed };
  }

  /**
   * Mark messages as handled by moving them out of `pending/`.
   *
   * A rename rather than a delete, so the history stays inspectable - "did the
   * agent see that?" is answerable later, which it is not once the file is
   * gone. Unknown ids are reported rather than treated as an error: the agent
   * may be acking something another process already took.
   */
  async ack(ids: readonly string[]): Promise<{ acknowledged: string[]; unknown: string[] }> {
    await this.ensure();

    const acknowledged: string[] = [];
    const unknown: string[] = [];

    for (const id of ids) {
      if (!isSafeName(id)) {
        unknown.push(id);
        continue;
      }

      const from = join(this.pendingDir, id);
      const to = join(this.readDir, id);
      try {
        await rename(from, to);
        acknowledged.push(id);
      } catch {
        unknown.push(id);
      }
    }

    await this.trim(this.readDir, this.maxRead, 'read archive');
    return { acknowledged, unknown };
  }

  async stats(): Promise<{ pending: number; read: number }> {
    await this.ensure();
    return {
      pending: (await this.listNames(this.pendingDir)).length,
      read: (await this.listNames(this.readDir)).length,
    };
  }

  private async readOne(name: string): Promise<InboxMessage | undefined> {
    let raw: string;
    try {
      raw = await readFile(join(this.pendingDir, name), 'utf8');
    } catch {
      return undefined;
    }

    try {
      const value = JSON.parse(raw) as Partial<InboxMessage>;
      if (typeof value.text !== 'string' || value.text.trim() === '') return undefined;
      const kind: ConversationKind = value.kind === 'group' ? 'group' : 'user';
      const receivedAt = typeof value.receivedAt === 'string' ? value.receivedAt : '';
      return {
        id: name,
        at: typeof value.at === 'string' && value.at !== '' ? value.at : receivedAt,
        receivedAt,
        kind,
        conversationId: typeof value.conversationId === 'string' ? value.conversationId : 'unknown',
        ...(typeof value.conversationName === 'string' && value.conversationName !== ''
          ? { conversationName: value.conversationName }
          : {}),
        senderId: typeof value.senderId === 'string' ? value.senderId : 'unknown',
        senderName: typeof value.senderName === 'string' ? value.senderName : 'unknown',
        text: value.text,
        ...(typeof value.platformMessageId === 'string' && value.platformMessageId !== ''
          ? { platformMessageId: value.platformMessageId }
          : {}),
        truncated: value.truncated === true,
      };
    } catch {
      // A process killed mid-write leaves a partial file. Skipping it keeps the
      // rest of the queue readable instead of one bad byte destroying it.
      return undefined;
    }
  }

  private async listNames(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir);
      return entries.filter((name) => name.endsWith('.json')).sort();
    } catch {
      return [];
    }
  }

  /** Drop the oldest files once a directory exceeds its bound. */
  private async trim(dir: string, max: number, label: string): Promise<void> {
    const names = await this.listNames(dir);
    if (names.length <= max) return;

    // Ordered by modification time, which is when the file was written. File
    // names deliberately carry no timestamp, so they cannot be used for this.
    const stamped = await Promise.all(
      names.map(async (name) => {
        try {
          return { name, at: (await stat(join(dir, name))).mtimeMs };
        } catch {
          return { name, at: Number.MAX_SAFE_INTEGER };
        }
      }),
    );
    stamped.sort((a, b) => a.at - b.at);

    const excess = stamped.slice(0, stamped.length - max);
    for (const entry of excess) {
      await rm(join(dir, entry.name), { force: true });
    }
    this.logger.warn('inbox trimmed', { area: label, dropped: excess.length, kept: max });
  }

  /**
   * A stable file name.
   *
   * The digest is over the platform message id, and deliberately NOT over the
   * arrival time. A timestamp in the name would differ between two deliveries
   * of the same event, the `wx` write would store both, and the model would
   * read - and answer - the same message twice. That is the failure this name
   * exists to prevent, so nothing time-dependent may enter it.
   *
   * Ids that are missing or unusable fall back to a random suffix, which means
   * no deduplication: the right trade, since dropping a distinct message is
   * worse than an occasional duplicate.
   */
  private fileNameFor(input: { kind: ConversationKind; conversationId: string; platformMessageId?: string; text: string }): string {
    const key = input.platformMessageId?.trim()
      ? `${input.kind}:${input.conversationId}:${input.platformMessageId}`
      : `${input.kind}:${input.conversationId}:${input.text}:${Math.random()}`;
    return `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`;
  }
}

/** Reject anything that could escape the queue directory. */
function isSafeName(name: string): boolean {
  return name.endsWith('.json') && !name.includes('/') && !name.includes('\\') && !name.includes('..');
}
