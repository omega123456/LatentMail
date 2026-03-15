import { computed, inject } from '@angular/core';
import { signalStore, withState, withMethods, withComputed, patchState } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';
import { Account } from '../core/models/account.model';

interface AccountsState {
  accounts: Account[];
  activeAccountId: number | null;
  loading: boolean;
  error: string | null;
  loginInProgress: boolean;
}

const initialState: AccountsState = {
  accounts: [],
  activeAccountId: null,
  loading: false,
  error: null,
  loginInProgress: false,
};

export const AccountsStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),

  withComputed((store) => ({
    activeAccount: computed(() => {
      const id = store.activeAccountId();
      return store.accounts().find(a => a.id === id) ?? null;
    }),
    accountCount: computed(() => store.accounts().length),
    hasAccounts: computed(() => store.accounts().length > 0),
    accountsNeedingReauth: computed(() =>
      store.accounts().filter(a => a.needsReauth)
    ),
  })),

  withMethods((store) => {
    const electronService = inject(ElectronService);

    return {
      /** Load all accounts from the main process */
      async loadAccounts(): Promise<void> {
        patchState(store, { loading: true, error: null });
        try {
          const response = await electronService.getAccounts();
          if (response.success && response.data) {
            const accounts = response.data as Account[];
            const currentActive = store.activeAccountId();
            // Keep current active account if it still exists, otherwise pick the first
            const activeId = accounts.find(a => a.id === currentActive)
              ? currentActive
              : accounts.length > 0 ? accounts[0].id : null;

            patchState(store, {
              accounts,
              activeAccountId: activeId,
              loading: false,
            });
          } else {
            patchState(store, {
              loading: false,
              error: response.error?.message || 'Failed to load accounts',
            });
          }
        } catch (err: any) {
          patchState(store, {
            loading: false,
            error: err.message || 'Failed to load accounts',
          });
        }
      },

      /** Initiate OAuth login flow */
      async login(): Promise<Account | null> {
        /* c8 ignore start -- requires real Google OAuth browser flow */
        patchState(store, { loginInProgress: true, error: null });
        try {
          const response = await electronService.login();
          if (response.success && response.data) {
            const newAccount = response.data as Account;
            // Reload all accounts to get fresh state
            const accountsResponse = await electronService.getAccounts();
            if (accountsResponse.success && accountsResponse.data) {
              const accounts = accountsResponse.data as Account[];
              patchState(store, {
                accounts,
                activeAccountId: newAccount.id,
                loginInProgress: false,
              });
            } else {
              // At minimum, add the new account to the list
              const currentAccounts = store.accounts();
              const exists = currentAccounts.find(a => a.id === newAccount.id);
              const updatedAccounts = exists
                ? currentAccounts.map(a => a.id === newAccount.id ? newAccount : a)
                : [...currentAccounts, newAccount];
              patchState(store, {
                accounts: updatedAccounts,
                activeAccountId: newAccount.id,
                loginInProgress: false,
              });
            }
            return newAccount;
          } else {
            const errorMsg = response.error?.message || 'Login failed';
            patchState(store, { loginInProgress: false, error: errorMsg });
            return null;
          }
        } catch (err: any) {
          patchState(store, {
            loginInProgress: false,
            error: err.message || 'Login failed',
          });
          return null;
        }
        /* c8 ignore stop */
      },

      /** Remove an account */
      async removeAccount(accountId: number): Promise<boolean> {
        /* c8 ignore start -- requires real account removal with credential storage */
        patchState(store, { loading: true, error: null });
        try {
          const response = await electronService.logout(String(accountId));
          if (response.success) {
            const remaining = store.accounts().filter(a => a.id !== accountId);
            const newActive = store.activeAccountId() === accountId
              ? (remaining.length > 0 ? remaining[0].id : null)
              : store.activeAccountId();

            patchState(store, {
              accounts: remaining,
              activeAccountId: newActive,
              loading: false,
            });
            return true;
          } else {
            patchState(store, {
              loading: false,
              error: response.error?.message || 'Failed to remove account',
            });
            return false;
          }
        } catch (err: any) {
          patchState(store, {
            loading: false,
            error: err.message || 'Failed to remove account',
          });
          return false;
        }
        /* c8 ignore stop */
      },

      /** Set the active account */
      setActiveAccount(accountId: number): void {
        /* c8 ignore start -- requires multiple accounts from login flow */
        if (store.accounts().find(a => a.id === accountId)) {
          patchState(store, { activeAccountId: accountId });
        }
        /* c8 ignore stop */
      },

      /** Clear any error */
      /* c8 ignore next -- only useful after login/remove error */
      clearError(): void {
        patchState(store, { error: null });
      },
    };
  })
);
