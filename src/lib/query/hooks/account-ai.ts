import { useSyncExternalStore } from 'react';
import { useMutation, useQuery, type QueryKey } from '@tanstack/react-query';
import { minutesToMilliseconds } from 'date-fns';
import { invoke } from '@/lib/ipc/commands';
import { dispatchConvertFileSrc, dispatchInvoke } from '@/lib/ipc/dispatch';
import type { IpcCommandMap } from '@/lib/types/ipc';
import { clearStateForRemovedAccount } from '@/lib/accounts/reset-account-state';
import { useLayoutStore } from '@/stores/layout';
import { queryKeys } from '../keys';
import { LOCAL_FIRST_STALE_TIME, useCommandMutation } from './shared';

const AI_CONNECTION_INTERVAL_MINUTES = 5;
export const AI_CONNECTION_INTERVAL_MS = minutesToMilliseconds(AI_CONNECTION_INTERVAL_MINUTES);

export function useAccountsQuery() {
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: () => invoke('list_accounts', {}),
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useAiConfigsQuery() {
  return useQuery({
    queryKey: queryKeys.aiConfigs,
    queryFn: () => invoke('read_ai_configs', {}),
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useAiModelsQuery(accountId: string, revision: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.aiModels(accountId, revision),
    queryFn: () => invoke('list_ai_models', { accountId }),
    enabled: enabled,
    staleTime: 0,
    retry: false,
  });
}

function subscribeToVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

export function useWindowVisible() {
  return useSyncExternalStore(
    subscribeToVisibility,
    () => document.visibilityState === 'visible',
    () => true,
  );
}

export function useAiConnectionQuery(accountId: string, enabled = true) {
  const visible = useWindowVisible();
  return useQuery({
    queryKey: queryKeys.aiConnection(accountId),
    queryFn: () => invoke('test_ai_connection', { accountId }),
    enabled: enabled && visible,
    refetchInterval: AI_CONNECTION_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: AI_CONNECTION_INTERVAL_MS,
    retry: false,
  });
}

export function useAiIndexStatusesQuery() {
  return useQuery({
    queryKey: queryKeys.aiIndexStatuses,
    queryFn: () => invoke('read_ai_index_status', {}),
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

function useAiIndexMutation(command: 'start_ai_index' | 'cancel_ai_index' | 'rebuild_ai_index') {
  return useMutation({ mutationFn: (accountId: string) => invoke(command, { accountId }) });
}

export function useStartAiIndexMutation() {
  return useAiIndexMutation('start_ai_index');
}

export function useCancelAiIndexMutation() {
  return useAiIndexMutation('cancel_ai_index');
}

export function useRebuildAiIndexMutation() {
  return useAiIndexMutation('rebuild_ai_index');
}

export function useRemoveAccountMutation() {
  return useCommandMutation(
    (accountId: string) => invoke('remove_account', { accountId }),
    'Couldn’t remove that account.',
    (_result, accountId) => clearStateForRemovedAccount(accountId),
  );
}

function useAvatarQuery<Command extends 'read_sender_avatar' | 'read_account_avatar'>({
  queryKey,
  command,
  payload,
  enabled,
}: {
  queryKey: QueryKey;
  command: Command;
  payload: IpcCommandMap[Command]['args'];
  enabled: boolean;
}) {
  return useQuery({
    queryKey: queryKey,
    queryFn: async () => {
      try {
        const result = await dispatchInvoke<string | null>(command, payload);
        return result ? dispatchConvertFileSrc(result) : null;
      } catch {
        return null;
      }
    },
    enabled: enabled,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useSenderAvatarQuery(domain: string | null) {
  const showSenderAvatars = useLayoutStore((layout) => layout.showSenderAvatars);
  return useAvatarQuery({
    queryKey: queryKeys.senderAvatar(domain ?? ''),
    command: 'read_sender_avatar',
    payload: { domain: domain as string },
    enabled: domain !== null && showSenderAvatars,
  });
}

export function useAccountAvatarQuery(accountId: string | null) {
  return useAvatarQuery({
    queryKey: queryKeys.accountAvatar(accountId ?? ''),
    command: 'read_account_avatar',
    payload: { accountId: accountId as string },
    enabled: accountId !== null,
  });
}
