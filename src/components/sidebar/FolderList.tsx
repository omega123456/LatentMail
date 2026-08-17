import { AlertTriangle, FileText, Inbox, Send, Star, Trash2, type LucideIcon } from 'lucide-react';

export type Mailbox = { id: string; name: string; unreadCount: number };

const folders: { id: string; name: string; Icon: LucideIcon }[] = [
  { id: 'INBOX', name: 'Inbox', Icon: Inbox },
  { id: 'STARRED', name: 'Starred', Icon: Star },
  { id: 'DRAFT', name: 'Drafts', Icon: FileText },
  { id: 'SENT', name: 'Sent', Icon: Send },
  { id: 'SPAM', name: 'Spam', Icon: AlertTriangle },
  { id: 'TRASH', name: 'Trash', Icon: Trash2 },
];

export function FolderList({
  activeMailboxId,
  mailboxes,
  showUnreadCounts,
  collapsed = false,
  onSelect,
}: {
  activeMailboxId: string | null;
  mailboxes: Mailbox[];
  showUnreadCounts: boolean;
  collapsed?: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <nav aria-label="Mailboxes" className="grid gap-1">
      {folders.map(({ id, name, Icon }) => {
        const unreadCount = mailboxes.find((mailbox) => mailbox.id === id)?.unreadCount ?? 0;
        const active = activeMailboxId === id;
        return (
          <button
            key={id}
            type="button"
            aria-label={name}
            aria-current={active ? 'page' : undefined}
            title={collapsed ? name : undefined}
            onClick={() => onSelect(id)}
            className={`flex cursor-pointer items-center gap-3 rounded px-3 py-2 text-body-md focus-visible:outline-2 focus-visible:outline-primary ${active ? 'bg-primary-container font-bold text-on-primary-container dark:bg-dark-primary-container dark:text-dark-on-primary-container' : 'text-on-surface-variant hover:bg-surface-container-low dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container'} ${collapsed ? 'justify-center px-0' : ''}`}
          >
            <Icon aria-hidden="true" size={20} />
            {!collapsed && (
              <>
                <span className="flex-1 text-left">{name}</span>
                {showUnreadCounts && unreadCount > 0 && (
                  <span
                    className={`text-label-sm ${active ? 'rounded-full bg-on-primary-container px-2 py-0.5 text-primary-container dark:bg-dark-on-primary-container dark:text-dark-primary-container' : 'text-secondary dark:text-dark-secondary'}`}
                  >
                    {unreadCount}
                  </span>
                )}
              </>
            )}
          </button>
        );
      })}
    </nav>
  );
}
