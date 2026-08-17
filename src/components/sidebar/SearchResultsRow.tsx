import { Search, X } from 'lucide-react';

export function SearchResultsRow({
  query,
  total,
  onClose,
}: {
  query: string;
  total: number;
  onClose: () => void;
}) {
  return (
    <div
      data-testid="search-results-row"
      className="mb-1 flex items-center gap-3 rounded bg-primary-container px-3 py-2 text-body-md font-bold text-on-primary-container dark:bg-dark-primary-container dark:text-dark-on-primary-container"
    >
      <Search aria-hidden="true" size={20} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left" title={query}>
        {query}
      </span>
      <span
        aria-live="polite"
        aria-atomic="true"
        className="shrink-0 tabular-nums text-label-sm"
      >
        {total}
      </span>
      <button
        type="button"
        aria-label="Close search"
        onClick={onClose}
        className="shrink-0 cursor-pointer rounded p-1 hover:bg-on-primary-container/10 focus-visible:outline-2 focus-visible:outline-primary"
      >
        <X aria-hidden="true" size={16} />
      </button>
    </div>
  );
}

export function CollapsedSearchIndicator({ query }: { query: string }) {
  return (
    <div
      data-testid="collapsed-search-indicator"
      title={query}
      aria-label={`Search results for ${query}`}
      className="grid size-9 place-items-center rounded bg-primary-container text-on-primary-container dark:bg-dark-primary-container dark:text-dark-on-primary-container"
    >
      <Search aria-hidden="true" size={18} />
    </div>
  );
}
