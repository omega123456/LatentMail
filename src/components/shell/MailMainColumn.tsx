import type { FocusEvent, RefObject } from 'react';
import { ReauthBanner } from '@/components/auth/ReauthBanner';
import { ConversationListContainer } from '@/components/list/ConversationList';
import { ListHeader } from '@/components/list/ListHeader';
import { ReadingPaneContainer } from '@/components/reader/ReadingPane';
import { AssistantPanel } from '@/components/ai-chat/AssistantPanel';
import { useLayoutStore } from '@/stores/layout';
import type { MailLabel } from '@/lib/types/ipc';
import { percentOf } from '@/lib/format/percent';
import { AssistantRegionView, MailTopBar, MailWorkspaceBody } from './MailRegions';

export type PaneVarKey = '--sidebar-w' | '--list-w' | '--reader-h' | '--assistant-w';

function hasReaderPane(layout: string, activeThreadId: string | null): boolean {
  return layout === 'three-column' || (layout === 'bottom-preview' && activeThreadId !== null);
}

function MailListSlot({
  flaggedAccountId,
  mailboxName,
}: {
  flaggedAccountId: string | undefined;
  mailboxName: string;
}) {
  return (
    <section
      data-testid="list-slot"
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-outline-variant/40 bg-surface dark:border-dark-outline-variant dark:bg-dark-surface-container"
    >
      {flaggedAccountId && <ReauthBanner accountId={flaggedAccountId} />}
      <ListHeader mailboxName={mailboxName} />
      <ConversationListContainer />
    </section>
  );
}

function MailReaderSlot({ threadId }: { threadId: string | null }) {
  return (
    <section
      data-testid="reader-slot"
      className="min-h-0 min-w-0 overflow-hidden bg-surface-bright dark:bg-dark-surface-container-high"
    >
      <ReadingPaneContainer threadId={threadId} />
    </section>
  );
}

type MailMainColumnProps = {
  shell: RefObject<HTMLDivElement | null>;
  searchFieldRef: RefObject<HTMLInputElement | null>;
  assistantTrigger: RefObject<HTMLButtonElement | null>;
  assistantRegion: RefObject<HTMLDivElement | null>;
  rawLabels: MailLabel[];
  activeAccountId: string | null;
  activeThreadId: string | null;
  flaggedAccountId: string | undefined;
  mailboxName: string;
  assistantDocked: boolean;
  onToggleAssistant: () => void;
  onCloseAssistant: () => void;
  onOpenAiSettings: () => void;
  setPane: (key: PaneVarKey, size: number, update: (size: number) => void) => void;
};

type MailMainWorkspaceProps = Omit<
  MailMainColumnProps,
  'searchFieldRef' | 'assistantTrigger' | 'rawLabels' | 'onToggleAssistant'
>;

function MailMainWorkspace(props: MailMainWorkspaceProps) {
  const layoutState = useLayoutStore();
  const keepFocusOutWhileClosed = (event: FocusEvent<HTMLDivElement>) => {
    if (!layoutState.assistantOpen) event.target.blur();
  };
  const assistant = props.activeAccountId !== null && (
    <AssistantPanel
      accountId={props.activeAccountId}
      onClose={props.onCloseAssistant}
      onOpenAiSettings={props.onOpenAiSettings}
    />
  );
  const assistantRegionNode = (docked: boolean) => (
    <AssistantRegionView
      docked={docked}
      assistantOpen={layoutState.assistantOpen}
      assistantRegion={props.assistantRegion}
      keepFocusOutWhileClosed={keepFocusOutWhileClosed}
    >
      {assistant}
    </AssistantRegionView>
  );
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <MailWorkspaceBody
        layout={layoutState.layout}
        hasReader={hasReaderPane(layoutState.layout, props.activeThreadId)}
        assistantDocked={props.assistantDocked}
        assistantOpen={layoutState.assistantOpen}
        list={
          <MailListSlot flaggedAccountId={props.flaggedAccountId} mailboxName={props.mailboxName} />
        }
        reader={<MailReaderSlot threadId={props.activeThreadId} />}
        dockedAssistant={assistantRegionNode(true)}
        onResizeList={(offset) =>
          props.setPane('--list-w', layoutState.listWidth + offset, layoutState.setListWidth)
        }
        onResizeAssistant={(offset) =>
          props.setPane(
            '--assistant-w',
            layoutState.assistantWidth - offset,
            layoutState.setAssistantWidth,
          )
        }
        onResizeReader={(offset) =>
          props.setPane(
            '--reader-h',
            layoutState.readerHeight - percentOf(offset, props.shell.current?.clientHeight || 1),
            layoutState.setReaderHeight,
          )
        }
      />
      {!props.assistantDocked && assistantRegionNode(false)}
    </div>
  );
}

export function MailMainColumn(props: MailMainColumnProps) {
  const assistantOpen = useLayoutStore((layoutState) => layoutState.assistantOpen);
  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <MailTopBar
        searchFieldRef={props.searchFieldRef}
        labels={props.rawLabels}
        assistantTrigger={props.assistantTrigger}
        assistantOpen={assistantOpen}
        onToggleAssistant={props.onToggleAssistant}
      />
      <MailMainWorkspace
        shell={props.shell}
        assistantRegion={props.assistantRegion}
        activeAccountId={props.activeAccountId}
        activeThreadId={props.activeThreadId}
        flaggedAccountId={props.flaggedAccountId}
        mailboxName={props.mailboxName}
        assistantDocked={props.assistantDocked}
        onCloseAssistant={props.onCloseAssistant}
        onOpenAiSettings={props.onOpenAiSettings}
        setPane={props.setPane}
      />
    </div>
  );
}
