import { getTime, parseISO } from 'date-fns';
import { act } from '@testing-library/react';
import type { IpcCommandMap } from '@/lib/types/ipc';
import { ipc } from '@/tests/ipc-mock';
import { useLayoutStore } from '@/stores/layout';
import { useSearchStore } from '@/stores/search';
import { useSelectionStore } from '@/stores/selection';
import { useSyncStore } from '@/stores/sync';
import { useSettingsUiStore } from '@/stores/settings-ui';

export function resetAppShellStores() {
  act(() => {
    useSelectionStore.setState({
      activeAccountId: null,
      activeMailboxId: null,
      activeThreadId: null,
      keyboardCursor: null,
    });
    useSyncStore.setState({ accountId: null, lastSynced: null, syncState: 'idle' });
    useLayoutStore.setState({
      route: 'mail',
      layout: 'three-column',
      sidebarCollapsed: false,
      sidebarWidth: 260,
      listWidth: 350,
      readerHeight: 40,
    });
    useSearchStore.setState({
      draft: '',
      submittedQuery: '',
      scope: { kind: 'default' },
      active: false,
      panelOpen: false,
    });
    useSettingsUiStore.setState({ activeSection: 'general' });
  });
}

export const accountOne = {
  id: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  avatarUrl: null,
  needsReauthentication: false,
};

export const accountTwo = {
  id: 'account-2',
  email: 'sam@example.com',
  displayName: 'Sam Rivera',
  avatarUrl: null,
  needsReauthentication: false,
};

export const inboxLabel = {
  id: 'INBOX',
  name: 'Inbox',
  kind: 'system',
  color: null,
  messageCount: 1,
  unreadCount: 1,
};

export const workLabel = {
  id: 'Label_1',
  name: 'Work',
  kind: 'user',
  color: { text: '#ffffff', background: '#4a86e8' },
  messageCount: 1,
  unreadCount: 0,
};

export const threadOne = {
  id: 'thread-1',
  subject: 'Q3 review',
  sender: { display: 'Elena Rodriguez', address: 'elena.r@example.com' },
  sentRecipient: null,
  latestAt: getTime(parseISO('2026-08-10T09:00:00Z')),
  messageCount: 1,
  isUnread: true,
  isStarred: false,
  hasAttachments: false,
  hasDraft: false,
};

export const conversationOne = {
  threadId: 'thread-1',
  subject: 'Q3 review',
  messages: [
    {
      id: 'message-1',
      sender: 'Elena Rodriguez <elena.r@example.com>',
      recipients: ['You <you@example.com>'],
      subject: 'Q3 review',
      sentAt: getTime(parseISO('2026-08-10T09:00:00Z')),
      snippet: 'Attached slides',
      htmlBody: '<p>Attached slides</p>',
      htmlPresence: 'present',
      truncated: false,
      plainBody: null,
      hasAttachments: false,
      isUnread: true,
      isStarred: false,
      labelIds: ['Label_1'],
      remoteImagesBlocked: false,
      remoteImagesAllowed: false,
      inlineImagesPending: false,
      attachments: [],
    },
  ],
} satisfies IpcCommandMap['load_conversation']['result'];

export function overrideAccount(id: string, threads: (typeof threadOne)[]) {
  ipc.override('list_labels', ({ accountId }) => (accountId === id ? [inboxLabel, workLabel] : []));
  ipc.override('list_threads', ({ accountId }) =>
    accountId === id ? { items: threads, nextCursor: null } : { items: [], nextCursor: null },
  );
}
