import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
} from 'react';
import { ReauthBanner } from '@/components/auth/ReauthBanner';
import { DelayedFallback, lazyWithDelayedFallback } from '@/components/states/DelayedFallback';
import { ConversationListContainer } from '@/components/list/ConversationList';
import { ListHeader } from '@/components/list/ListHeader';
import {
  useAiConfigsQuery,
  useAiConnectionQuery,
  useLabelsQuery,
  useConversationQuery,
  useSearchTotalQuery,
  useSearchThreadsQuery,
} from '@/lib/query/hooks';
import {
  useCreateLabelMutation,
  useDeleteLabelMutation,
  useRecolorLabelMutation,
  useRenameLabelMutation,
} from '@/lib/query/mutations';
import { mapConversation, mapLabelsToMailboxes, mapLabelsToUserLabels } from '@/lib/query/mappers';
import { ASSISTANT_DOCK_MIN_SHELL_WIDTH, useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import type { Account } from '@/lib/types/ipc';
import { AccountSwitcher } from '@/components/sidebar/AccountSwitcher';
import { CollapsedRail } from '@/components/sidebar/CollapsedRail';
import { FolderList } from '@/components/sidebar/FolderList';
import { LabelList } from '@/components/sidebar/LabelList';
import { PanelLeftClose, Pencil, Settings, Sparkles } from 'lucide-react';
import brandMark from '@/assets/brand-mark.png';
import { ResizeHandle } from './ResizeHandle';
import { MessageSourceDialog } from '@/components/reader/MessageSourceDialog';
import { ReadingPaneContainer } from '@/components/reader/ReadingPane';
import { StatusBar } from '@/components/statusbar/StatusBar';
import { openComposeAction, openNewMessage, type ComposeAction } from '@/lib/compose/entry';
import { useCommands } from '@/lib/keyboard/useCommands';
import { selectIsMultiSelectActive, useMultiSelectStore } from '@/stores/multi-select';
import { useComposeStore } from '@/stores/compose';
import { useMessageSourceStore } from '@/stores/message-source';
import { useSearchStore } from '@/stores/search';
import { SearchField } from '@/components/search/SearchField';
import { SearchResultsRow } from '@/components/sidebar/SearchResultsRow';
import { navRow } from '@/components/sidebar/rowStyles';
import { AssistantPanel } from '@/components/ai-chat/AssistantPanel';
import { useSettingsUiStore } from '@/stores/settings-ui';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { percentOf } from '@/lib/format/percent';

const navItem = navRow(false);

function AccountConnectionPoll({ accountId }: { accountId: string }) {
  useAiConnectionQuery(accountId);
  return null;
}
const ComposeOverlay = lazyWithDelayedFallback(() =>
  import('@/components/compose/ComposeOverlay').then(({ ComposeOverlay }) => ({
    default: ComposeOverlay,
  })),
);

function ComposeFallback() {
  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 z-40 bg-on-background/20 dark:bg-dark-on-background/20"
    >
      <div className="fixed bottom-container-padding right-container-padding z-50 h-compose-h w-compose-w rounded-lg border border-outline-variant bg-surface-container-lowest shadow-lg dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest" />
    </div>
  );
}
function MailWorkspaceBody({
  layout,
  hasReader,
  assistantDocked,
  assistantOpen,
  list,
  reader,
  dockedAssistant,
  onResizeList,
  onResizeAssistant,
  onResizeReader,
}: {
  layout: string;
  hasReader: boolean;
  assistantDocked: boolean;
  assistantOpen: boolean;
  list: ReactNode;
  reader: ReactNode;
  dockedAssistant: ReactNode;
  onResizeList: (offset: number) => void;
  onResizeAssistant: (offset: number) => void;
  onResizeReader: (offset: number) => void;
}) {
  if (layout === 'three-column') {
    const showDockedAssistant = assistantDocked && assistantOpen;
    return (
      <main
        className="grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: showDockedAssistant
            ? 'var(--list-w) auto 1fr auto var(--assistant-w)'
            : 'var(--list-w) auto 1fr',
        }}
      >
        {list}
        <ResizeHandle
          ariaLabel="Resize conversation list"
          orientation="vertical"
          onResize={onResizeList}
        />
        {reader}
        {showDockedAssistant && (
          <ResizeHandle
            ariaLabel="Resize AI assistant"
            orientation="vertical"
            onResize={onResizeAssistant}
          />
        )}
        {assistantDocked && dockedAssistant}
      </main>
    );
  }
  if (layout === 'bottom-preview' && hasReader) {
    return (
      <main
        className="grid min-h-0 flex-1"
        style={{ gridTemplateRows: '1fr auto var(--reader-h)' }}
      >
        {list}
        <ResizeHandle
          ariaLabel="Resize reader"
          orientation="horizontal"
          onResize={onResizeReader}
        />
        {reader}
      </main>
    );
  }
  return <main className="flex min-h-0 flex-1 flex-col">{list}</main>;
}

