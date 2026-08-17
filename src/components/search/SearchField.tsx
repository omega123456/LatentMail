import { forwardRef } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { MAX_SEARCH_QUERY_LENGTH, useSearchStore } from '@/stores/search';
import { useToastStore } from '@/stores/toast';
import { AdvancedSearchPanel } from './AdvancedSearchPanel';
import type { MailLabel } from '@/lib/types/ipc';

export const SearchField = forwardRef<HTMLInputElement, { labels: MailLabel[] }>(
  function SearchField({ labels }, ref) {
    const draft = useSearchStore((state) => state.draft);
    const setDraft = useSearchStore((state) => state.setDraft);
    const scope = useSearchStore((state) => state.scope);
    const setScope = useSearchStore((state) => state.setScope);
    const panelOpen = useSearchStore((state) => state.panelOpen);
    const openPanel = useSearchStore((state) => state.openPanel);
    const closePanel = useSearchStore((state) => state.closePanel);
    const submit = useSearchStore((state) => state.submit);
    const clear = useSearchStore((state) => state.clear);
    const showError = useToastStore((state) => state.showError);

    const handleSubmit = (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      if (trimmed.length > MAX_SEARCH_QUERY_LENGTH) {
        showError(`Search is limited to ${MAX_SEARCH_QUERY_LENGTH} characters.`);
        return;
      }
      submit(trimmed);
    };

    return (
      <div role="search" aria-label="Mail search" className="relative w-full max-w-2xl">
        <div className="flex items-center gap-2 rounded-full bg-surface-container-low px-3 py-2 transition-colors hover:bg-surface-container focus-within:outline-2 focus-within:outline-primary dark:bg-dark-surface-container-low dark:hover:bg-dark-surface-container">
          <Search
            aria-hidden="true"
            size={18}
            className="shrink-0 text-on-surface-variant dark:text-dark-on-surface-variant"
          />
          <input
            ref={ref}
            type="text"
            value={draft}
            placeholder="Search mail…"
            aria-label="Search mail"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleSubmit(draft);
              } else if (event.key === 'Escape') {
                if (draft.trim().length > 0) {
                  event.preventDefault();
                  clear();
                } else {
                  (event.target as HTMLInputElement).blur();
                }
              }
            }}
            className="min-w-0 flex-1 select-text bg-transparent text-body-sm text-on-surface outline-none placeholder:text-on-surface-variant dark:text-dark-on-surface dark:placeholder:text-dark-on-surface-variant"
          />
          {draft.length > 0 ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => clear()}
              className="shrink-0 cursor-pointer rounded p-0.5 text-on-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:text-dark-on-surface"
            >
              <X aria-hidden="true" size={16} />
            </button>
          ) : (
            <span
              aria-hidden="true"
              className="shrink-0 rounded border border-outline-variant px-1.5 py-0.5 text-label-sm text-on-surface-variant dark:border-dark-outline-variant dark:text-dark-on-surface-variant"
            >
              ⌘F
            </span>
          )}
          <button
            type="button"
            aria-label={panelOpen ? 'Hide search options' : 'Show search options'}
            aria-expanded={panelOpen}
            onClick={() => (panelOpen ? closePanel() : openPanel())}
            className="shrink-0 cursor-pointer rounded p-0.5 text-on-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:text-dark-on-surface"
          >
            {panelOpen ? (
              <ChevronUp aria-hidden="true" size={16} />
            ) : (
              <ChevronDown aria-hidden="true" size={16} />
            )}
          </button>
        </div>
        {panelOpen && (
          <AdvancedSearchPanel
            initialQuery={draft}
            labels={labels}
            scope={scope}
            onScopeChange={setScope}
            onSubmit={(query) => {
              setDraft(query);
              handleSubmit(query);
            }}
            onClose={closePanel}
          />
        )}
      </div>
    );
  },
);
