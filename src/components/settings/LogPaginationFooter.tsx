import { format } from 'date-fns';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { DATE_FORMAT } from '@/lib/format/date-formats';

const PAGE_WINDOW = 1;

const pageButtonClass =
  'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-chip text-settings-meta font-semibold tabular-nums text-settings-ink-mute hover:bg-settings-container-low hover:text-settings-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-settings-primary disabled:cursor-not-allowed disabled:opacity-35 aria-[current=true]:bg-settings-container aria-[current=true]:text-settings-on-primary-container dark:text-dark-settings-ink-mute dark:hover:bg-dark-settings-container-low dark:hover:text-dark-settings-ink dark:aria-[current=true]:bg-dark-settings-container dark:aria-[current=true]:text-dark-settings-on-primary-container';

function pageItems(page: number, pageCount: number): (number | 'ellipsis')[] {
  const items: (number | 'ellipsis')[] = [];
  for (let index = 1; index <= pageCount; index += 1) {
    const isEdge = index === 1 || index === pageCount;
    const isNearCurrent = Math.abs(index - page) <= PAGE_WINDOW;
    if (isEdge || isNearCurrent) {
      items.push(index);
      continue;
    }
    if (items[items.length - 1] !== 'ellipsis') items.push('ellipsis');
  }
  return items;
}

function PageNumberSlot({
  item,
  page,
  onSelectPage,
}: {
  item: number | 'ellipsis';
  page: number;
  onSelectPage: (page: number) => void;
}) {
  if (item === 'ellipsis') {
    return (
      <span className="flex size-7 shrink-0 items-center justify-center text-settings-ink-mute dark:text-dark-settings-ink-mute">
        …
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-current={page === item}
      onClick={() => onSelectPage(item)}
      className={pageButtonClass}
    >
      {item}
    </button>
  );
}

function LogPageControls({
  page,
  pageCount,
  onSelectPage,
}: {
  page: number;
  pageCount: number;
  onSelectPage: (page: number) => void;
}) {
  return (
    <span className="flex items-center gap-0.5">
      <button
        type="button"
        aria-label="First page"
        disabled={page === 1}
        onClick={() => onSelectPage(1)}
        className={pageButtonClass}
      >
        <ChevronsLeft className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Previous page"
        disabled={page === 1}
        onClick={() => onSelectPage(page - 1)}
        className={pageButtonClass}
      >
        <ChevronLeft className="size-3.5" />
      </button>
      {pageItems(page, pageCount).map((item, index) => (
        <PageNumberSlot
          key={item === 'ellipsis' ? `ellipsis-${index}` : item}
          item={item}
          page={page}
          onSelectPage={onSelectPage}
        />
      ))}
      <button
        type="button"
        aria-label="Next page"
        disabled={page === pageCount}
        onClick={() => onSelectPage(page + 1)}
        className={pageButtonClass}
      >
        <ChevronRight className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Last page"
        disabled={page === pageCount}
        onClick={() => onSelectPage(pageCount)}
        className={pageButtonClass}
      >
        <ChevronsRight className="size-3.5" />
      </button>
    </span>
  );
}

type LogPaginationFooterProps = {
  page: number;
  pageCount: number;
  pageStart: number;
  entriesPerPage: number;
  visibleLength: number;
  dataUpdatedAt: number;
  onSelectPage: (page: number) => void;
};

export function LogPaginationFooter(props: LogPaginationFooterProps) {
  const rangeStart = props.visibleLength === 0 ? 0 : props.pageStart + 1;
  const rangeEnd = Math.min(props.pageStart + props.entriesPerPage, props.visibleLength);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-settings-card-line bg-settings-container-low px-4 py-2.5 text-settings-meta text-settings-ink-mute dark:border-dark-settings-card-line dark:bg-dark-settings-container-low dark:text-dark-settings-ink-mute">
      <span className="flex items-center gap-3 tabular-nums">
        <span data-testid="log-page-summary" className="inline-block min-w-log-summary">
          {rangeStart}–{rangeEnd} of {props.visibleLength} entries
        </span>
        {props.pageCount > 1 && (
          <LogPageControls
            page={props.page}
            pageCount={props.pageCount}
            onSelectPage={props.onSelectPage}
          />
        )}
      </span>
      {props.dataUpdatedAt > 0 && (
        <span>
          Last updated {format(new Date(props.dataUpdatedAt), DATE_FORMAT.timeOfDay)} ·
          auto-refreshes every 5s
        </span>
      )}
    </div>
  );
}
