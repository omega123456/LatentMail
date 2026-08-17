import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { ReauthBanner } from '@/components/auth/ReauthBanner';
import { ComposeOverlay } from '@/components/compose/ComposeOverlay';
import { ConversationListContainer } from '@/components/list/ConversationList';
import { ListHeader } from '@/components/list/ListHeader';
import {
  useCreateLabelMutation,
  useDeleteLabelMutation,
  useLabelsQuery,
  useRecolorLabelMutation,
  useRenameLabelMutation,
  useConversationQuery,
} from '@/lib/query/hooks';
import { mapConversation, mapLabelsToMailboxes, mapLabelsToUserLabels } from '@/lib/query/mappers';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import type { Account } from '@/lib/types/ipc';
import { AccountSwitcher } from '@/components/sidebar/AccountSwitcher';
import { CollapsedRail } from '@/components/sidebar/CollapsedRail';
import { FolderList } from '@/components/sidebar/FolderList';
import { LabelList } from '@/components/sidebar/LabelList';
import { Mail, PanelLeftClose, Pencil, Settings } from 'lucide-react';
import { ResizeHandle } from './ResizeHandle';
import { ReadingPaneContainer } from '@/components/reader/ReadingPane';
import { StatusBar } from '@/components/statusbar/StatusBar';
import { openEditDraft, openForward, openNewMessage, openReply } from '@/lib/compose/entry';
import { useCommands } from '@/lib/keyboard/useCommands';
import { selectIsMultiSelectActive, useMultiSelectStore } from '@/stores/multi-select';
import { useComposeStore } from '@/stores/compose';

const navItem =
  'flex cursor-pointer items-center gap-3 rounded px-3 py-2 text-body-md text-on-surface-variant hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container';
