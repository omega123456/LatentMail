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
  type: 'system' | 'user' | 'filter-label';
  color?: string;
  unreadCount: number;
  totalCount: number;
  icon?: string;
}
