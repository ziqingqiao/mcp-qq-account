/**
 * OneBot 11 adapter.
 *
 * WHAT THIS TALKS TO
 *
 * An OneBot-compatible implementation (NapCat, Lagrange, ...) that holds a
 * logged-in QQ account. This module knows nothing about MCP: it takes plain
 * arguments and returns plain objects, so it can be exercised from a script
 * without spawning a server. Everything MCP-shaped lives in `tools.ts`.
 *
 * THE ONE THING THAT SURPRISES PEOPLE
 *
 * OneBot answers HTTP 200 for almost everything, including failures. The real
 * outcome is in the envelope's `retcode`, so a naive `fetch` wrapper reports
 * success on a message that was never delivered. Every call here goes through
 * `call()`, which is the only place that reads `retcode`.
 *
 * TEXT IS SENT AS A SEGMENT, NOT A STRING
 *
 * OneBot parses a bare string for CQ codes, so a message body containing
 * something like `[CQ:at,qq=all]` would be executed as a command rather than
 * sent as text. Passing `[{type:'text', ...}]` keeps whatever the model wrote
 * literal - which matters here because the model's input may ultimately come
 * from other people's messages.
 */

import { HttpClient } from '../../core/http-client.js';
import { UpstreamError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';

export interface OneBotClientOptions {
  readonly baseUrl: string;
  readonly accessToken: string | undefined;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly logger: Logger;
  /** Operator kill switch; see `canSend`. */
  readonly sendEnabled?: boolean;
}

export interface AccountInfo {
  userId: string;
  nickname: string;
}

export type ConversationKind = 'user' | 'group';

export interface Conversation {
  kind: ConversationKind;
  id: string;
  name: string;
  /** Present for groups only. */
  memberCount?: number;
}

export interface HistoryMessage {
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  /** ISO timestamp, or '' when the upstream sent no usable time. */
  at: string;
}

export interface SendReceipt {
  messageId: string;
}

/** The OneBot response envelope. `retcode` is the only field that matters. */
interface Envelope {
  status?: unknown;
  retcode?: unknown;
  data?: unknown;
  message?: unknown;
  wording?: unknown;
}

/**
 * retcode -> what the model should do about it.
 *
 * Sourced from the OneBot 11 specification plus the codes NapCat and Lagrange
 * add. Anything unmapped falls back to a generic "adjust and retry" hint, so
 * an unknown code is still actionable rather than a dead end.
 */
function hintForRetcode(retcode: number): string | undefined {
  switch (retcode) {
    case 1:
      return 'The implementation reported a generic failure. Check its own logs before retrying.';
    case 100:
      return 'The request was malformed for this implementation - check the argument format.';
    case 102:
      return 'The implementation refused the operation. It may be a permission or a connection issue on its side.';
    case 103:
      return 'That group does not exist, or the account is not in it. Verify the group id.';
    case 104:
      return 'That user is not reachable - not a friend, or the id is wrong. Verify it with qq_list_conversations.';
    case 106:
      return 'The account is not online, so nothing can be sent. Bring the login session up first.';
    case 1400:
      return 'The message was rejected. It may have been blocked by the platform, or the conversation may no longer be reachable.';
    case 1401:
      return 'The message body was empty after processing. Send non-empty text.';
    case 1404:
      return 'The account is not in that conversation any more. Re-check with qq_list_conversations.';
    default:
      return undefined;
  }
}

export class OneBotClient {
  private readonly http: HttpClient;
  private readonly logger: Logger;
  private readonly sendEnabled: boolean;

  constructor(options: OneBotClientOptions) {
    this.logger = options.logger;
    this.sendEnabled = options.sendEnabled ?? true;

    this.http = new HttpClient({
      service: 'OneBot',
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      logger: options.logger,
      userAgent: 'mcp-qq-account',
      // The single place a credential is attached, so it can never travel
      // through tool arguments or reach a log sink.
      authorise: (): Record<string, string> =>
        options.accessToken === undefined ? {} : { Authorization: `Bearer ${options.accessToken}` },
    });
  }

  /**
   * Whether sending is permitted by configuration.
   *
   * Distinct from "the upstream is reachable": this is the operator's choice,
   * and a refusal because of it must not be presented to the model as a
   * transient failure it should retry.
   */
  get canSend(): boolean {
    return this.sendEnabled;
  }

  /**
   * Boot-time reachability check.
   *
   * Deliberately non-fatal: an account session that is down must not stop the
   * server from answering `tools/list`, or the host shows a broken integration
   * with no explanation.
   */
  async probe(): Promise<{ reachable: boolean; detail: string }> {
    try {
      const account = await this.getAccount();
      return { reachable: true, detail: `logged in as ${account.nickname} (${account.userId})` };
    } catch (error) {
      return { reachable: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async getAccount(signal?: AbortSignal): Promise<AccountInfo> {
    const data = await this.call('get_login_info', {}, signal);
    const record = asRecord(data);
    const userId = readId(record.user_id);
    if (userId === undefined) {
      throw new UpstreamError({
        service: 'OneBot',
        message: 'get_login_info returned no user_id, so the account identity cannot be confirmed.',
        retryable: false,
        hint: 'The implementation may not be fully OneBot-compatible. Check its version.',
      });
    }
    return { userId, nickname: readString(record.nickname) ?? '(unnamed)' };
  }

  async listFriends(signal?: AbortSignal): Promise<Conversation[]> {
    const data = await this.call('get_friend_list', {}, signal);
    return asArray(data).flatMap((entry) => {
      const record = asRecord(entry);
      const id = readId(record.user_id);
      if (id === undefined) return [];
      // `remark` is the local alias and is what the account owner actually sees,
      // so it wins over the nickname when both are present.
      const name = readString(record.remark) ?? readString(record.nickname) ?? id;
      return [{ kind: 'user' as const, id, name }];
    });
  }

  async listGroups(signal?: AbortSignal): Promise<Conversation[]> {
    const data = await this.call('get_group_list', {}, signal);
    return asArray(data).flatMap((entry) => {
      const record = asRecord(entry);
      const id = readId(record.group_id);
      if (id === undefined) return [];
      const name = readString(record.group_name) ?? id;
      const memberCount = readId(record.member_count);
      return [{ kind: 'group' as const, id, name, ...(memberCount === undefined ? {} : { memberCount: Number(memberCount) }) }];
    });
  }

  async sendToUser(userId: string, text: string, signal?: AbortSignal): Promise<SendReceipt> {
    const data = await this.call('send_private_msg', { user_id: userId, message: textSegment(text) }, signal);
    return { messageId: readId(asRecord(data).message_id) ?? 'unknown' };
  }

  async sendToGroup(groupId: string, text: string, signal?: AbortSignal): Promise<SendReceipt> {
    const data = await this.call('send_group_msg', { group_id: groupId, message: textSegment(text) }, signal);
    return { messageId: readId(asRecord(data).message_id) ?? 'unknown' };
  }

  /**
   * Recent messages in a conversation, oldest first.
   *
   * Support for these two actions varies between implementations, so a failure
   * here is reported as "this implementation may not support history" rather
   * than as a generic upstream error - the model can then stop asking.
   */
  async getHistory(
    kind: ConversationKind,
    id: string,
    count: number,
    signal?: AbortSignal,
  ): Promise<HistoryMessage[]> {
    const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
    const body = kind === 'group' ? { group_id: id, count } : { user_id: id, count };

    let data: unknown;
    try {
      data = await this.call(action, body, signal);
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 404) {
        throw new UpstreamError({
          service: 'OneBot',
          message: `this implementation does not provide ${action}.`,
          retryable: false,
          hint: 'Read the inbox instead (qq_read_messages), or check whether your implementation supports message history.',
        });
      }
      throw error;
    }

    const messages = asArray(asRecord(data).messages);
    return messages
      .flatMap((entry) => {
        const record = asRecord(entry);
        const messageId = readId(record.message_id);
        const sender = asRecord(record.sender);
        const text = readString(record.raw_message) ?? extractText(record.message);
        if (messageId === undefined || text === undefined) return [];
        return [
          {
            messageId,
            senderId: readId(record.user_id) ?? 'unknown',
            senderName: readString(sender.nickname) ?? readString(sender.card) ?? 'unknown',
            text,
            at: readTimestamp(record.time),
          },
        ];
      })
      .reverse();
  }

  /**
   * POST one action and unwrap the envelope.
   *
   * The only place `retcode` is read. A non-zero code becomes an `UpstreamError`
   * carrying a hint the model can act on, because a bare "failed" teaches it
   * nothing and invites an identical retry.
   */
  private async call(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const envelope = await this.http.request<Envelope>(
      {
        method: 'POST',
        path: `/${action}`,
        body,
        ...(signal ? { signal } : {}),
      },
      (raw) => (raw === null ? {} : (raw as Envelope)),
    );

    const retcode = typeof envelope.retcode === 'number' ? envelope.retcode : 0;
    if (retcode !== 0 || envelope.status === 'failed') {
      const detail =
        readString(envelope.message) ?? readString(envelope.wording) ?? 'the implementation gave no reason';
      this.logger.warn('onebot action rejected', { action, retcode });

      throw new UpstreamError({
        service: 'OneBot',
        message: `${action} was rejected with retcode ${retcode}: ${detail}`,
        retryable: false,
        hint: hintForRetcode(retcode),
      });
    }

    return envelope.data;
  }
}

/** Wrap text as a single text segment so CQ codes in it stay literal. */
function textSegment(text: string): Array<{ type: 'text'; data: { text: string } }> {
  return [{ type: 'text', data: { text } }];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Read an id as a string.
 *
 * QQ ids arrive as JSON numbers and are safely inside the float64 integer
 * range, but they are identifiers rather than quantities: keeping them as
 * strings avoids a leading-zero or rounding surprise anywhere downstream.
 */
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

/** Pull the plain text out of a message segment array. */
function extractText(message: unknown): string | undefined {
  if (typeof message === 'string') return readString(message);
  if (!Array.isArray(message)) return undefined;

  const parts = message.flatMap((segment) => {
    const record = asRecord(segment);
    if (record.type !== 'text') return [];
    const data = asRecord(record.data);
    const text = readString(data.text);
    return text === undefined ? [] : [text];
  });

  const joined = parts.join('').trim();
  return joined === '' ? undefined : joined;
}

/** OneBot sends a Unix timestamp in seconds; '' when it is missing or absurd. */
function readTimestamp(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  const ms = value > 1e12 ? value : value * 1_000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
