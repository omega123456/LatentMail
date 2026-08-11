import { useState } from 'react';
import { invoke } from '@/lib/ipc/commands';

export function ReauthBanner({ accountId }: { accountId: string }) {
  const [fixing, setFixing] = useState(false);
  const fix = async () => {
    setFixing(true);
    try {
      await invoke('begin_reauthentication', { accountId });
    } catch {
      setFixing(false);
    }
  };
  return (
    <div
      role="alert"
      data-testid="reauth-banner"
      className="flex items-center justify-between gap-stack-gap-md bg-error-container px-container-padding py-stack-gap-sm text-body-sm text-on-error-container dark:bg-dark-error-container dark:text-dark-on-error-container"
    >
      <span>Your Google connection needs attention.</span>
      <button
        onClick={() => void fix()}
        disabled={fixing}
        className="rounded-sm bg-error px-3 py-1 text-on-error disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-primary"
      >
        {fixing ? 'Fixing…' : 'Fix'}
      </button>
    </div>
  );
}
