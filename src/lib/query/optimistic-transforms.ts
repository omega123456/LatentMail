import type {
  MailLabel,
  MailLabelColor,
  MailThread,
  MoveDestination,
  SearchScope,
  ThreadPage,
  ThreadSearchPage,
} from '@/lib/types/ipc';
import { LABEL_COLOR_BY_ID } from '@/lib/labels/palette';
import { compareLabelNames } from '@/lib/labels/order';
import { formatCount } from '@/lib/format/strings';

export type TriageChange = { threadIds: string[]; add: string[]; remove: string[] };

export type MessageTriageChange = {
  threadId: string;
  messageIds: string[];
  add: string[];
  remove: string[];
};

export type TriageIntent =
  | { kind: 'label'; add: string[]; remove: string[] }
  | { kind: 'delete' }
  | { kind: 'move'; destination: MoveDestination };

export type ThreadTriageIntent = TriageIntent;
export type MessageTriageIntent = TriageIntent;

export type ReaderMessageCacheEntry = {
  id: string;
  labelIds: string[];
  isUnread: boolean;
  isStarred: boolean;
};

export type LabelLifecycleMutationOptions<Request> = {
  accountId: string | null;
  mutationFn: (request: Request) => Promise<unknown>;
  copy: { done: string; failed: string };
  optimistic: (labels: MailLabel[], request: Request) => MailLabel[];
};

export type ThreadTransferMutationOptions<Change extends { threadIds: string[] }> = {
  accountId: string | null;
  verb: string;
  mutationFn: (change: Change) => Promise<unknown>;
  destinationFor: (change: Change) => string;
  clearActiveSelection: boolean;
};

export type ThreadPagesUpdateTarget = {
  accountId: string | null;
  threadIds: string[];
  leavesMailbox: boolean;
  leavesSearch: boolean;
  update: (thread: MailThread) => MailThread;
};

export type ConversationMessagesUpdateTarget = {
  accountId: string | null;
  threadId: string;
  messageIds: string[] | null;
  removesMessage: boolean;
  update: (message: ReaderMessageCacheEntry) => ReaderMessageCacheEntry;
};

function labelColorFor(colorId: string | null): MailLabelColor | null {
  const swatch = colorId === null ? undefined : LABEL_COLOR_BY_ID[colorId];
  return swatch ? { background: swatch.gmailBackground, text: swatch.gmailText } : null;
}

export function appendPendingLabel(
  labels: MailLabel[],
  request: { name: string; colorId: string | null },
): MailLabel[] {
  return [
    ...labels,
    {
      id: `pending-label-${request.name}`,
      name: request.name,
      kind: 'user',
      color: labelColorFor(request.colorId),
      messageCount: 0,
      unreadCount: 0,
    },
  ].sort(compareLabelNames);
}

export function renameCachedLabel(
  labels: MailLabel[],
  request: { labelId: string; name: string },
): MailLabel[] {
  return labels
    .map((label) => (label.id === request.labelId ? { ...label, name: request.name } : label))
    .sort(compareLabelNames);
}

export function recolorCachedLabel(
  labels: MailLabel[],
  request: { labelId: string; colorId: string },
): MailLabel[] {
  return labels.map((label) =>
    label.id === request.labelId ? { ...label, color: labelColorFor(request.colorId) } : label,
  );
}

export function removeCachedLabel(labels: MailLabel[], request: { labelId: string }): MailLabel[] {
  return labels.filter((label) => label.id !== request.labelId);
}

export function formatFailureCopy(verb: string, count: number, singular: string): string {
  if (count > 1) return `Couldn’t ${verb} ${formatCount(count, singular)}.`;
  return `Couldn’t ${verb} ${singular}.`;
}

export function virtualMailboxIdForScope(scope: SearchScope): string | null {
  if (scope.kind === 'default') return 'INBOX';
  if (scope.kind === 'all') return null;
  return scope.labelId;
}

export function leavesMailboxForLabelChange(
  mailboxId: string | null,
  add: string[],
  remove: string[],
): boolean {
  if (mailboxId === null) return false;
  if (remove.includes(mailboxId)) return true;
  return mailboxId === 'INBOX' && (add.includes('TRASH') || add.includes('SPAM'));
}

function resolveFlagChange({
  flagLabel,
  add,
  remove,
  current,
}: {
  flagLabel: string;
  add: string[];
  remove: string[];
  current: boolean;
}): boolean {
  if (add.includes(flagLabel)) return true;
  if (remove.includes(flagLabel)) return false;
  return current;
}

export function buildThreadTriageUpdater({
  labels,
  add,
  remove,
}: {
  labels: MailLabel[];
  add: string[];
  remove: string[];
}): (thread: MailThread) => MailThread {
  const userLabelNames = new Map(
    labels.filter((label) => label.kind === 'user').map((label) => [label.id, label.name] as const),
  );
  const addedNames = add
    .map((labelId) => userLabelNames.get(labelId))
    .filter((name): name is string => name !== undefined);
  const removedNames = new Set(remove.map((labelId) => userLabelNames.get(labelId)));
  return (thread: MailThread) => ({
    ...thread,
    isStarred: resolveFlagChange({
      flagLabel: 'STARRED',
      add: add,
      remove: remove,
      current: thread.isStarred,
    }),
    isUnread: resolveFlagChange({
      flagLabel: 'UNREAD',
      add: add,
      remove: remove,
      current: thread.isUnread,
    }),
    labelIndicators: [
      ...new Set([
        ...(thread.labelIndicators ?? []).filter((name) => !removedNames.has(name)),
        ...addedNames,
      ]),
    ].sort(),
  });
}

export function applyMessageLabelChange(
  message: ReaderMessageCacheEntry,
  add: string[],
  remove: string[],
): ReaderMessageCacheEntry {
  return {
    ...message,
    labelIds: [...new Set([...message.labelIds.filter((id) => !remove.includes(id)), ...add])],
  };
}

export function applyMessageTriageChange(
  message: ReaderMessageCacheEntry,
  add: string[],
  remove: string[],
): ReaderMessageCacheEntry {
  return {
    ...applyMessageLabelChange(message, add, remove),
    isUnread: resolveFlagChange({
      flagLabel: 'UNREAD',
      add: add,
      remove: remove,
      current: message.isUnread,
    }),
    isStarred: resolveFlagChange({
      flagLabel: 'STARRED',
      add: add,
      remove: remove,
      current: message.isStarred,
    }),
  };
}

export function transformThreadPages<Page extends ThreadPage | ThreadSearchPage>(
  data: { pages: Page[] } | undefined,
  options: {
    threadIds: string[];
    removesMatching: boolean;
    update: (thread: MailThread) => MailThread;
  },
): { pages: Page[] } | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items
        .filter((thread) => !(options.removesMatching && options.threadIds.includes(thread.id)))
        .map((thread) => (options.threadIds.includes(thread.id) ? options.update(thread) : thread)),
    })),
  };
}

export function transformConversationMessages(
  data: { messages: ReaderMessageCacheEntry[] } | undefined,
  options: {
    messageIds: string[] | null;
    removesMessage: boolean;
    update: (message: ReaderMessageCacheEntry) => ReaderMessageCacheEntry;
  },
): { messages: ReaderMessageCacheEntry[] } | undefined {
  if (!data) return data;
  const targeted = (messageId: string) =>
    options.messageIds === null || options.messageIds.includes(messageId);
  return {
    ...data,
    messages: data.messages
      .filter((message) => !(options.removesMessage && targeted(message.id)))
      .map((message) => (targeted(message.id) ? options.update(message) : message)),
  };
}
