export type Conversation = {
  id: string;
  sender: string;
  identityLabel?: string | null;
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
  systemLabelIds?: string[];
};
