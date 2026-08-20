import { useEffect } from 'react';
import { useAccountsQuery } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';
import { SignInScreen } from '@/components/auth/SignInScreen';
import { CommandProvider } from '@/providers/CommandProvider';
import { MailLayout } from './MailLayout';
import { Toast } from '@/components/states/Toast';
import { UpdateBanner } from '@/components/states/UpdateBanner';
import { SettingsShell } from '@/components/settings/SettingsShell';

export function AppShell() {
  const route = useLayoutStore((state) => state.route);
  const setRoute = useLayoutStore((state) => state.setRoute);
  const { data: accounts, isPending } = useAccountsQuery();
  const configured = (accounts?.length ?? 0) > 0;
  useEffect(() => {
    if (isPending) return;
    if (route === 'auth' && configured) setRoute('mail');
    if ((route === 'mail' || route === 'settings') && !configured) setRoute('auth');
  }, [configured, isPending, route, setRoute]);
  if (isPending) return null;
  if (
    (route === 'auth' && configured) ||
    ((route === 'mail' || route === 'settings') && !configured)
  )
    return null;
  const content =
    route === 'auth' ? (
      <SignInScreen />
    ) : route === 'settings' ? (
      <SettingsShell />
    ) : (
      <MailLayout accounts={accounts ?? []} />
    );
  return (
    <CommandProvider>
      <div className="flex h-full flex-col">
        <UpdateBanner />
        <div className="min-h-0 flex-1">{content}</div>
      </div>
      <Toast />
    </CommandProvider>
  );
}