function resolveMailboxName(
  mailboxes: { id: string; name: string }[],
  labels: { id: string; name: string }[],
  activeMailbox: string,
): string {
  const folder = mailboxes.find((mailbox) => mailbox.id === activeMailbox);
  if (folder) return folder.name;
  const userLabel = labels.find((label) => label.id === activeMailbox);
  return userLabel ? userLabel.name : activeMailbox;
}

function MailSidebarRegion({
  sidebarCollapsed,
  accounts,
  activeAccountId,
  activeMailboxId,
  mailboxes,
  labels,
  showUnreadCounts,
  searchActive,
  searchSubmittedQuery,
  searchTotal,
  searchLoading,
  onSelectAccount,
  onSelectMailbox,
  onToggleCollapse,
  onOpenSettings,
  onCompose,
  onClearSearchAndFocus,
  onCreateLabel,
  onRenameLabel,
  onRecolorLabel,
  onDeleteLabel,
}: {
  sidebarCollapsed: boolean;
  accounts: Account[];
  activeAccountId: string | null;
  activeMailboxId: string | null;
  mailboxes: ReturnType<typeof mapLabelsToMailboxes>;
  labels: ReturnType<typeof mapLabelsToUserLabels>;
  showUnreadCounts: boolean;
  searchActive: boolean;
  searchSubmittedQuery: string;
  searchTotal: number;
  searchLoading: boolean;
  onSelectAccount: (id: string) => void;
  onSelectMailbox: (id: string) => void;
  onToggleCollapse: (collapsed: boolean) => void;
  onOpenSettings: () => void;
  onCompose: () => void;
  onClearSearchAndFocus: () => void;
  onCreateLabel: (input: { name: string; colorId: string | null }) => Promise<unknown>;
  onRenameLabel: (input: { id: string; name: string }) => Promise<unknown>;
  onRecolorLabel: (input: { id: string; colorId: string }) => Promise<unknown>;
  onDeleteLabel: (id: string) => Promise<unknown>;
}) {
  if (sidebarCollapsed) {
    return (
      <CollapsedRail
        accounts={accounts}
        activeAccountId={activeAccountId}
        activeMailboxId={activeMailboxId ?? 'INBOX'}
        mailboxes={mailboxes}
        labels={labels}
        onSelectAccount={onSelectAccount}
        onSelectMailbox={onSelectMailbox}
        onExpand={() => onToggleCollapse(false)}
        onSettings={onOpenSettings}
        onCompose={onCompose}
        searchActive={searchActive}
        searchQuery={searchSubmittedQuery}
      />
    );
  }
  return (
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
          onClick={onCompose}
          className="mb-4 flex cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-label-md text-on-primary shadow-sm focus-visible:outline-2 focus-visible:outline-primary dark:bg-dark-primary dark:text-dark-on-primary"
        >
          <Pencil aria-hidden="true" size={ICON_SIZE.base} />
          Compose
        </button>
        {searchActive && (
          <SearchResultsRow
            query={searchSubmittedQuery}
            total={searchTotal}
            pending={searchLoading}
            onClose={onClearSearchAndFocus}
          />
        )}
        <FolderList
          activeMailboxId={activeMailboxId ?? 'INBOX'}
          mailboxes={mailboxes}
          showUnreadCounts={showUnreadCounts}
          onSelect={onSelectMailbox}
        />
        <LabelList
          activeMailboxId={activeMailboxId}
          labels={labels}
          showUnreadCounts={showUnreadCounts}
          onSelect={onSelectMailbox}
          onCreateLabel={onCreateLabel}
          onRenameLabel={onRenameLabel}
          onRecolorLabel={onRecolorLabel}
          onDeleteLabel={onDeleteLabel}
        />
        <button
          type="button"
          aria-label="Collapse sidebar"
          onClick={() => onToggleCollapse(true)}
          className={`mt-auto ${navItem}`}
        >
          <PanelLeftClose aria-hidden="true" size={ICON_SIZE.lg} />
          Collapse
        </button>
        <button type="button" onClick={onOpenSettings} className={navItem}>
          <Settings aria-hidden="true" size={ICON_SIZE.lg} />
          Settings
        </button>
      </div>
      <div className="mt-4 border-t border-outline-variant pt-4 dark:border-dark-outline-variant">
        <AccountSwitcher
          accounts={accounts}
          activeAccountId={activeAccountId}
          collapsed={false}
          onSelect={onSelectAccount}
        />
      </div>
    </aside>
  );
}

