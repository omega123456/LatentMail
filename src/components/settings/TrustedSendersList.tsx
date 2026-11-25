import { useState } from 'react';
import { ImageOff, Info, Mail, Trash2 } from 'lucide-react';
import { Select } from '@/components/shared/Select';
import { useLayoutStore } from '@/stores/layout';
import { settingsDangerIconButton, settingsLinkPrimary, settingsTriggerClass } from './styles';
import { HighlightedText, SettingsSearchInput } from './primitives';
import { ICON_SIZE } from '@/components/shared/icon-size';

const rowsPerPageOptions = ['5', '10', '25'];
const cardLine = 'border-settings-card-line dark:border-dark-settings-card-line';
const blockedGlyphClass =
  'grid size-5.5 shrink-0 place-items-center rounded-chip bg-settings-tint-block text-settings-blocked dark:bg-dark-settings-tint-block dark:text-dark-settings-blocked';
const emptyStateClass = `flex flex-col items-center gap-1.5 border-b ${cardLine} px-6 py-8.5 text-center text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute`;
const emptyLeadClass = 'text-body-sm font-medium text-settings-ink dark:text-dark-settings-ink';
const pageButtonClass =
  'cursor-pointer rounded-chip px-1.75 py-1 text-settings-meta font-semibold tabular-nums text-settings-ink-mute hover:bg-settings-container-low hover:text-settings-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-settings-primary disabled:cursor-not-allowed disabled:opacity-35 aria-[current=true]:bg-settings-container aria-[current=true]:text-settings-on-primary-container dark:text-dark-settings-ink-mute dark:hover:bg-dark-settings-container-low dark:hover:text-dark-settings-ink dark:aria-[current=true]:bg-dark-settings-container dark:aria-[current=true]:text-dark-settings-on-primary-container';

type TrustedSendersBodyProps = {
  sendersCount: number;
  matchesCount: number;
  visible: string[];
  filter: string;
  needle: string;
  onClearFilter: () => void;
  onRemove: (address: string) => void;
};

function TrustedSendersBody(props: TrustedSendersBodyProps) {
  if (props.sendersCount === 0) {
    return (
      <div className={emptyStateClass}>
        <ImageOff
          aria-hidden="true"
          size={ICON_SIZE.xl}
          className="mb-0.5 text-settings-blocked dark:text-dark-settings-blocked"
        />
        <span className={emptyLeadClass}>No trusted senders yet</span>
        <span>Choose Always allow from sender on a blocked message to add one.</span>
      </div>
    );
  }
  if (props.matchesCount === 0) {
    return (
      <div className={emptyStateClass}>
        <span className={emptyLeadClass}>No senders match “{props.filter.trim()}”</span>
        <button type="button" onClick={props.onClearFilter} className={settingsLinkPrimary}>
          Clear filter
        </button>
      </div>
    );
  }
  return props.visible.map((address) => (
    <div
      key={address}
      className={`group flex items-center gap-2.5 rounded-b border-b ${cardLine} py-2.25 pl-3 pr-2 hover:bg-settings-container-low dark:hover:bg-dark-settings-container-low`}
    >
      <span className={blockedGlyphClass}>
        <Mail aria-hidden="true" size={ICON_SIZE.xxs} />
      </span>
      <span className="min-w-0 flex-1 truncate text-body-sm text-settings-ink dark:text-dark-settings-ink">
        <HighlightedText text={address} needle={props.needle} caseInsensitive={false} />
      </span>
      <button
        type="button"
        aria-label={`Remove ${address}`}
        onClick={() => props.onRemove(address)}
        className={`${settingsDangerIconButton} opacity-0 focus-visible:opacity-100 group-hover:opacity-100`}
      >
        <Trash2 aria-hidden="true" size={ICON_SIZE.xs} />
      </button>
    </div>
  ));
}

function TrustedSendersHeader({
  filter,
  rowsPerPage,
  onFilterChange,
  onRowsPerPageChange,
}: {
  filter: string;
  rowsPerPage: string;
  onFilterChange: (next: string) => void;
  onRowsPerPageChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-body-sm font-medium text-settings-ink dark:text-dark-settings-ink">
          Trusted senders
        </span>
        <span className="text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute">
          Their images load automatically. Spam is always blocked.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SettingsSearchInput
          value={filter}
          ariaLabel="Filter trusted senders"
          placeholder="Filter senders"
          onChange={onFilterChange}
        />
        <Select
          ariaLabel="Rows per page"
          value={rowsPerPage}
          onChange={onRowsPerPageChange}
          options={rowsPerPageOptions.map((rows) => ({ value: rows, label: `${rows} rows` }))}
          className={settingsTriggerClass}
        />
      </div>
    </div>
  );
}

