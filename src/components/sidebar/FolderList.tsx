import { SYSTEM_BADGES, type SystemBadgeId } from '@/lib/labels/badges';
import { navCount, navRail, navRow } from './rowStyles';

export type Mailbox = { id: string; name: string; unreadCount: number };

const folderOrder: SystemBadgeId[] = ['INBOX', 'STARRED', 'DRAFT', 'SENT', 'SPAM', 'TRASH'];

const folders = folderOrder.map((id) => ({ id, ...SYSTEM_BADGES[id] }));

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
            className={`${navRow(active)} ${collapsed ? 'justify-center px-0' : ''}`}
          >
            {active && !collapsed && <span aria-hidden="true" className={navRail} />}
            <Icon
              aria-hidden="true"
              size={18}
              className={active ? 'text-primary dark:text-dark-primary' : undefined}
            />
            {!collapsed && (
              <>
                <span className="flex-1 text-left">{name}</span>
                {showUnreadCounts && unreadCount > 0 && (
                  <span className={navCount}>{unreadCount}</span>
                )}
              </>
            )}
          </button>
        );
      })}
    </nav>
  );
}
