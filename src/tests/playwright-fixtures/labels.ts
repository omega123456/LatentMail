import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightLabels: IpcCommandMap['list_labels']['result'] = [
  { id: 'INBOX', name: 'Inbox', kind: 'system', color: null, messageCount: 12, unreadCount: 3 },
  { id: 'STARRED', name: 'Starred', kind: 'system', color: null, messageCount: 2, unreadCount: 0 },
  { id: 'DRAFT', name: 'Drafts', kind: 'system', color: null, messageCount: 1, unreadCount: 1 },
  { id: 'SENT', name: 'Sent', kind: 'system', color: null, messageCount: 40, unreadCount: 0 },
  { id: 'SPAM', name: 'Spam', kind: 'system', color: null, messageCount: 0, unreadCount: 0 },
  { id: 'TRASH', name: 'Trash', kind: 'system', color: null, messageCount: 0, unreadCount: 0 },
  {
    id: 'Label_1',
    name: 'Work',
    kind: 'user',
    color: { text: '#ffffff', background: '#4a86e8' },
    messageCount: 8,
    unreadCount: 2,
  },
  {
    id: 'Label_2',
    name: 'Personal',
    kind: 'user',
    color: { text: '#ffffff', background: '#16a765' },
    messageCount: 5,
    unreadCount: 0,
  },
];

export const playwrightCreatedLabel: IpcCommandMap['create_label']['result'] = {
  id: 'Label_3',
  name: 'Clients',
  kind: 'user',
  color: { text: '#ffffff', background: '#fb4c2f' },
  messageCount: 0,
  unreadCount: 0,
};

export const playwrightMutationResults: IpcCommandMap['mutate_threads']['result'] = [];
