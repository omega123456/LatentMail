import { useCallback, useRef, type CSSProperties, type FocusEvent } from 'react';
import { ReauthBanner } from '@/components/auth/ReauthBanner';
import { ConversationListContainer } from '@/components/list/ConversationList';
import { ListHeader } from '@/components/list/ListHeader';
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
import { ReadingPaneContainer } from '@/components/reader/ReadingPane';
import { StatusBar } from '@/components/statusbar/StatusBar';
import { useComposeStore } from '@/stores/compose';
import { useSearchStore } from '@/stores/search';
import { AssistantPanel } from '@/components/ai-chat/AssistantPanel';
import { percentOf } from '@/lib/format/percent';
import {
  AssistantRegionView,
  ComposeLayer,
  EnabledAiPolls,
  MailSidebarRegion,
  MailTopBar,
  MailWorkspaceBody,
} from './MailRegions';
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

function hasReaderPane(layout: string, activeThreadId: string | null): boolean {
  return layout === 'three-column' || (layout === 'bottom-preview' && activeThreadId !== null);
}

export function MailLayout({ accounts }: { accounts: Account[] }) {
  const shell = useRef<HTMLDivElement>(null);
  const searchFieldRef = useRef<HTMLInputElement>(null);
  const assistantTrigger = useRef<HTMLButtonElement>(null);
  const assistantRegion = useRef<HTMLDivElement>(null);

  const layoutState = useLayoutStore();
  const selection = useSelectionStore();
  const { activeAccountId, activeMailboxId, activeThreadId } = selection;

  const flaggedAccount = accounts.find((account) => account.needsReauthentication);
  const activeAccount = accounts.find((account) => account.id === activeAccountId);
  const hasReader = hasReaderPane(layoutState.layout, activeThreadId);
  const shellWidth = useShellWidth(shell);
  const assistantDocked =
    layoutState.layout === 'three-column' && shellWidth >= ASSISTANT_DOCK_MIN_SHELL_WIDTH;

  const { closeAssistant, toggleAssistant, openAiSettings } = useAssistantControls({
    assistantOpen: layoutState.assistantOpen,
    setAssistantOpen: layoutState.setAssistantOpen,
    assistantTrigger: assistantTrigger,
    assistantRegion: assistantRegion,
  });

  const { compose } = useMailLayoutCommands({
    activeAccount: activeAccount,
    activeAccountId: activeAccountId,
    activeThreadId: activeThreadId,
    searchFieldRef: searchFieldRef,
    toggleAssistant: toggleAssistant,
  });

  const searchActive = useSearchStore((search) => search.active);
  const searchSubmittedQuery = useSearchStore((search) => search.submittedQuery);
  const searchScope = useSearchStore((search) => search.scope);
  const searchClear = useSearchStore((search) => search.clear);
  const searchResults = useSearchThreadsQuery(activeAccountId, searchSubmittedQuery, searchScope);
  const searchTotalQuery = useSearchTotalQuery(activeAccountId, searchSubmittedQuery, searchScope);
  const labelsQuery = useLabelsQuery(activeAccountId);

  const rawLabels = labelsQuery.data ?? [];
  const mailboxes = mapLabelsToMailboxes(rawLabels);
  const labels = mapLabelsToUserLabels(rawLabels);
  const createLabelMutation = useCreateLabelMutation(activeAccountId);
  const renameLabelMutation = useRenameLabelMutation(activeAccountId);
  const recolorLabelMutation = useRecolorLabelMutation(activeAccountId);
  const deleteLabelMutation = useDeleteLabelMutation(activeAccountId);
  const composeOpen = useComposeStore((composeState) => composeState.session !== null);

  const selectAccount = useCallback(
    (id: string) => {
      searchClear();
      selection.setActiveAccountId(id);
      selection.setActiveMailboxId('INBOX');
      selection.clearSelection();
    },
    [searchClear, selection],
  );
  useEnsureActiveAccount(accounts, activeAccountId, selectAccount);

  const setPane = (
    key: '--sidebar-w' | '--list-w' | '--reader-h' | '--assistant-w',
    size: number,
    update: (size: number) => void,
  ) => {
    shell.current?.style.setProperty(key, key === '--reader-h' ? `${size}%` : `${size}px`);
    update(size);
  };

  const mailboxName = resolveMailboxName(mailboxes, labels, activeMailboxId ?? 'INBOX');
  const keepFocusOutWhileClosed = (event: FocusEvent<HTMLDivElement>) => {
    if (!layoutState.assistantOpen) event.target.blur();
  };
  const assistant = activeAccountId !== null && (
    <AssistantPanel
      accountId={activeAccountId}
      onClose={closeAssistant}
      onOpenAiSettings={openAiSettings}
    />
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
      <div
        className="grid min-h-0"
        style={{ gridTemplateColumns: sidebarGridColumns(layoutState.sidebarCollapsed) }}
      >
        <MailSidebarRegion
          sidebarCollapsed={layoutState.sidebarCollapsed}
          accounts={accounts}
          activeAccountId={activeAccountId}
          activeMailboxId={activeMailboxId}
          mailboxes={mailboxes}
          labels={labels}
          showUnreadCounts={layoutState.showUnreadCounts}
          search={{
            active: searchActive,
            submittedQuery: searchSubmittedQuery,
            total: searchTotalQuery.data ?? 0,
            loading: searchResults.isLoading,
            onClearAndFocus: () => {
              searchClear();
              searchFieldRef.current?.focus();
            },
          }}
          labelHandlers={{
            onCreateLabel: ({ name, colorId }) =>
              createLabelMutation.mutateAsync({ name, colorId }),
            onRenameLabel: ({ id, name }) =>
              renameLabelMutation.mutateAsync({ labelId: id, name: name }),
            onRecolorLabel: ({ id, colorId }) =>
              recolorLabelMutation.mutateAsync({ labelId: id, colorId: colorId }),
            onDeleteLabel: (id) => deleteLabelMutation.mutateAsync({ labelId: id }),
          }}
          onSelectAccount={selectAccount}
          onSelectMailbox={(id) => {
            searchClear();
            selection.setActiveMailboxId(id);
          }}
          onToggleCollapse={layoutState.setSidebarCollapsed}
          onOpenSettings={() => useLayoutStore.getState().setRoute('settings')}
          onCompose={compose}
        />
        {!layoutState.sidebarCollapsed && (
          <ResizeHandle
            ariaLabel="Resize sidebar"
            orientation="vertical"
            onResize={(offset) =>
              setPane('--sidebar-w', layoutState.sidebarWidth + offset, layoutState.setSidebarWidth)
            }
          />
        )}
        <div className="flex min-h-0 min-w-0 flex-col">
          <MailTopBar
            searchFieldRef={searchFieldRef}
            labels={rawLabels}
            assistantTrigger={assistantTrigger}
            assistantOpen={layoutState.assistantOpen}
            onToggleAssistant={toggleAssistant}
          />
          <div className="relative flex min-h-0 flex-1 flex-col">
            <MailWorkspaceBody
              layout={layoutState.layout}
              hasReader={hasReader}
              assistantDocked={assistantDocked}
              assistantOpen={layoutState.assistantOpen}
              list={list}
              reader={reader}
              dockedAssistant={
                <AssistantRegionView
                  docked
                  assistantOpen={layoutState.assistantOpen}
                  assistantRegion={assistantRegion}
                  keepFocusOutWhileClosed={keepFocusOutWhileClosed}
                >
                  {assistant}
                </AssistantRegionView>
              }
              onResizeList={(offset) =>
                setPane('--list-w', layoutState.listWidth + offset, layoutState.setListWidth)
              }
              onResizeAssistant={(offset) =>
                setPane(
                  '--assistant-w',
                  layoutState.assistantWidth - offset,
                  layoutState.setAssistantWidth,
                )
              }
              onResizeReader={(offset) =>
                setPane(
                  '--reader-h',
                  layoutState.readerHeight - percentOf(offset, shell.current?.clientHeight || 1),
                  layoutState.setReaderHeight,
                )
              }
            />
            {!assistantDocked && (
              <AssistantRegionView
                docked={false}
                assistantOpen={layoutState.assistantOpen}
                assistantRegion={assistantRegion}
                keepFocusOutWhileClosed={keepFocusOutWhileClosed}
              >
                {assistant}
              </AssistantRegionView>
            )}
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
