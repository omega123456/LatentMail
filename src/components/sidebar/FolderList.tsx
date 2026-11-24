import { SYSTEM_BADGES, type SystemBadgeId } from '@/lib/labels/badges';
import { navCount, navRail, navRow } from './rowStyles';
import { ICON_SIZE } from '@/components/shared/icon-size';

export type Mailbox = { id: string; name: string; unreadCount: number };

const folderOrder: SystemBadgeId[] = ['INBOX', 'STARRED', 'DRAFT', 'SENT', 'SPAM', 'TRASH'];

const folders = folderOrder.map((id) => ({ id, ...SYSTEM_BADGES[id] }));

type FolderEntry = (typeof folders)[number];

function FolderRowLabel({
  name,
  collapsed,
  showUnreadCounts,
  unreadCount,
}: {
  name: string;
  collapsed: boolean;
  showUnreadCounts: boolean;
  unreadCount: number;
}) {
  if (collapsed) return null;
  return (
    <>
      <span className="flex-1 text-left">{name}</span>
      {showUnreadCounts && unreadCount > 0 && <span className={navCount}>{unreadCount}</span>}
    </>
  );
}

function FolderRow({
  folder,
  active,
  unreadCount,
  showUnreadCounts,
  collapsed,
  onSelect,
}: {
  folder: FolderEntry;
  active: boolean;
  unreadCount: number;
  showUnreadCounts: boolean;
  collapsed: boolean;
  onSelect: (id: string) => void;
}) {
  const { id, name, Icon } = folder;
  return (
    <button
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
        size={ICON_SIZE.lg}
        className={active ? 'text-primary dark:text-dark-primary' : undefined}
      />
      <FolderRowLabel
        name={name}
        collapsed={collapsed}
        showUnreadCounts={showUnreadCounts}
        unreadCount={unreadCount}
      />
    </button>
  );
}

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
      {folders.map((folder) => {
        const unreadCount = mailboxes.find((mailbox) => mailbox.id === folder.id)?.unreadCount ?? 0;
        return (
          <FolderRow
            key={folder.id}
            folder={folder}
            active={activeMailboxId === folder.id}
            unreadCount={unreadCount}
            showUnreadCounts={showUnreadCounts}
            collapsed={collapsed}
            onSelect={onSelect}
          />
        );
      })}
    </nav>
  );
}