function TrustedSendersPagination({
  start,
  perPage,
  total,
  page,
  pageCount,
  onSelectPage,
}: {
  start: number;
  perPage: number;
  total: number;
  page: number;
  pageCount: number;
  onSelectPage: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 pt-2.5 text-settings-meta tabular-nums text-settings-ink-mute dark:text-dark-settings-ink-mute">
      <span>
        {start + 1}–{Math.min(start + perPage, total)} of {total}
      </span>
      <span className="flex items-center gap-0.5">
        <button
          type="button"
          disabled={page === 1}
          onClick={() => onSelectPage(page - 1)}
          className={pageButtonClass}
        >
          Prev
        </button>
        {Array.from({ length: pageCount }, (_unused, index) => (
          <button
            key={index + 1}
            type="button"
            aria-current={page === index + 1}
            onClick={() => onSelectPage(index + 1)}
            className={pageButtonClass}
          >
            {index + 1}
          </button>
        ))}
        <button
          type="button"
          disabled={page === pageCount}
          onClick={() => onSelectPage(page + 1)}
          className={pageButtonClass}
        >
          Next
        </button>
      </span>
    </div>
  );
}

function AlwaysLoadNotice({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <p className="mt-3 flex items-start gap-2 rounded-control bg-settings-container-low px-3 py-2.5 text-settings-desc text-settings-ink-mute dark:bg-dark-settings-container-low dark:text-dark-settings-ink-mute">
      <Info
        aria-hidden="true"
        size={ICON_SIZE.md}
        className="mt-0.5 shrink-0 text-settings-blocked dark:text-dark-settings-blocked"
      />
      <span>
        Every sender is trusted while Always load remote images is on. Your list is kept and applies
        again the moment you turn it off.
      </span>
    </p>
  );
}

function useTrustedSendersPagination(senders: string[]) {
  const [filter, setFilter] = useState('');
  const [rowsPerPage, setRowsPerPage] = useState('10');
  const [requestedPage, setRequestedPage] = useState(1);

  const needle = filter.trim().toLowerCase();
  const sorted = [...senders].sort();
  const matches = needle ? sorted.filter((address) => address.includes(needle)) : sorted;
  const perPage = Number(rowsPerPage);
  const pageCount = Math.max(1, Math.ceil(matches.length / perPage));
  const page = requestedPage > pageCount ? 1 : requestedPage;
  const start = (page - 1) * perPage;

  const updateFilter = (next: string) => {
    setFilter(next);
    setRequestedPage(1);
  };
  const updateRowsPerPage = (next: string) => {
    setRowsPerPage(next);
    setRequestedPage(1);
  };

  return {
    filter,
    rowsPerPage,
    needle,
    matches,
    perPage,
    pageCount,
    page,
    start,
    setRequestedPage,
    updateFilter,
    updateRowsPerPage,
  };
}

export function TrustedSendersList() {
  const alwaysLoad = useLayoutStore((layout) => layout.alwaysLoadRemoteImages);
  const senders = useLayoutStore((layout) => layout.allowedImageSenders);
  const untrustImageSender = useLayoutStore((layout) => layout.untrustImageSender);
  const paging = useTrustedSendersPagination(senders);

  return (
    <div className="flex flex-col" data-testid="settings-trusted-senders">
      <div
        inert={alwaysLoad}
        aria-disabled={alwaysLoad}
        className={`flex flex-col gap-3 ${alwaysLoad ? 'opacity-42' : ''}`}
      >
        <TrustedSendersHeader
          filter={paging.filter}
          rowsPerPage={paging.rowsPerPage}
          onFilterChange={paging.updateFilter}
          onRowsPerPageChange={paging.updateRowsPerPage}
        />
        <div className={`flex flex-col border-t ${cardLine}`}>
          <TrustedSendersBody
            sendersCount={senders.length}
            matchesCount={paging.matches.length}
            visible={paging.matches.slice(paging.start, paging.start + paging.perPage)}
            filter={paging.filter}
            needle={paging.needle}
            onClearFilter={() => paging.updateFilter('')}
            onRemove={untrustImageSender}
          />
        </div>
        {paging.matches.length > 0 && (
          <TrustedSendersPagination
            start={paging.start}
            perPage={paging.perPage}
            total={paging.matches.length}
            page={paging.page}
            pageCount={paging.pageCount}
            onSelectPage={paging.setRequestedPage}
          />
        )}
      </div>
      <AlwaysLoadNotice visible={alwaysLoad} />
    </div>
  );
}
