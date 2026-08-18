import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAccountsQuery, useRemoveAccountMutation } from '@/lib/query/hooks';
import { invoke } from '@/lib/ipc/commands';
import type { Account } from '@/lib/types/ipc';
import { AccountRow } from './AccountRow';
import { RemoveAccountDialog } from './RemoveAccountDialog';
import { SettingsSection } from './SettingsSection';

export function AccountsSection() {
  const { data: accounts, isLoading, isError } = useAccountsQuery();
  const removeAccount = useRemoveAccountMutation();
  const [pendingRemoval, setPendingRemoval] = useState<Account | null>(null);
  const [adding, setAdding] = useState(false);

  const addAccount = async () => {
    setAdding(true);
    try {
      await invoke('begin_sign_in', {});
    } finally {
      setAdding(false);
    }
  };

  const confirmRemoval = () => {
    if (!pendingRemoval) return;
    removeAccount.mutate(pendingRemoval.id);
    setPendingRemoval(null);
  };

  return (
    <SettingsSection title="Accounts" description="Gmail accounts connected to LatentMail.">
      {isLoading && (
        <p className="text-body-sm text-settings-ink-mute dark:text-dark-settings-ink-mute">
          Loading accounts…
        </p>
      )}
      {isError && (
        <p role="alert" className="text-body-sm text-settings-error dark:text-dark-settings-error">
          Couldn&apos;t load your accounts.
        </p>
      )}
      {!isLoading && !isError && (
        <div className="flex flex-col divide-y divide-settings-outline-variant dark:divide-dark-settings-outline-variant">
          {accounts?.map((account) => (
            <AccountRow key={account.id} account={account} onRemove={setPendingRemoval} />
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => void addAccount()}
        disabled={adding}
        className="mt-3.5 inline-flex w-fit cursor-pointer items-center gap-2 rounded-control bg-settings-container px-3.5 py-2 text-settings-desc font-semibold text-settings-ink hover:bg-settings-container-high disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary dark:bg-dark-settings-container dark:text-dark-settings-ink dark:hover:bg-dark-settings-container-high"
      >
        <Plus aria-hidden="true" size={13} />
        {adding ? 'Adding account…' : 'Add account'}
      </button>
      {pendingRemoval && (
        <RemoveAccountDialog
          account={pendingRemoval}
          removing={removeAccount.isPending}
          onConfirm={confirmRemoval}
          onCancel={() => setPendingRemoval(null)}
        />
      )}
    </SettingsSection>
  );
}