export function MailLayout({ accounts }: { accounts: Account[] }) {
  const shell = useRef<HTMLDivElement>(null);
  const {
    layout,
    density,
    sidebarCollapsed,
    sidebarWidth,
    listWidth,
    readerHeight,
    showUnreadCounts,
    setSidebarCollapsed,
    setSidebarWidth,
    setListWidth,
    setReaderHeight,
  } = useLayoutStore();
  const {
    activeThreadId,
    activeMailboxId,
    activeAccountId,
    setActiveMailboxId,
    setActiveAccountId,
    clearSelection,
  } = useSelectionStore();
  const flaggedAccount = accounts.find((account) => account.needsReauthentication);
  const hasReader =
    layout === 'three-column' || (layout === 'bottom-preview' && activeThreadId !== null);
  const setPane = (
    key: '--sidebar-w' | '--list-w' | '--reader-h',
    value: number,
    update: (value: number) => void,
  ) => {
    shell.current?.style.setProperty(key, key === '--reader-h' ? `${value}%` : `${value}px`);
    update(value);
  };
  const labelsQuery = useLabelsQuery(activeAccountId);
  const keyboardConversation = useConversationQuery(activeAccountId, activeThreadId);
  const keyboardMultiSelect = useMultiSelectStore(selectIsMultiSelectActive);
  const mailboxes = mapLabelsToMailboxes(labelsQuery.data ?? []);
  const labels = mapLabelsToUserLabels(labelsQuery.data ?? []);
  const createLabelMutation = useCreateLabelMutation(activeAccountId);
  const renameLabelMutation = useRenameLabelMutation(activeAccountId);
  const recolorLabelMutation = useRecolorLabelMutation(activeAccountId);
  const deleteLabelMutation = useDeleteLabelMutation(activeAccountId);
  const activeMailbox = activeMailboxId ?? 'INBOX';
  const activeAccount = accounts.find((account) => account.id === activeAccountId);
  const compose = useCallback(() => {
    if (activeAccount) openNewMessage(activeAccount.id, activeAccount.email);
  }, [activeAccount]);
  const composeTarget = useCallback(
    (action: 'reply' | 'reply-all' | 'forward' | 'edit-draft') => {
      if (!activeAccount || keyboardMultiSelect || !keyboardConversation.data) return;
      const labels = new Map((labelsQuery.data ?? []).map((label) => [label.id, label.name]));
      const message = mapConversation(keyboardConversation.data, labels).messages.at(-1);
      if (!message) return;
      if (action === 'reply')
        void openReply('reply', activeAccount.id, activeAccount.email, message);
      else if (action === 'reply-all')
        void openReply('reply-all', activeAccount.id, activeAccount.email, message);
      else if (action === 'forward')
        void openForward(activeAccount.id, activeAccount.email, message);
      else if (message.isDraft)
        void openEditDraft(
          activeAccount.id,
          activeAccount.email,
          keyboardConversation.data.subject,
          message,
        );
    },
    [activeAccount, keyboardConversation.data, keyboardMultiSelect, labelsQuery.data],
  );
  useCommands({
    newMessage: (event) => {
      event.preventDefault();
      compose();
    },
    replyToMessage: (event) => {
      event.preventDefault();
      composeTarget('reply');
    },
    replyAllToMessage: (event) => {
      event.preventDefault();
      composeTarget('reply-all');
    },
    forwardMessage: (event) => {
      event.preventDefault();
      composeTarget('forward');
    },
    editDraft: (event) => {
      event.preventDefault();
      composeTarget('edit-draft');
    },
  });
  const mailboxName =
    mailboxes.find((mailbox) => mailbox.id === activeMailbox)?.name ??
    labels.find((label) => label.id === activeMailbox)?.name ??
    activeMailbox;
  const selectMailbox = (id: string) => setActiveMailboxId(id);
  const selectAccount = useCallback(
    (id: string) => {
      setActiveAccountId(id);
      setActiveMailboxId('INBOX');
      clearSelection();
    },
    [setActiveAccountId, setActiveMailboxId, clearSelection],
  );
  useEffect(() => {
    if (activeAccountId === null && accounts.length > 0) selectAccount(accounts[0].id);
  }, [accounts, activeAccountId, selectAccount]);
  useEffect(() => {
    if (!window.__LATENTMAIL_PLAYWRIGHT_IPC__) return;
    const session = window.__LATENTMAIL_PLAYWRIGHT_COMPOSE_SESSION__;
    if (session) useComposeStore.getState().open(session);
  }, []);
  const openSettings = () => useLayoutStore.getState().setRoute('settings');
  const sidebar = sidebarCollapsed ? (
    <CollapsedRail
      accounts={accounts}
      activeAccountId={activeAccountId}
      activeMailboxId={activeMailboxId ?? 'INBOX'}
      mailboxes={mailboxes}
      onSelectAccount={selectAccount}
      onSelectMailbox={selectMailbox}
      onExpand={() => setSidebarCollapsed(false)}
      onSettings={openSettings}
      onCompose={compose}
    />
  ) : (
    <aside
      data-testid="sidebar-slot"
      className="flex min-h-0 min-w-0 flex-col border-r border-outline-variant bg-background p-stack-gap-md dark:border-dark-outline-variant dark:bg-dark-background"
    >
      <div className="mb-8 flex items-center gap-3 px-2 text-primary dark:text-dark-primary">
        <Mail aria-hidden="true" size={30} />
        <span className="text-headline-md">LatentMail</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        <button
          type="button"
          title="Compose"
          onClick={compose}
          className="mb-8 flex cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 text-label-md text-on-primary shadow-sm focus-visible:outline-2 focus-visible:outline-primary dark:bg-dark-primary dark:text-dark-on-primary"
        >
          <Pencil aria-hidden="true" size={20} />
          Compose
        </button>
        <FolderList
          activeMailboxId={activeMailboxId ?? 'INBOX'}
          mailboxes={mailboxes}
          showUnreadCounts={showUnreadCounts}
          onSelect={selectMailbox}
        />
        <LabelList
          activeMailboxId={activeMailboxId}
          labels={labels}
          showUnreadCounts={showUnreadCounts}
          onSelect={selectMailbox}
          onCreateLabel={({ name, colorId }) => createLabelMutation.mutateAsync({ name, colorId })}
          onRenameLabel={({ id, name }) => renameLabelMutation.mutateAsync({ labelId: id, name })}
          onRecolorLabel={({ id, colorId }) =>
            recolorLabelMutation.mutateAsync({ labelId: id, colorId })
          }
          onDeleteLabel={(id) => deleteLabelMutation.mutateAsync({ labelId: id })}
        />
        <button
          type="button"
          aria-label="Collapse sidebar"
          onClick={() => setSidebarCollapsed(true)}
          className={`mt-auto ${navItem}`}
        >
          <PanelLeftClose aria-hidden="true" size={20} />
          Collapse
        </button>
        <button type="button" onClick={openSettings} className={navItem}>
          <Settings aria-hidden="true" size={20} />
          Settings
        </button>
      </div>
      <div className="mt-4 border-t border-outline-variant pt-4 dark:border-dark-outline-variant">
        <AccountSwitcher
          accounts={accounts}
          activeAccountId={activeAccountId}
          collapsed={false}
          onSelect={selectAccount}
        />
      </div>
    </aside>
  );
  const topBar = (
    <header className="h-16 shrink-0 border-b border-outline-variant/30 bg-surface-bright px-container-padding shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface" />
  );
  const list = (
    <section
      data-testid="list-slot"
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-outline-variant/40 bg-surface dark:border-dark-outline-variant dark:bg-dark-surface-container"
    >
      {flaggedAccount && <ReauthBanner accountId={flaggedAccount.id} />}
      <ListHeader mailboxName={mailboxName} />
      <ConversationListContainer />
    </section>
  );
  const reader = (
    <section
      data-testid="reader-slot"
      className="min-h-0 min-w-0 overflow-hidden bg-surface-bright dark:bg-dark-surface-container-high"
    >
      <ReadingPaneContainer threadId={activeThreadId} />
    </section>
  );
  const readerResize = (offset: number) =>
    setPane(
      '--reader-h',
      readerHeight + (offset / (shell.current?.clientHeight || 1)) * 100,
      setReaderHeight,
    );
  const body: ReactNode =
    layout === 'three-column' ? (
      <main
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: 'var(--list-w) auto 1fr' }}
      >
        {list}
        <ResizeHandle
          ariaLabel="Resize conversation list"
          orientation="vertical"
          onResize={(offset) => setPane('--list-w', listWidth + offset, setListWidth)}
        />
        {reader}
      </main>
    ) : layout === 'bottom-preview' && hasReader ? (
      <main
        className="grid min-h-0 flex-1"
        style={{ gridTemplateRows: '1fr auto var(--reader-h)' }}
      >
        {list}
        <ResizeHandle ariaLabel="Resize reader" orientation="horizontal" onResize={readerResize} />
        {reader}
      </main>
    ) : (
      <main className="flex min-h-0 flex-1 flex-col">{list}</main>
    );
  return (
    <div
      ref={shell}
      data-testid="mail-layout"
      data-layout={layout}
      data-density={density}
      style={
        {
          '--sidebar-w': sidebarCollapsed ? '56px' : `${sidebarWidth}px`,
          '--list-w': `${listWidth}px`,
          '--reader-h': `${readerHeight}%`,
        } as CSSProperties
      }
      className="grid h-screen grid-rows-app-shell overflow-hidden bg-surface dark:bg-dark-surface"
    >
      <div
        className="grid min-h-0"
        style={{
          gridTemplateColumns: sidebarCollapsed
            ? 'var(--sidebar-w) 1fr'
            : 'var(--sidebar-w) auto 1fr',
        }}
      >
        {sidebar}
        {!sidebarCollapsed && (
          <ResizeHandle
            ariaLabel="Resize sidebar"
            orientation="vertical"
            onResize={(offset) => setPane('--sidebar-w', sidebarWidth + offset, setSidebarWidth)}
          />
        )}
        <div className="flex min-h-0 min-w-0 flex-col">
          {topBar}
          {body}
        </div>
      </div>
      <StatusBar accountCount={accounts.length} accountId={activeAccountId} />
      <ComposeOverlay />
    </div>
  );
}
