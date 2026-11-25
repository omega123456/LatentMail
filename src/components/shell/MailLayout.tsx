import { useCallback, useRef, type CSSProperties, type RefObject } from 'react';
import { useLabelsQuery, useSearchTotalQuery, useSearchThreadsQuery } from '@/lib/query/hooks';
import {
  useCreateLabelMutation,
  useDeleteLabelMutation,
  useRecolorLabelMutation,
  useRenameLabelMutation,
} from '@/lib/query/mutations';
import { mapLabelsToMailboxes, mapLabelsToUserLabels } from '@/lib/query/mappers';
import { ASSISTANT_DOCK_MIN_SHELL_WIDTH, useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import type { Account } from '@/lib/types/ipc';
import { ResizeHandle } from './ResizeHandle';
import { MessageSourceDialog } from '@/components/reader/MessageSourceDialog';
import { StatusBar } from '@/components/statusbar/StatusBar';
import { useComposeStore } from '@/stores/compose';
import { useSearchStore } from '@/stores/search';
import {
  ComposeLayer,
  EnabledAiPolls,
  MailSidebarRegion,
  type SidebarLabelHandlers,
} from './MailRegions';
import { MailMainColumn, type PaneVarKey } from './MailMainColumn';
import {
  useAssistantControls,
  useEnsureActiveAccount,
  useMailLayoutCommands,
  useShellWidth,
} from './useMailLayoutActions';

type PaneDimensions = {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  listWidth: number;
  readerHeight: number;
  assistantWidth: number;
};

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

function shellPaneVars(dimensions: PaneDimensions): CSSProperties {
  return {
    '--sidebar-w': dimensions.sidebarCollapsed ? '56px' : `${dimensions.sidebarWidth}px`,
    '--list-w': `${dimensions.listWidth}px`,
    '--reader-h': `${dimensions.readerHeight}%`,
    '--assistant-w': `${dimensions.assistantWidth}px`,
  } as CSSProperties;
}

function sidebarGridColumns(sidebarCollapsed: boolean): string {
  return sidebarCollapsed ? 'var(--sidebar-w) 1fr' : 'var(--sidebar-w) auto 1fr';
}

function useLabelHandlers(accountId: string | null): SidebarLabelHandlers {
  const createLabelMutation = useCreateLabelMutation(accountId);
  const renameLabelMutation = useRenameLabelMutation(accountId);
  const recolorLabelMutation = useRecolorLabelMutation(accountId);
  const deleteLabelMutation = useDeleteLabelMutation(accountId);
  return {
    onCreateLabel: ({ name, colorId }) => createLabelMutation.mutateAsync({ name, colorId }),
    onRenameLabel: ({ id, name }) => renameLabelMutation.mutateAsync({ labelId: id, name: name }),
    onRecolorLabel: ({ id, colorId }) =>
      recolorLabelMutation.mutateAsync({ labelId: id, colorId: colorId }),
    onDeleteLabel: (id) => deleteLabelMutation.mutateAsync({ labelId: id }),
  };
}

function useMailLayoutData(accounts: Account[]) {
  const selection = useSelectionStore();
  const { activeAccountId, activeMailboxId, activeThreadId } = selection;
  const searchActive = useSearchStore((search) => search.active);
  const searchSubmittedQuery = useSearchStore((search) => search.submittedQuery);
  const searchScope = useSearchStore((search) => search.scope);
  const searchClear = useSearchStore((search) => search.clear);
  const searchResults = useSearchThreadsQuery(activeAccountId, searchSubmittedQuery, searchScope);
  const searchTotalQuery = useSearchTotalQuery(activeAccountId, searchSubmittedQuery, searchScope);
  const rawLabels = useLabelsQuery(activeAccountId).data ?? [];
  const mailboxes = mapLabelsToMailboxes(rawLabels);
  const labels = mapLabelsToUserLabels(rawLabels);
  const labelHandlers = useLabelHandlers(activeAccountId);

  const setActiveAccountId = useSelectionStore((store) => store.setActiveAccountId);
  const setActiveMailboxId = useSelectionStore((store) => store.setActiveMailboxId);
  const clearSelection = useSelectionStore((store) => store.clearSelection);
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

  return {
    selection: selection,
    activeAccountId: activeAccountId,
    activeMailboxId: activeMailboxId,
    activeThreadId: activeThreadId,
    rawLabels: rawLabels,
    mailboxes: mailboxes,
    labels: labels,
    labelHandlers: labelHandlers,
    mailboxName: resolveMailboxName(mailboxes, labels, activeMailboxId ?? 'INBOX'),
    searchActive: searchActive,
    searchSubmittedQuery: searchSubmittedQuery,
    searchTotal: searchTotalQuery.data ?? 0,
    searchLoading: searchResults.isLoading,
    searchClear: searchClear,
    selectAccount: selectAccount,
  };
}

function MailSidebarSlot({
  accounts,
  data,
  searchFieldRef,
  compose,
  onResizeSidebar,
}: {
  accounts: Account[];
  data: ReturnType<typeof useMailLayoutData>;
  searchFieldRef: RefObject<HTMLInputElement | null>;
  compose: () => void;
  onResizeSidebar: (offset: number) => void;
}) {
  const layoutState = useLayoutStore();
  return (
    <>
      <MailSidebarRegion
        sidebarCollapsed={layoutState.sidebarCollapsed}
        accounts={accounts}
        activeAccountId={data.activeAccountId}
        activeMailboxId={data.activeMailboxId}
        mailboxes={data.mailboxes}
        labels={data.labels}
        showUnreadCounts={layoutState.showUnreadCounts}
        search={{
          active: data.searchActive,
          submittedQuery: data.searchSubmittedQuery,
          total: data.searchTotal,
          loading: data.searchLoading,
          onClearAndFocus: () => {
            data.searchClear();
            searchFieldRef.current?.focus();
          },
        }}
        labelHandlers={data.labelHandlers}
        onSelectAccount={data.selectAccount}
        onSelectMailbox={(id) => {
          data.searchClear();
          data.selection.setActiveMailboxId(id);
        }}
        onToggleCollapse={layoutState.setSidebarCollapsed}
        onOpenSettings={() => useLayoutStore.getState().setRoute('settings')}
        onCompose={compose}
      />
      {!layoutState.sidebarCollapsed && (
        <ResizeHandle
          ariaLabel="Resize sidebar"
          orientation="vertical"
          onResize={onResizeSidebar}
        />
      )}
    </>
  );
}

type MailShellBodyProps = {
  accounts: Account[];
  shell: RefObject<HTMLDivElement | null>;
  searchFieldRef: RefObject<HTMLInputElement | null>;
  assistantTrigger: RefObject<HTMLButtonElement | null>;
  assistantRegion: RefObject<HTMLDivElement | null>;
};

function MailShellBody(props: MailShellBodyProps) {
  const layoutState = useLayoutStore();
  const data = useMailLayoutData(props.accounts);
  const shellWidth = useShellWidth(props.shell);
  const flaggedAccount = props.accounts.find((account) => account.needsReauthentication);
  const activeAccount = props.accounts.find((account) => account.id === data.activeAccountId);
  const assistantDocked =
    layoutState.layout === 'three-column' && shellWidth >= ASSISTANT_DOCK_MIN_SHELL_WIDTH;
  const assistant = useAssistantControls({
    assistantOpen: layoutState.assistantOpen,
    setAssistantOpen: layoutState.setAssistantOpen,
    assistantTrigger: props.assistantTrigger,
    assistantRegion: props.assistantRegion,
  });
  const { compose } = useMailLayoutCommands({
    activeAccount: activeAccount,
    activeAccountId: data.activeAccountId,
    activeThreadId: data.activeThreadId,
    searchFieldRef: props.searchFieldRef,
    toggleAssistant: assistant.toggleAssistant,
  });
  const setPane = (key: PaneVarKey, size: number, update: (size: number) => void) => {
    props.shell.current?.style.setProperty(key, key === '--reader-h' ? `${size}%` : `${size}px`);
    update(size);
  };

  return (
    <div
      className="grid min-h-0"
      style={{ gridTemplateColumns: sidebarGridColumns(layoutState.sidebarCollapsed) }}
    >
      <MailSidebarSlot
        accounts={props.accounts}
        data={data}
        searchFieldRef={props.searchFieldRef}
        compose={compose}
        onResizeSidebar={(offset) =>
          setPane('--sidebar-w', layoutState.sidebarWidth + offset, layoutState.setSidebarWidth)
        }
      />
      <MailMainColumn
        shell={props.shell}
        searchFieldRef={props.searchFieldRef}
        assistantTrigger={props.assistantTrigger}
        assistantRegion={props.assistantRegion}
        rawLabels={data.rawLabels}
        activeAccountId={data.activeAccountId}
        activeThreadId={data.activeThreadId}
        flaggedAccountId={flaggedAccount?.id}
        mailboxName={data.mailboxName}
        assistantDocked={assistantDocked}
        onToggleAssistant={assistant.toggleAssistant}
        onCloseAssistant={assistant.closeAssistant}
        onOpenAiSettings={assistant.openAiSettings}
        setPane={setPane}
      />
    </div>
  );
}

export function MailLayout({ accounts }: { accounts: Account[] }) {
  const shell = useRef<HTMLDivElement>(null);
  const searchFieldRef = useRef<HTMLInputElement>(null);
  const assistantTrigger = useRef<HTMLButtonElement>(null);
  const assistantRegion = useRef<HTMLDivElement>(null);
  const layoutState = useLayoutStore();
  const activeAccountId = useSelectionStore((selection) => selection.activeAccountId);
  const composeOpen = useComposeStore((composeState) => composeState.session !== null);

  return (
    <div
      ref={shell}
      data-testid="mail-layout"
      data-layout={layoutState.layout}
      data-density={layoutState.density}
      style={shellPaneVars({
        sidebarCollapsed: layoutState.sidebarCollapsed,
        sidebarWidth: layoutState.sidebarWidth,
        listWidth: layoutState.listWidth,
        readerHeight: layoutState.readerHeight,
        assistantWidth: layoutState.assistantWidth,
      })}
      className="grid h-full grid-rows-app-shell overflow-hidden bg-surface dark:bg-dark-surface"
    >
      <MailShellBody
        accounts={accounts}
        shell={shell}
        searchFieldRef={searchFieldRef}
        assistantTrigger={assistantTrigger}
        assistantRegion={assistantRegion}
      />
      <StatusBar accountId={activeAccountId} />
      <EnabledAiPolls />
      <ComposeLayer open={composeOpen} />
      <MessageSourceDialog />
    </div>
  );
}
