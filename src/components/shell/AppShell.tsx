import { Suspense, useEffect } from 'react';
import { useAccountsQuery } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';
import { SignInScreen } from '@/components/auth/SignInScreen';
import { CommandProvider } from '@/providers/CommandProvider';
import { MailLayout } from './MailLayout';
import { Toast } from '@/components/states/Toast';
import { UpdateBanner } from '@/components/states/UpdateBanner';
import { DelayedFallback, lazyWithDelayedFallback } from '@/components/states/DelayedFallback';
import { LoadingState } from '@/components/states/LoadingState';

import type { Account } from '@/lib/types/ipc';
import type { Route } from '@/stores/layout';

const SettingsShell = lazyWithDelayedFallback(() =>
  import('@/components/settings/SettingsShell').then(({ SettingsShell }) => ({
    default: SettingsShell,
  })),
);

function StartupSurface() {
  return <div data-testid="startup-surface" className="h-full bg-surface dark:bg-dark-surface" />;
}

function isRouteMismatched(route: Route, configured: boolean): boolean {
  if (route === 'auth' && configured) return true;
  return (route === 'mail' || route === 'settings') && !configured;
}

function WorkspaceSurface({ route, accounts }: { route: Route; accounts: Account[] }) {
  if (route === 'auth') return <SignInScreen />;
  const mailHidden = route !== 'mail';
  return (
    <div className="grid h-full">
      <div
        aria-hidden={mailHidden}
        inert={mailHidden}
        className={`col-start-1 row-start-1 min-h-0 min-w-0 ${mailHidden ? 'invisible pointer-events-none' : ''}`}
      >
        <MailLayout accounts={accounts} />
      </div>
      {route === 'settings' && (
        <div className="col-start-1 row-start-1 min-h-0 min-w-0">
          <Suspense
            fallback={
              <DelayedFallback>
                <div className="h-full bg-settings-page dark:bg-dark-settings-page">
                  <LoadingState />
                </div>
              </DelayedFallback>
            }
          >
            <SettingsShell />
          </Suspense>
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const route = useLayoutStore((layout) => layout.route);
  const setRoute = useLayoutStore((layout) => layout.setRoute);
  const { data: accounts, isPending } = useAccountsQuery();
  const configured = (accounts?.length ?? 0) > 0;
  useEffect(() => {
    if (isPending) return;
    if (route === 'auth' && configured) setRoute('mail');
    if ((route === 'mail' || route === 'settings') && !configured) setRoute('auth');
  }, [configured, isPending, route, setRoute]);
  if (isPending || isRouteMismatched(route, configured)) return <StartupSurface />;
  return (
    <CommandProvider>
      <div className="flex h-full flex-col">
        <UpdateBanner />
        <div className="min-h-0 flex-1">
          <WorkspaceSurface route={route} accounts={accounts ?? []} />
        </div>
      </div>
      <Toast />
    </CommandProvider>
  );
}
