import { useEffect } from 'react';
import { useAccountsQuery } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';
import { SignInScreen } from '@/components/auth/SignInScreen';
import { MailLayout } from './MailLayout';
import { Toast } from '@/components/states/Toast';

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
  const content = route === 'auth' ? (
    <SignInScreen />
  ) : route === 'settings' ? (
      <main className="min-h-screen bg-surface p-container-padding text-headline-sm dark:bg-dark-surface">
        Settings are not yet implemented.
      </main>
  ) : (
    <MailLayout accounts={accounts ?? []} />
  );
  return <>{content}<Toast /></>;
}
