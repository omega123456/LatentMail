import { PanelLeftOpen, Plus, Settings } from 'lucide-react';
import type { Account } from '@/lib/types/ipc';
import type { Mailbox } from './FolderList';
import { AccountSwitcher } from './AccountSwitcher';
import { FolderList } from './FolderList';

export function CollapsedRail({
  accounts,
  activeAccountId,
  activeMailboxId,
  mailboxes,
  onSelectAccount,
  onSelectMailbox,
  onExpand,
  onSettings,
  onCompose,
}: {
  accounts: Account[];
  activeAccountId: string | null;
  activeMailboxId: string | null;
  mailboxes: Mailbox[];
  onSelectAccount: (id: string) => void;
  onSelectMailbox: (id: string) => void;
  onExpand: () => void;
  onSettings: () => void;
  onCompose?: () => void;
}) {
  return (
    <aside
      data-testid="collapsed-rail"
      className="flex w-rail-width flex-col items-center gap-stack-gap-md bg-surface-container-low px-stack-gap-sm py-stack-gap-sm dark:bg-dark-surface-container-low"
    >
      <AccountSwitcher
        accounts={accounts}
        activeAccountId={activeAccountId}
        collapsed
        onSelect={onSelectAccount}
      />
      <button
        type="button"
        aria-label="Compose"
        title="Compose"
        onClick={onCompose}
        className="grid size-9 place-items-center rounded-full bg-primary text-on-primary focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Plus aria-hidden="true" size={18} />
      </button>
      <FolderList
        activeMailboxId={activeMailboxId}
        mailboxes={mailboxes}
        showUnreadCounts={false}
        collapsed
        onSelect={onSelectMailbox}
      />
      <div className="flex-1" />
      <button
        type="button"
        aria-label="Expand sidebar"
        onClick={onExpand}
        className="grid size-9 place-items-center rounded focus-visible:outline-2 focus-visible:outline-primary"
      >
        <PanelLeftOpen aria-hidden="true" size={18} />
      </button>
      <button
        type="button"
        aria-label="Settings"
        onClick={onSettings}
        className="grid size-9 place-items-center rounded focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Settings aria-hidden="true" size={18} />
      </button>
    </aside>
  );
}
