import { PanelLeftOpen, Plus, Settings } from 'lucide-react';
import type { Account } from '@/lib/types/ipc';
import { LABEL_COLOR_BY_ID } from '@/lib/labels/palette';
import type { Label } from './LabelList';
import { navRow } from './rowStyles';
import type { Mailbox } from './FolderList';
import { AccountSwitcher } from './AccountSwitcher';
import { FolderList } from './FolderList';
import { CollapsedSearchIndicator } from './SearchResultsRow';

export function CollapsedRail({
  accounts,
  activeAccountId,
  activeMailboxId,
  mailboxes,
  labels,
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
  labels: Label[];
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
      <div className="min-h-0 w-full flex-1 overflow-y-auto">
        <FolderList
          activeMailboxId={activeMailboxId}
          mailboxes={mailboxes}
          showUnreadCounts={false}
          collapsed
          onSelect={onSelectMailbox}
        />
        {labels.length > 0 && (
          <nav
            aria-label="Labels"
            className="mt-stack-gap-md grid gap-1 border-t border-outline-variant pt-stack-gap-md dark:border-dark-outline-variant"
          >
            {labels.map((label) => (
              <button
                key={label.id}
                type="button"
                aria-label={label.name}
                aria-current={activeMailboxId === label.id ? 'page' : undefined}
                title={label.name}
                onClick={() => onSelectMailbox(label.id)}
                className={`${navRow(activeMailboxId === label.id)} justify-center px-0`}
              >
                <span aria-hidden="true" className="grid size-4.5 place-items-center">
                  <span
                    className={`size-chip-dot rounded-full ${LABEL_COLOR_BY_ID[label.color].dotClass}`}
                  />
                </span>
              </button>
            ))}
          </nav>
        )}
      </div>
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
