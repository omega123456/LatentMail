import { useQuery } from '@tanstack/react-query';
import { invoke } from '@/lib/ipc/commands';
import type { PauseScope } from '@/lib/types/ipc';
import { UPDATE_INTERVAL_MS } from '@/lib/update-intervals';
import { useLayoutStore } from '@/stores/layout';
import { queryKeys } from '../keys';
import { toLogEntry } from '../mappers';
import { LOCAL_FIRST_STALE_TIME, useCommandMutation } from './shared';

const LOG_AUTO_REFRESH_INTERVAL_MS = 5_000;

export function useQueueOperationsQuery() {
  return useQuery({
    queryKey: queryKeys.queueOperations,
    queryFn: () => invoke('read_queue_operations', {}),
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useCancelQueueOperationMutation() {
  return useCommandMutation(
    (operationId: string) => invoke('cancel_queue_operation', { operationId }),
    'Couldn’t cancel that operation.',
  );
}

export function useRetryQueueOperationMutation() {
  return useCommandMutation(
    (operationId: string) => invoke('retry_queue_operation', { operationId }),
    'Couldn’t retry that operation.',
  );
}

export function useRetryFailedOperationsMutation() {
  return useCommandMutation(
    (accountId?: string) => invoke('retry_failed_operations', { accountId: accountId ?? null }),
    'Couldn’t retry the failed operations.',
  );
}

export function useClearQueueHistoryMutation() {
  return useCommandMutation(
    (accountId?: string) => invoke('clear_queue_history', { accountId: accountId ?? null }),
    'Couldn’t clear the queue history.',
  );
}

export function useSetQueuePausedMutation() {
  return useCommandMutation(
    (request: { scope: PauseScope; paused: boolean }) => invoke('set_queue_paused', request),
    'Couldn’t update the pause state.',
  );
}

export function useLogEntriesQuery() {
  return useQuery({
    queryKey: queryKeys.logEntries,
    queryFn: () => invoke('read_log_entries', {}),
    select: (entries) => entries.map(toLogEntry),
    staleTime: 0,
    refetchInterval: LOG_AUTO_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export function useAppUpdateQuery() {
  const updateCheckInterval = useLayoutStore((layout) => layout.updateCheckInterval);
  return useQuery({
    queryKey: queryKeys.appUpdate,
    queryFn: () => invoke('check_for_update', {}),
    refetchInterval:
      updateCheckInterval === 'off' ? false : UPDATE_INTERVAL_MS[updateCheckInterval],
    staleTime: 0,
    retry: false,
  });
}

export function useInstallUpdateMutation() {
  return useCommandMutation<void>(
    () => invoke('install_update', {}),
    'Couldn’t install the update.',
  );
}

export function useTraversalStatusQuery(accountId: string | null) {
  return useQuery({
    queryKey: queryKeys.traversalStatus(accountId ?? ''),
    queryFn: () => invoke('read_traversal_status', { accountId: accountId as string }),
    enabled: accountId !== null,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}
