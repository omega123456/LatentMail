import { Suspense, type FocusEvent, type ReactNode } from 'react';
import { PanelLeftClose, Pencil, Settings, Sparkles } from 'lucide-react';
import brandMark from '@/assets/brand-mark.png';
import { DelayedFallback, lazyWithDelayedFallback } from '@/components/states/DelayedFallback';
import { useAiConfigsQuery, useAiConnectionQuery } from '@/lib/query/hooks';
import type { Account, MailLabel } from '@/lib/types/ipc';
import type { mapLabelsToMailboxes, mapLabelsToUserLabels } from '@/lib/query/mappers';
import { AccountSwitcher } from '@/components/sidebar/AccountSwitcher';
import { CollapsedRail } from '@/components/sidebar/CollapsedRail';
import { FolderList } from '@/components/sidebar/FolderList';
import { LabelList } from '@/components/sidebar/LabelList';
import { SearchResultsRow } from '@/components/sidebar/SearchResultsRow';
import { navRow } from '@/components/sidebar/rowStyles';
import { SearchField } from '@/components/search/SearchField';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { ResizeHandle } from './ResizeHandle';

const navItem = navRow(false);

const ComposeOverlay = lazyWithDelayedFallback(() =>
  import('@/components/compose/ComposeOverlay').then(({ ComposeOverlay }) => ({
    default: ComposeOverlay,
  })),
);

function AccountConnectionPoll({ accountId }: { accountId: string }) {
  useAiConnectionQuery(accountId);
  return null;
}

export function EnabledAiPolls() {
  const aiConfigs = useAiConfigsQuery();
  return (aiConfigs.data ?? [])
    .filter((config) => config.enabled)
    .map((config) => <AccountConnectionPoll key={config.accountId} accountId={config.accountId} />);
}

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

export function ComposeLayer({ open }: { open: boolean }) {
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

type MailWorkspaceBodyProps = {
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
};

function ThreeColumnWorkspace({
  assistantDocked,
  assistantOpen,
  list,
  reader,
  dockedAssistant,
  onResizeList,
  onResizeAssistant,
}: Omit<MailWorkspaceBodyProps, 'layout' | 'hasReader' | 'onResizeReader'>) {
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

export function MailWorkspaceBody(props: MailWorkspaceBodyProps) {
  if (props.layout === 'three-column') {
    return (
      <ThreeColumnWorkspace
        assistantDocked={props.assistantDocked}
        assistantOpen={props.assistantOpen}
        list={props.list}
        reader={props.reader}
        dockedAssistant={props.dockedAssistant}
        onResizeList={props.onResizeList}
        onResizeAssistant={props.onResizeAssistant}
      />
    );
  }
  if (props.layout === 'bottom-preview' && props.hasReader) {
    return (
      <main
        className="grid min-h-0 flex-1"
        style={{ gridTemplateRows: '1fr auto var(--reader-h)' }}
      >
        {props.list}
        <ResizeHandle
          ariaLabel="Resize reader"
          orientation="horizontal"
          onResize={props.onResizeReader}
        />
        {props.reader}
      </main>
    );
  }
  return <main className="flex min-h-0 flex-1 flex-col">{props.list}</main>;
}

export type SidebarLabelHandlers = {
  onCreateLabel: (input: { name: string; colorId: string | null }) => Promise<unknown>;
  onRenameLabel: (input: { id: string; name: string }) => Promise<unknown>;
  onRecolorLabel: (input: { id: string; colorId: string }) => Promise<unknown>;
  onDeleteLabel: (id: string) => Promise<unknown>;
};

export type SidebarSearchSummary = {
  active: boolean;
  submittedQuery: string;
  total: number;
  loading: boolean;
  onClearAndFocus: () => void;
};

type MailSidebarRegionProps = {
  sidebarCollapsed: boolean;
  accounts: Account[];
  activeAccountId: string | null;
  activeMailboxId: string | null;
  mailboxes: ReturnType<typeof mapLabelsToMailboxes>;
  labels: ReturnType<typeof mapLabelsToUserLabels>;
  showUnreadCounts: boolean;
  search: SidebarSearchSummary;
  labelHandlers: SidebarLabelHandlers;
  onSelectAccount: (id: string) => void;
  onSelectMailbox: (id: string) => void;
  onToggleCollapse: (collapsed: boolean) => void;
  onOpenSettings: () => void;
  onCompose: () => void;
};

function ExpandedSidebarScrollBody(props: Omit<MailSidebarRegionProps, 'sidebarCollapsed'>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
      <button
        type="button"
        title="Compose"
        onClick={props.onCompose}
        className="mb-4 flex cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-label-md text-on-primary shadow-sm focus-visible:outline-2 focus-visible:outline-primary dark:bg-dark-primary dark:text-dark-on-primary"
      >
        <Pencil aria-hidden="true" size={ICON_SIZE.base} />
        Compose
      </button>
      {props.search.active && (
        <SearchResultsRow
          query={props.search.submittedQuery}
          total={props.search.total}
          pending={props.search.loading}
          onClose={props.search.onClearAndFocus}
        />
      )}
      <FolderList
        activeMailboxId={props.activeMailboxId ?? 'INBOX'}
        mailboxes={props.mailboxes}
        showUnreadCounts={props.showUnreadCounts}
        onSelect={props.onSelectMailbox}
      />
      <LabelList
        activeMailboxId={props.activeMailboxId}
        labels={props.labels}
        showUnreadCounts={props.showUnreadCounts}
        onSelect={props.onSelectMailbox}
        onCreateLabel={props.labelHandlers.onCreateLabel}
        onRenameLabel={props.labelHandlers.onRenameLabel}
        onRecolorLabel={props.labelHandlers.onRecolorLabel}
        onDeleteLabel={props.labelHandlers.onDeleteLabel}
      />
      <button
        type="button"
        aria-label="Collapse sidebar"
        onClick={() => props.onToggleCollapse(true)}
        className={`mt-auto ${navItem}`}
      >
        <PanelLeftClose aria-hidden="true" size={ICON_SIZE.lg} />
        Collapse
      </button>
      <button type="button" onClick={props.onOpenSettings} className={navItem}>
        <Settings aria-hidden="true" size={ICON_SIZE.lg} />
        Settings
      </button>
    </div>
  );
}

export function MailSidebarRegion(props: MailSidebarRegionProps) {
  if (props.sidebarCollapsed) {
    return (
      <CollapsedRail
        accounts={props.accounts}
        activeAccountId={props.activeAccountId}
        activeMailboxId={props.activeMailboxId ?? 'INBOX'}
        mailboxes={props.mailboxes}
        labels={props.labels}
        onSelectAccount={props.onSelectAccount}
        onSelectMailbox={props.onSelectMailbox}
        onExpand={() => props.onToggleCollapse(false)}
        onSettings={props.onOpenSettings}
        onCompose={props.onCompose}
        searchActive={props.search.active}
        searchQuery={props.search.submittedQuery}
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
      <ExpandedSidebarScrollBody {...props} />
      <div className="mt-4 border-t border-outline-variant pt-4 dark:border-dark-outline-variant">
        <AccountSwitcher
          accounts={props.accounts}
          activeAccountId={props.activeAccountId}
          collapsed={false}
          onSelect={props.onSelectAccount}
        />
      </div>
    </aside>
  );
}

export function AssistantRegionView({
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

export function MailTopBar({
  searchFieldRef,
  labels,
  assistantTrigger,
  assistantOpen,
  onToggleAssistant,
}: {
  searchFieldRef: React.RefObject<HTMLInputElement | null>;
  labels: MailLabel[];
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
