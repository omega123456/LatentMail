import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@/lib/ipc/events';
import { useSyncStore } from '@/stores/sync';
import type { IpcEventMap, MailArrival } from '@/lib/types/ipc';
import { parseParticipant } from '@/lib/format/participants';
import { queryKeys } from './keys';
import { useToastStore } from '@/stores/toast';
import { useComposeStore } from '@/stores/compose';
import { appLog } from '@/lib/app-log';

/** Raises one OS notification for the mail a poll just brought in.
 *
 * `window.Notification` here is the Tauri notification plugin's injected
 * shim, so this is a real native notification on both macOS and Windows.
 * The permission dance is not optional on either: Windows never resolves
 * the shim's cached permission (its startup check short-circuits and leaves
 * it `denied`), and macOS may still be at `default` on the first poll after
 * launch — `requestPermission` is what settles both, and the desktop Rust
 * side always grants. */
async function notifyArrivals(arrivals: MailArrival[]) {
  const [first, ...rest] = arrivals;
  if (!first) return;
  if (
    Notification.permission !== 'granted' &&
    (await Notification.requestPermission()) !== 'granted'
  ) {
    return;
  }
  const { name, address } = parseParticipant(first.sender);
  const subject = first.subject || '(No subject)';
  new Notification(name || address, {
    body: rest.length > 0 ? `${subject} — and ${rest.length} more` : subject,
  });
}

/** Bridges Rust events onto TanStack Query invalidation and the Zustand
 * stores that mirror queue/sync state. This is the ONLY place allowed to
 * invalidate queries or push store updates from IPC events — components
 * must never invalidate/refetch by hand (see CLAUDE.md). */
export function EventBridge() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void | Promise<void>> = [];
    const traversalAccounts = new Set<string>();
    let traversalTimer: number | undefined;
    const subscribe = <E extends keyof IpcEventMap>(
      event: E,
      handler: (payload: IpcEventMap[E]) => void,
    ) => {
      // Rust logs every event it emits; logging arrival here is what makes
      // "emitted but never delivered to the UI" distinguishable from "never
      // emitted". `queue://summary` is skipped for the same volume reason it
      // is skipped on the Rust side.
      const logged = (payload: IpcEventMap[E]) => {
        if (event !== 'queue://summary') appLog.info(`event ${event} ${JSON.stringify(payload)}`);
        handler(payload);
      };
      void listen(event, logged).then((remove) => {
        if (disposed) void remove();
        else unlistens.push(remove);
      });
    };

    subscribe('queue://summary', (summary) => {
      useSyncStore.getState().setQueue(summary);
    });

    subscribe('sync://progress', (progress) => {
      useSyncStore.setState({ syncState: progress.state });
    });

    subscribe('sync://traversal', (progress) => {
      traversalAccounts.add(progress.accountId);
      if (traversalTimer !== undefined) return;
      traversalTimer = window.setTimeout(() => {
        traversalAccounts.forEach((accountId) => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.threadsForAccount(accountId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.traversalStatus(accountId) });
        });
        traversalAccounts.clear();
        traversalTimer = undefined;
      }, 250);
    });

    // Diagnostic for "Rust delivered it, the list did not move": reports
    // which thread queries the invalidation key actually matched and how many
    // rows each held, before and after the refetch settles. No matching
    // entry means the key is wrong; an unchanged count means the refetch
    // returned the same rows; a changed count means the problem is downstream
    // in rendering.
    const logThreadCache = (accountId: string, when: string) => {
      const entries = queryClient.getQueriesData<{ pages: Array<{ items: unknown[] }> }>({
        queryKey: queryKeys.threadsForAccount(accountId),
      });
      const summary = entries
        .map(
          ([key, data]) =>
            `${JSON.stringify(key)}=${(data?.pages ?? []).reduce((total, page) => total + page.items.length, 0)}`,
        )
        .join(' ');
      appLog.info(`threads cache ${when}: ${summary || '(no query matched this key)'}`);
    };

    subscribe('sync://complete', (event) => {
      useSyncStore.setState({ syncState: 'idle', lastSynced: new Date(), error: undefined });
      if (!event.changed) return;
      // Threads, label counts and the seeded sync status all changed —
      // refresh the visible list without a manual reload (acceptance
      // criterion 7).
      logThreadCache(event.accountId, 'before sync://complete invalidate');
      void queryClient
        .invalidateQueries({ queryKey: queryKeys.threadsForAccount(event.accountId) })
        .then(() => logThreadCache(event.accountId, 'after sync://complete invalidate'));
      void queryClient.invalidateQueries({ queryKey: queryKeys.labels(event.accountId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus(event.accountId) });
    });

    subscribe('mail://new', (event) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(event.accountId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.labels(event.accountId) });
      void notifyArrivals(event.arrivals);
    });

    subscribe('send://uncertain', () => {
      useToastStore.getState().showError('Send status unknown — check Sent and Drafts.');
    });
    subscribe('draft://saved', (event) => {
      const session = useComposeStore.getState().session;
      if (session?.id === event.sessionId) {
        useComposeStore.getState().setDraftId(event.draftId);
        useComposeStore.getState().markSaved();
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(event.accountId),
      });
    });
    subscribe('send://complete', (event) => {
      useToastStore.getState().showSuccess('Message sent.');
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(event.accountId),
      });
    });

    // The composer closes on queue acceptance, not on delivery, so a
    // failure that happens after it closed has nowhere to render but a
    // toast; while the same session is still open it belongs inline.
    subscribe('compose://failed', (event) => {
      const compose = useComposeStore.getState();
      if (compose.session?.id === event.sessionId || compose.session?.draftId === event.sessionId) {
        // The footer's status region is narrow and sits beside the Send
        // control, so inline failures carry the wireframe's fixed copy
        // rather than a server message of unbounded length.
        compose.setDraftStatus(
          'failed',
          event.kind === 'send' ? 'Couldn’t send.' : 'Couldn’t save draft.',
        );
        return;
      }
      // The raw Gmail error is unbounded and not written for end users, so it
      // goes to the log and the toast carries the human message.
      appLog.error(`compose ${event.kind} failed: ${event.error}`);
      useToastStore
        .getState()
        .showError(event.kind === 'send' ? 'Couldn’t send your message.' : 'Couldn’t save draft.');
    });

    subscribe('queue://item', (item) => {
      // Only terminal statuses. `queued`/`active` arrive *before* the flush
      // has written anything to SQLite, so invalidating on them refetched the
      // pre-mutation row and visibly reverted the optimistic update for the
      // length of the Gmail round trip.
      if (item.status !== 'done' && item.status !== 'failed') return;
      if (!item.id.startsWith('mutation:')) return;
      const accountId = item.id.split(':')[1];
      if (accountId)
        void queryClient.invalidateQueries({ queryKey: queryKeys.threadsForAccount(accountId) });
    });

    subscribe('avatar://resolved', (event) => {
      void queryClient.invalidateQueries({
        queryKey:
          event.pipeline === 'sender'
            ? queryKeys.senderAvatar(event.key)
            : queryKeys.accountAvatar(event.key),
      });
    });

    subscribe('account://state', () => {
      // Without this, the reauth banner (which renders off the accounts
      // query) would not appear live until something else happened to
      // refetch accounts — this is what makes a token-refresh failure show
      // up without any other user action (acceptance criterion 10).
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
    });

    return () => {
      disposed = true;
      if (traversalTimer !== undefined) window.clearTimeout(traversalTimer);
      unlistens.forEach((remove) => void remove());
    };
  }, [queryClient]);
  return null;
}
