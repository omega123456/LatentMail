import { AlertTriangle, FileText, Inbox, Send, Star, Trash2, type LucideIcon } from 'lucide-react';
import type { LabelColorId } from '@/lib/labels/palette';

export type SystemBadgeId = 'INBOX' | 'SENT' | 'DRAFT' | 'STARRED' | 'TRASH' | 'SPAM';

export const SYSTEM_BADGES: Record<
  SystemBadgeId,
  { name: string; Icon: LucideIcon; className: string }
> = {
  INBOX: {
    name: 'Inbox',
    Icon: Inbox,
    className:
      'bg-badge-inbox text-badge-on-inbox dark:bg-dark-badge-inbox dark:text-dark-badge-on-inbox',
  },
  SENT: {
    name: 'Sent',
    Icon: Send,
    className:
      'bg-badge-sent text-badge-on-sent dark:bg-dark-badge-sent dark:text-dark-badge-on-sent',
  },
  DRAFT: {
    name: 'Drafts',
    Icon: FileText,
    className:
      'bg-badge-draft text-badge-on-draft dark:bg-dark-badge-draft dark:text-dark-badge-on-draft',
  },
  STARRED: {
    name: 'Starred',
    Icon: Star,
    className: 'bg-badge-starred text-star dark:bg-dark-badge-starred dark:text-dark-star',
  },
  TRASH: {
    name: 'Trash',
    Icon: Trash2,
    className:
      'bg-badge-trash text-badge-on-trash dark:bg-dark-badge-trash dark:text-dark-badge-on-trash',
  },
  SPAM: {
    name: 'Spam',
    Icon: AlertTriangle,
    className:
      'bg-badge-spam text-badge-on-spam dark:bg-dark-badge-spam dark:text-dark-badge-on-spam',
  },
};

const LEADING_BADGES: SystemBadgeId[] = ['INBOX', 'SENT', 'DRAFT', 'STARRED'];
const TRAILING_BADGES: SystemBadgeId[] = ['TRASH', 'SPAM'];

export type UserLabel = { id: string; name: string; color: LabelColorId };

export type MessageBadge =
  | { kind: 'system'; id: SystemBadgeId }
  | { kind: 'user'; id: string; name: string; color: LabelColorId };

function byName(a: UserLabel, b: UserLabel) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function toUserBadge(label: UserLabel): MessageBadge {
  return { kind: 'user', id: label.id, name: label.name, color: label.color };
}

function toSystemBadges(ids: SystemBadgeId[], present: (id: SystemBadgeId) => boolean) {
  return ids.filter(present).map((id): MessageBadge => ({ kind: 'system', id }));
}

export function messageBadges(
  message: { labelIds?: string[]; starred?: boolean },
  userLabels: UserLabel[],
): MessageBadge[] {
  const labelIds = message.labelIds ?? [];
  const present = (id: SystemBadgeId) =>
    id === 'STARRED' ? Boolean(message.starred) : labelIds.includes(id);
  return [
    ...toSystemBadges(LEADING_BADGES, present),
    ...userLabels
      .filter((label) => labelIds.includes(label.id))
      .sort(byName)
      .map(toUserBadge),
    ...toSystemBadges(TRAILING_BADGES, present),
  ];
}

export function userBadgesByName(names: string[], userLabels: UserLabel[]): MessageBadge[] {
  return userLabels
    .filter((label) => names.includes(label.name))
    .sort(byName)
    .map(toUserBadge);
}
