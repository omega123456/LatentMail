export type Conversation = {
  id: string;
  /** The already-formatted row text (fallback and Sent `To: ` prefix baked
   * in by the mapper) — rendered as-is, never parsed. */
  sender: string;
  /** The bare identity label behind `sender` (no fallback text, no `To: `
   * prefix) — what the avatar's initial is derived from. `null`/undefined
   * when there is no identity at all, in which case the avatar falls back to
   * `?`. Optional so fixtures that predate this slice keep compiling. */
  identityLabel?: string | null;
  /** The lower-cased lookup domain for the row's sender-avatar query,
   * already resolved by `mapThreadToRow` via `src/lib/avatars/identity.ts`.
   * `null`/undefined when there's no usable address. */
  avatarDomain?: string | null;
  subject: string;
  snippet: string;
  date: Date;
  unread: boolean;
  starred: boolean;
  hasAttachment?: boolean;
  messageCount?: number;
  draft?: boolean;
  labels?: string[];
};
