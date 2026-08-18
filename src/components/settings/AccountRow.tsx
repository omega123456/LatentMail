import { useState } from 'react';
import { TriangleAlert, Trash2 } from 'lucide-react';
import { Avatar } from '@/components/shared/Avatar';
import { useAccountAvatarQuery } from '@/lib/query/hooks';
import { invoke } from '@/lib/ipc/commands';
import type { Account } from '@/lib/types/ipc';
import { settingsButton, settingsDangerIconButton } from './styles';

export function AccountRow({
  account,
  onRemove,
}: {
  account: Account;
  onRemove: (account: Account) => void;
}) {
  const [reconnecting, setReconnecting] = useState(false);
  const { data: avatarSrc } = useAccountAvatarQuery(account.id);
  const reconnect = async () => {
    setReconnecting(true);
    try {
      await invoke('begin_reauthentication', { accountId: account.id });
    } finally {
      setReconnecting(false);
    }
  };
  return (
    <div
      data-testid={`account-row-${account.id}`}
      className="group relative flex items-center gap-3 rounded py-3 pl-3.25 pr-1 hover:bg-settings-container-low dark:hover:bg-dark-settings-container-low"
    >
      {account.needsReauthentication && (
        <span
          aria-hidden="true"
          className="absolute inset-y-2.75 left-0 w-0.5 rounded-full bg-settings-error dark:bg-dark-settings-error"
        />
      )}
      <Avatar
        size={30}
        src={avatarSrc}
        label={account.displayName}
        fallbackClassName="text-avatar-md bg-settings-primary-container text-settings-on-primary-container dark:bg-dark-settings-primary-container dark:text-dark-settings-on-primary-container"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-sm font-medium text-settings-ink dark:text-dark-settings-ink">
          {account.displayName}
        </p>
        <p className="truncate text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute">
          {account.email}
        </p>
        {account.needsReauthentication && (
          <p
            role="alert"
            className="mt-0.75 flex items-center gap-1.5 text-settings-meta text-settings-error dark:text-dark-settings-error"
          >
            <TriangleAlert aria-hidden="true" size={13} />
            Sign-in expired — LatentMail can&apos;t sync this account.
          </p>
        )}
      </div>
      <div
        className={`flex shrink-0 items-center gap-1.5 ${
          account.needsReauthentication
            ? 'opacity-100'
            : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
        }`}
      >
        {account.needsReauthentication && (
          <button
            type="button"
            onClick={() => void reconnect()}
            disabled={reconnecting}
            className={`${settingsButton} px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {reconnecting ? 'Reconnecting…' : 'Reconnect'}
          </button>
        )}
        <button
          type="button"
          aria-label={`Remove ${account.email}`}
          onClick={() => onRemove(account)}
          className={settingsDangerIconButton}
        >
          <Trash2 aria-hidden="true" size={13} />
        </button>
      </div>
    </div>
  );
}
