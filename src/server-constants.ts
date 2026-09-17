/**
 * Numeric limits shared by tool schemas and their descriptions.
 *
 * Kept in one place because the same number appears twice: once as the Zod
 * bound the SDK enforces, once in prose the model reads. Letting those drift
 * produces tools whose documented limits are wrong, which teaches the model to
 * call them incorrectly - and the contract audit fails on exactly that.
 */

export const QQ_LIMITS = {
  /** Upper bound for messages returned by one `qq_read_messages` call. */
  maxReadBatch: 50,
  /** Upper bound for messages consumed by one `qq_ack_messages` call. */
  maxAckBatch: 200,
  /**
   * Upper bound for a single outbound message body.
   *
   * QQ rejects very long single messages, and the failure arrives as an opaque
   * platform error. Capping below the real ceiling turns "the send mysteriously
   * failed" into "split it into two messages", which the model can act on.
   */
  maxMessageChars: 4_000,
  /** Upper bound for history entries pulled from one conversation. */
  maxHistoryMessages: 30,
  /** Upper bound for conversations returned by one listing call. */
  maxConversations: 50,
  /** Upper bound for the text preview kept per inbound message. */
  maxStoredTextChars: 2_000,
} as const;
