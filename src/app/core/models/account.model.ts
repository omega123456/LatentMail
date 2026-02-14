export interface Account {
  id: number;
  email: string;
  displayName: string;
  avatarUrl?: string;
  isActive: boolean;
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
}
