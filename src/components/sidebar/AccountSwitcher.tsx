import { ChevronDown, CircleAlert, Plus } from 'lucide-react';
import { useState } from 'react';
import { invoke } from '@/lib/ipc/commands';
import type { Account } from '@/lib/types/ipc';

export function AccountSwitcher({
  accounts,
  activeAccountId,
  collapsed,
  onSelect,
}: {
  accounts: Account[];
  activeAccountId: string | null;
  collapsed: boolean;
  onSelect: (accountId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const active = accounts.find((account) => account.id === activeAccountId) ?? accounts[0];
  const addAccount = async () => {
    setAdding(true);
    try {
      await invoke('begin_sign_in', {});
    } catch {
      setAdding(false);
    }
  };
  if (!active) return null;
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={collapsed ? active.email : undefined}
        title={collapsed ? active.email : undefined}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`flex w-full items-center gap-3 rounded px-2 py-2 text-left text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface ${collapsed ? 'justify-center' : ''}`}
      >
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-label-md text-on-primary"
        >
          {active.displayName.slice(0, 1)}
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label-md">{active.displayName}</span>
              <span className="block truncate text-label-sm text-secondary dark:text-dark-secondary">
                Active: {active.email}
              </span>
            </span>
            <ChevronDown aria-hidden="true" size={16} />
          </>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute z-10 mt-stack-gap-sm min-w-56 rounded-md bg-surface-container-lowest p-stack-gap-sm shadow-lg dark:bg-dark-surface-container ${collapsed ? 'left-rail-width' : 'left-0'}`}
        >
          {accounts.map((account) => (
            <button
              key={account.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onSelect(account.id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-stack-gap-sm rounded px-stack-gap-sm py-2 text-left text-body-sm text-on-surface hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface dark:hover:bg-primary/15"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-label-sm text-on-primary">
                {account.displayName.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1 truncate">{account.email}</span>
              {account.needsReauthentication && (
                <CircleAlert
                  aria-label="Needs reauthentication"
                  className="text-error dark:text-dark-error"
                  size={16}
                />
              )}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            disabled={adding}
            onClick={() => void addAccount()}
            className="mt-stack-gap-sm flex w-full items-center gap-stack-gap-sm rounded px-stack-gap-sm py-2 text-body-sm text-primary disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-primary"
          >
            <Plus aria-hidden="true" size={16} />
            {adding ? 'Adding account…' : 'Add account'}
          </button>
        </div>
      )}
    </div>
  );
}
