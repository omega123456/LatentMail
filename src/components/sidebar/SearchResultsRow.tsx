import { Search, X } from 'lucide-react';

function formatSearchStatus(total: number, pending: boolean) {
  if (pending) return 'searching…';
  if (total === 0) return 'no results';
  if (total > 999) return '999+ results';
  return `${total} result${total === 1 ? '' : 's'}`;
}

export function SearchResultsRow({
  query,
  total,
  pending = false,
  onClose,
}: {
  query: string;
  total: number;
  pending?: boolean;
  onClose: () => void;
}) {
  return (
    <div
      data-testid="search-results-row"
      role="region"
      aria-label="Active search"
      className="mb-1 rounded-r border-l-3 border-primary bg-surface-container-high px-3 py-2 dark:border-dark-primary dark:bg-dark-surface-container-high"
    >
      <div
        role="status"
        className="flex items-center gap-2 text-on-surface-variant dark:text-dark-on-surface-variant"
      >
        <Search
          aria-hidden="true"
          size={14}
          strokeWidth={2.5}
          className="shrink-0 text-primary dark:text-dark-primary"
        />
        <span className="min-w-0 flex-1 truncate text-label-md uppercase tabular-nums">
          Search &middot; {formatSearchStatus(total, pending)}
        </span>
        <button
          type="button"
          aria-label="Clear search results"
          onClick={onClose}
          className="-mr-1 shrink-0 cursor-pointer rounded-sm p-1 hover:bg-on-surface/10 focus-visible:outline-2 focus-visible:outline-primary dark:hover:bg-dark-on-surface/10"
        >
          <X aria-hidden="true" size={14} />
        </button>
      </div>
      <p className="truncate text-body-sm text-on-surface dark:text-dark-on-surface" title={query}>
        {query}
      </p>
    </div>
  );
}

export function CollapsedSearchIndicator({ query }: { query: string }) {
  return (
    <div
      data-testid="collapsed-search-indicator"
      title={query}
      aria-label={`Search results for ${query}`}
      className="grid size-9 place-items-center rounded-r border-l-3 border-primary bg-surface-container-high text-primary dark:border-dark-primary dark:bg-dark-surface-container-high dark:text-dark-primary"
    >
      <Search aria-hidden="true" size={16} strokeWidth={2.5} />
    </div>
  );
}
