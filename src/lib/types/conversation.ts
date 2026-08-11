export type Conversation = {
  id: string;
  sender: string;
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
