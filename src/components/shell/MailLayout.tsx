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
  useSearchThreadsQuery,
} from '@/lib/query/hooks';
import { mapConversation, mapLabelsToMailboxes, mapLabelsToUserLabels } from '@/lib/query/mappers';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import type { Account } from '@/lib/types/ipc';
import { AccountSwitcher } from '@/components/sidebar/AccountSwitcher';
import { CollapsedRail } from '@/components/sidebar/CollapsedRail';
import { FolderList } from '@/components/sidebar/FolderList';
import { LabelList } from '@/components/sidebar/LabelList';
import { PanelLeftClose, Pencil, Settings } from 'lucide-react';
import brandMark from '@/assets/brand-mark.png';
import { ResizeHandle } from './ResizeHandle';
import { ReadingPaneContainer } from '@/components/reader/ReadingPane';
import { StatusBar } from '@/components/statusbar/StatusBar';
import { openEditDraft, openForward, openNewMessage, openReply } from '@/lib/compose/entry';
import { useCommands } from '@/lib/keyboard/useCommands';
import { selectIsMultiSelectActive, useMultiSelectStore } from '@/stores/multi-select';
import { useComposeStore } from '@/stores/compose';
import { useSearchStore } from '@/stores/search';
import { SearchField } from '@/components/search/SearchField';
import { SearchResultsRow } from '@/components/sidebar/SearchResultsRow';
import { navRow } from '@/components/sidebar/rowStyles';

const navItem = navRow(false);
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
  const searchActive = useSearchStore((state) => state.active);
  const searchSubmittedQuery = useSearchStore((state) => state.submittedQuery);
  const searchScope = useSearchStore((state) => state.scope);
  const searchClear = useSearchStore((state) => state.clear);
  const searchResults = useSearchThreadsQuery(activeAccountId, searchSubmittedQuery, searchScope);
  const searchTotal = searchResults.data?.pages.at(-1)?.total ?? 0;
  const searchFieldRef = useRef<HTMLInputElement>(null);
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
      const message = mapConversation(keyboardConversation.data).messages.at(-1);
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
    [activeAccount, keyboardConversation.data, keyboardMultiSelect],
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
    focusSearch: (event) => {
      event.preventDefault();
      searchFieldRef.current?.focus();
    },
  });
  const mailboxName =
    mailboxes.find((mailbox) => mailbox.id === activeMailbox)?.name ??
    labels.find((label) => label.id === activeMailbox)?.name ??
    activeMailbox;
  const clearSearchAndFocus = () => {
    searchClear();
    searchFieldRef.current?.focus();
  };
  const selectMailbox = (id: string) => {
    searchClear();
    setActiveMailboxId(id);
  };
  const selectAccount = useCallback(
    (id: string) => {
      searchClear();
      setActiveAccountId(id);
      setActiveMailboxId('INBOX');
      clearSelection();
    },
    [searchClear, setActiveAccountId, setActiveMailboxId, clearSelection],
  );
  useEffect(() => {
    if (accounts.length === 0) return;
    const activeAccountStillExists = accounts.some((account) => account.id === activeAccountId);
    if (activeAccountId === null || !activeAccountStillExists) selectAccount(accounts[0].id);
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
      searchActive={searchActive}
      searchQuery={searchSubmittedQuery}
    />
  ) : (
    <aside
      data-testid="sidebar-slot"
      className="flex min-h-0 min-w-0 flex-col border-r border-outline-variant bg-surface-container-low p-stack-gap-md dark:border-dark-outline-variant dark:bg-dark-surface-container-low"
    >
      <div className="mb-5 flex items-center gap-stack-gap-sm px-2 text-on-surface dark:text-dark-on-surface">
        <img src={brandMark} alt="" aria-hidden="true" className="h-4 w-auto" />
        <span className="text-body-md font-semibold">LatentMail</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        <button
          type="button"
          title="Compose"
          onClick={compose}
          className="mb-4 flex cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-label-md text-on-primary shadow-sm focus-visible:outline-2 focus-visible:outline-primary dark:bg-dark-primary dark:text-dark-on-primary"
        >
          <Pencil aria-hidden="true" size={16} />
          Compose
        </button>
        {searchActive && (
          <SearchResultsRow
            query={searchSubmittedQuery}
            total={searchTotal}
            pending={searchResults.isLoading}
            onClose={clearSearchAndFocus}
          />
        )}
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
          <PanelLeftClose aria-hidden="true" size={18} />
          Collapse
        </button>
        <button type="button" onClick={openSettings} className={navItem}>
          <Settings aria-hidden="true" size={18} />
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
    <header className="flex h-16 shrink-0 items-center border-b border-outline-variant/30 bg-surface-bright px-container-padding shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface">
      <SearchField ref={searchFieldRef} labels={labelsQuery.data ?? []} />
    </header>
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
      className="grid h-full grid-rows-app-shell overflow-hidden bg-surface dark:bg-dark-surface"
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
      <StatusBar accountId={activeAccountId} />
      <ComposeOverlay />
    </div>
  );
}
