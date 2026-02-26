export interface Account {
  id: number;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  isActive: boolean;
  needsReauth?: boolean;
}

export interface Folder {
  id: number;
  accountId: number;
  gmailLabelId: string;
  name: string;
  type: 'system' | 'user';
  color?: string;
  unreadCount: number;
  totalCount: number;
  icon?: string;
  /** RFC 6154 mailbox special-use attribute (e.g. '\\Trash', '\\Sent'). Null for user labels. */
  specialUse?: string | null;
}
