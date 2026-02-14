export interface Email {
  id: number;
  accountId: number;
  gmailMessageId: string;
  gmailThreadId: string;
  folder: string;
  fromAddress: string;
  fromName?: string;
  toAddresses: string;
  ccAddresses?: string;
  bccAddresses?: string;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  date: string;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  snippet?: string;
  size?: number;
  hasAttachments: boolean;
  labels?: string;
}

export interface Thread {
  id: number;
  accountId: number;
  gmailThreadId: string;
  subject?: string;
  lastMessageDate: string;
  participants?: string;
  messageCount: number;
  snippet?: string;
  folder: string;
  isRead: boolean;
  isStarred: boolean;
  messages?: Email[];
}

export interface Attachment {
  id: number;
  emailId: number;
  filename: string;
  mimeType?: string;
  size?: number;
  contentId?: string;
  localPath?: string;
}