function AssistantRegionView({
  docked,
  assistantOpen,
  assistantRegion,
  keepFocusOutWhileClosed,
  children,
}: {
  docked: boolean;
  assistantOpen: boolean;
  assistantRegion: React.RefObject<HTMLDivElement | null>;
  keepFocusOutWhileClosed: (event: FocusEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  if (docked) {
    return (
      <div
        ref={assistantRegion}
        data-testid="assistant-docked"
        hidden={!assistantOpen}
        inert={!assistantOpen}
        onFocusCapture={keepFocusOutWhileClosed}
        className={
          assistantOpen
            ? 'grid min-h-0 min-w-0 border-l border-outline-variant dark:border-dark-outline-variant'
            : 'hidden'
        }
      >
        {children}
      </div>
    );
  }
  return (
    <>
      {assistantOpen && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 bg-on-surface/20 dark:bg-dark-on-surface/20"
        />
      )}
      <div
        ref={assistantRegion}
        data-testid="assistant-drawer"
        hidden={!assistantOpen}
        inert={!assistantOpen}
        onFocusCapture={keepFocusOutWhileClosed}
        style={{ width: 'var(--assistant-w)' }}
        className={
          assistantOpen
            ? 'absolute inset-y-0 right-0 z-20 grid min-h-0 border-l border-outline-variant shadow-lg dark:border-dark-outline-variant'
            : 'hidden'
        }
      >
        {children}
      </div>
    </>
  );
}

function MailTopBar({
  searchFieldRef,
  labels,
  assistantTrigger,
  assistantOpen,
  onToggleAssistant,
}: {
  searchFieldRef: React.RefObject<HTMLInputElement | null>;
  labels: import('@/lib/types/ipc').MailLabel[];
  assistantTrigger: React.RefObject<HTMLButtonElement | null>;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
}) {
  const buttonTone = assistantOpen
    ? 'bg-primary-fixed text-primary dark:bg-dark-primary-fixed dark:text-dark-primary'
    : 'text-on-surface-variant hover:bg-surface-container dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container';
  return (
    <header className="flex h-16 shrink-0 items-center border-b border-outline-variant/30 bg-surface-bright px-container-padding shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface">
      <SearchField ref={searchFieldRef} labels={labels} />
      <button
        ref={assistantTrigger}
        type="button"
        aria-label="AI assistant"
        aria-expanded={assistantOpen}
        title="AI assistant"
        onClick={onToggleAssistant}
        className={`ml-2 grid size-9 shrink-0 cursor-pointer place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-primary ${buttonTone}`}
      >
        <Sparkles aria-hidden="true" size={ICON_SIZE.lg} />
      </button>
    </header>
  );
}

function useShellWidth(shellRef: React.RefObject<HTMLDivElement | null>): number {
  const [shellWidth, setShellWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const node = shellRef.current;
    if (node === null) return;
    const observer = new ResizeObserver((entries) =>
      setShellWidth(entries[0]?.contentRect.width ?? Number.POSITIVE_INFINITY),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [shellRef]);
  return shellWidth;
}

function useEnsureActiveAccount(
  accounts: Account[],
  activeAccountId: string | null,
  selectAccount: (id: string) => void,
) {
  useEffect(() => {
    if (accounts.length === 0) return;
    const activeAccountStillExists = accounts.some((account) => account.id === activeAccountId);
    if (activeAccountId === null || !activeAccountStillExists) selectAccount(accounts[0].id);
  }, [accounts, activeAccountId, selectAccount]);
}

function EnabledAiPolls() {
  const aiConfigs = useAiConfigsQuery();
  return (aiConfigs.data ?? [])
    .filter((config) => config.enabled)
    .map((config) => <AccountConnectionPoll key={config.accountId} accountId={config.accountId} />);
}

function ComposeLayer({ open }: { open: boolean }) {
  if (!open) return null;
  return (
    <Suspense
      fallback={
        <DelayedFallback>
          <ComposeFallback />
        </DelayedFallback>
      }
    >
      <ComposeOverlay />
    </Suspense>
  );
}

function shellPaneVars(
  sidebarCollapsed: boolean,
  sidebarWidth: number,
  listWidth: number,
  readerHeight: number,
  assistantWidth: number,
): CSSProperties {
  return {
    '--sidebar-w': sidebarCollapsed ? '56px' : `${sidebarWidth}px`,
    '--list-w': `${listWidth}px`,
    '--reader-h': `${readerHeight}%`,
    '--assistant-w': `${assistantWidth}px`,
  } as CSSProperties;
}

function sidebarGridColumns(sidebarCollapsed: boolean): string {
  return sidebarCollapsed ? 'var(--sidebar-w) 1fr' : 'var(--sidebar-w) auto 1fr';
}

function hasReaderPane(layout: string, activeThreadId: string | null): boolean {
  return layout === 'three-column' || (layout === 'bottom-preview' && activeThreadId !== null);
}

export function MailLayout({ accounts }: { accounts: Account[] }) {
  const shell = useRef<HTMLDivElement>(null);
  const {
    layout,
    density,
    sidebarCollapsed,
    sidebarWidth,
    listWidth,
    readerHeight,
    assistantWidth,
    assistantOpen,
    showUnreadCounts,
    setSidebarCollapsed,
    setSidebarWidth,
    setListWidth,
    setReaderHeight,
    setAssistantOpen,
    setAssistantWidth,
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
  const hasReader = hasReaderPane(layout, activeThreadId);
  const setPane = (
    key: '--sidebar-w' | '--list-w' | '--reader-h' | '--assistant-w',
    size: number,
    update: (size: number) => void,
  ) => {
    shell.current?.style.setProperty(key, key === '--reader-h' ? `${size}%` : `${size}px`);
    update(size);
  };
  const labelsQuery = useLabelsQuery(activeAccountId);
  const keyboardConversation = useConversationQuery(activeAccountId, activeThreadId);
  const keyboardMultiSelect = useMultiSelectStore(selectIsMultiSelectActive);
  const searchActive = useSearchStore((search) => search.active);
  const searchSubmittedQuery = useSearchStore((search) => search.submittedQuery);
  const searchScope = useSearchStore((search) => search.scope);
  const searchClear = useSearchStore((search) => search.clear);
  const searchResults = useSearchThreadsQuery(activeAccountId, searchSubmittedQuery, searchScope);
  const searchTotalQuery = useSearchTotalQuery(activeAccountId, searchSubmittedQuery, searchScope);
  const searchTotal = searchTotalQuery.data ?? 0;
  const searchFieldRef = useRef<HTMLInputElement>(null);
  const assistantTrigger = useRef<HTMLButtonElement>(null);
  const assistantRegion = useRef<HTMLDivElement>(null);
  const shellWidth = useShellWidth(shell);
  const assistantDocked = layout === 'three-column' && shellWidth >= ASSISTANT_DOCK_MIN_SHELL_WIDTH;
  const closeAssistant = useCallback(() => {
    setAssistantOpen(false);
    assistantTrigger.current?.focus();
  }, [setAssistantOpen]);
  const toggleAssistant = useCallback(() => {
    if (useLayoutStore.getState().assistantOpen) {
      closeAssistant();
      return;
    }
    setAssistantOpen(true);
  }, [closeAssistant, setAssistantOpen]);
  const openAiSettings = useCallback(() => {
    useSettingsUiStore.getState().setActiveSection('ai');
    useLayoutStore.getState().setRoute('settings');
  }, []);
  useEffect(() => {
    if (assistantOpen) assistantRegion.current?.querySelector('textarea')?.focus();
  }, [assistantOpen]);
  const rawLabels = labelsQuery.data ?? [];
  const mailboxes = mapLabelsToMailboxes(rawLabels);
  const labels = mapLabelsToUserLabels(rawLabels);
  const createLabelMutation = useCreateLabelMutation(activeAccountId);
  const renameLabelMutation = useRenameLabelMutation(activeAccountId);
  const recolorLabelMutation = useRecolorLabelMutation(activeAccountId);
  const deleteLabelMutation = useDeleteLabelMutation(activeAccountId);
  const activeMailbox = activeMailboxId ?? 'INBOX';
  const activeAccount = accounts.find((account) => account.id === activeAccountId);
  const compose = useCallback(() => {
    if (activeAccount) openNewMessage(activeAccount.id, activeAccount.email);
  }, [activeAccount]);
  const composeOpen = useComposeStore((composeState) => composeState.session !== null);
  const composeTarget = useCallback(
    (action: ComposeAction) => {
      if (!activeAccount || keyboardMultiSelect || !keyboardConversation.data) return;
      void openComposeAction({
        action: action,
        accountId: activeAccount.id,
        accountEmail: activeAccount.email,
        subject: keyboardConversation.data.subject,
        message: mapConversation(keyboardConversation.data).messages.at(-1),
        requireDraftFlag: true,
      });
    },
    [activeAccount, keyboardConversation.data, keyboardMultiSelect],
  );
  const showOriginal = useCallback(() => {
    if (!activeAccount || keyboardMultiSelect || !keyboardConversation.data) return;
    const message = keyboardConversation.data.messages.at(-1);
    if (!message || message.labelIds.includes('DRAFT')) return;
    useMessageSourceStore.getState().open({ accountId: activeAccount.id, messageId: message.id });
  }, [activeAccount, keyboardConversation.data, keyboardMultiSelect]);
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
    toggleAssistant: (event) => {
      event.preventDefault();
      toggleAssistant();
    },
    showOriginal: (event) => {
      event.preventDefault();
      showOriginal();
    },
  });
  const mailboxName = resolveMailboxName(mailboxes, labels, activeMailbox);
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
  useEnsureActiveAccount(accounts, activeAccountId, selectAccount);
  const openSettings = () => useLayoutStore.getState().setRoute('settings');
  const sidebar = (
    <MailSidebarRegion
      sidebarCollapsed={sidebarCollapsed}
      accounts={accounts}
      activeAccountId={activeAccountId}
      activeMailboxId={activeMailboxId}
      mailboxes={mailboxes}
      labels={labels}
      showUnreadCounts={showUnreadCounts}
      searchActive={searchActive}
      searchSubmittedQuery={searchSubmittedQuery}
      searchTotal={searchTotal}
      searchLoading={searchResults.isLoading}
      onSelectAccount={selectAccount}
      onSelectMailbox={selectMailbox}
      onToggleCollapse={setSidebarCollapsed}
      onOpenSettings={openSettings}
      onCompose={compose}
      onClearSearchAndFocus={clearSearchAndFocus}
      onCreateLabel={({ name, colorId }) => createLabelMutation.mutateAsync({ name, colorId })}
      onRenameLabel={({ id, name }) => renameLabelMutation.mutateAsync({ labelId: id, name: name })}
      onRecolorLabel={({ id, colorId }) =>
        recolorLabelMutation.mutateAsync({ labelId: id, colorId: colorId })
      }
      onDeleteLabel={(id) => deleteLabelMutation.mutateAsync({ labelId: id })}
    />
  );
  const topBar = (
    <MailTopBar
      searchFieldRef={searchFieldRef}
      labels={rawLabels}
      assistantTrigger={assistantTrigger}
      assistantOpen={assistantOpen}
      onToggleAssistant={toggleAssistant}
    />
  );
  const assistant = activeAccountId !== null && (
    <AssistantPanel
      accountId={activeAccountId}
      onClose={closeAssistant}
      onOpenAiSettings={openAiSettings}
    />
  );
  const keepFocusOutWhileClosed = (event: FocusEvent<HTMLDivElement>) => {
    if (!assistantOpen) event.target.blur();
  };
  const dockedAssistant = (
    <AssistantRegionView
      docked
      assistantOpen={assistantOpen}
      assistantRegion={assistantRegion}
      keepFocusOutWhileClosed={keepFocusOutWhileClosed}
    >
      {assistant}
    </AssistantRegionView>
  );
  const drawerAssistant = (
    <AssistantRegionView
      docked={false}
      assistantOpen={assistantOpen}
      assistantRegion={assistantRegion}
      keepFocusOutWhileClosed={keepFocusOutWhileClosed}
    >
      {assistant}
    </AssistantRegionView>
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
      readerHeight - percentOf(offset, shell.current?.clientHeight || 1),
      setReaderHeight,
    );
  const body = (
    <MailWorkspaceBody
      layout={layout}
      hasReader={hasReader}
      assistantDocked={assistantDocked}
      assistantOpen={assistantOpen}
      list={list}
      reader={reader}
      dockedAssistant={dockedAssistant}
      onResizeList={(offset) => setPane('--list-w', listWidth + offset, setListWidth)}
      onResizeAssistant={(offset) =>
        setPane('--assistant-w', assistantWidth - offset, setAssistantWidth)
      }
      onResizeReader={readerResize}
    />
  );
  return (
    <div
      ref={shell}
      data-testid="mail-layout"
      data-layout={layout}
      data-density={density}
      style={shellPaneVars(sidebarCollapsed, sidebarWidth, listWidth, readerHeight, assistantWidth)}
      className="grid h-full grid-rows-app-shell overflow-hidden bg-surface dark:bg-dark-surface"
    >
      <div
        className="grid min-h-0"
        style={{
          gridTemplateColumns: sidebarGridColumns(sidebarCollapsed),
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
          <div className="relative flex min-h-0 flex-1 flex-col">
            {body}
            {!assistantDocked && drawerAssistant}
          </div>
        </div>
      </div>
      <StatusBar accountId={activeAccountId} />
      <EnabledAiPolls />
      <ComposeLayer open={composeOpen} />
      <MessageSourceDialog />
    </div>
  );
}
