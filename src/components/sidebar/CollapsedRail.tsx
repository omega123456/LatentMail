import { PanelLeftOpen, Plus, Settings } from 'lucide-react';
import type { Account } from '@/lib/types/ipc';
import type { Mailbox } from './FolderList';
import { AccountSwitcher } from './AccountSwitcher';
import { FolderList } from './FolderList';
import { CollapsedSearchIndicator } from './SearchResultsRow';

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
  searchActive = false,
  searchQuery = '',
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
  searchActive?: boolean;
  searchQuery?: string;
}) {
  return (
    <aside
      data-testid="collapsed-rail"
      className="flex w-rail-width flex-col items-center gap-stack-gap-md bg-surface-container-low px-stack-gap-sm py-stack-gap-sm dark:bg-dark-surface-container-low"
    >
      <button
        type="button"
        aria-label="Compose"
        title="Compose"
        onClick={onCompose}
        className="grid size-9 cursor-pointer place-items-center rounded-full bg-primary text-on-primary focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Plus aria-hidden="true" size={18} />
      </button>
      {searchActive && <CollapsedSearchIndicator query={searchQuery} />}
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
        className="grid size-9 cursor-pointer place-items-center rounded focus-visible:outline-2 focus-visible:outline-primary"
      >
        <PanelLeftOpen aria-hidden="true" size={18} />
      </button>
      <button
        type="button"
        aria-label="Settings"
        onClick={onSettings}
        className="grid size-9 cursor-pointer place-items-center rounded focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Settings aria-hidden="true" size={18} />
      </button>
      <div className="mt-1 flex w-full justify-center border-t border-outline-variant pt-3 dark:border-dark-outline-variant">
        <AccountSwitcher
          accounts={accounts}
          activeAccountId={activeAccountId}
          collapsed
          onSelect={onSelectAccount}
        />
      </div>
    </aside>
  );
}
