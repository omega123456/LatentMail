import { useMutation } from '@tanstack/react-query';
import type { ThreadCursor, ThreadPageParam } from '@/lib/types/ipc';
import { useToastStore } from '@/stores/toast';

export const LOCAL_FIRST_STALE_TIME = 15_000;
export const RETAINED_THREAD_PAGES = 5;
export const THREAD_PAGE_SIZE = 50;

export function useCommandMutation<Request = void, Result = unknown>(
  mutationFn: (request: Request) => Promise<Result>,
  errorMessage: string,
  onSuccess?: (result: Result, request: Request) => void,
) {
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: mutationFn,
    onSuccess: onSuccess,
    onError: () => showError(errorMessage),
  });
}

type CursorPage = {
  nextCursor?: ThreadCursor | null;
  previousCursor?: ThreadCursor | null;
};

export function nextThreadPageParam(lastPage: CursorPage): ThreadPageParam | undefined {
  return lastPage.nextCursor ? { cursor: lastPage.nextCursor, direction: 'forward' } : undefined;
}

export function previousThreadPageParam(firstPage: CursorPage): ThreadPageParam | undefined {
  return firstPage.previousCursor
    ? { cursor: firstPage.previousCursor, direction: 'backward' }
    : undefined;
}
