import { forwardRef, useEffect, useId, useMemo, useState } from 'react';
import { Popover } from 'radix-ui';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { MAX_SEARCH_QUERY_LENGTH, useSearchStore } from '@/stores/search';
import { useToastStore } from '@/stores/toast';
import { AdvancedSearchPanel } from './AdvancedSearchPanel';
import { KeywordSuggestions } from './KeywordSuggestions';
import { applySuggestion, suggestionsFor, type SearchSuggestion } from './searchKeywords';
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

    const [activeIndex, setActiveIndex] = useState(-1);
    const [dismissed, setDismissed] = useState(false);
    const [focused, setFocused] = useState(false);
    const listboxId = useId();

    const suggestions = useMemo(() => suggestionsFor(draft, labels), [draft, labels]);
    const open = focused && !dismissed && !panelOpen && suggestions.length > 0;

    useEffect(() => {
      if (!open) return;
      const handler = (event: globalThis.KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          setDismissed(true);
        }
      };
      window.addEventListener('keydown', handler, { capture: true });
      return () => window.removeEventListener('keydown', handler, { capture: true });
    }, [open]);

    const handleSubmit = (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      if (trimmed.length > MAX_SEARCH_QUERY_LENGTH) {
        showError(`Search is limited to ${MAX_SEARCH_QUERY_LENGTH} characters.`);
        return;
      }
      submit(trimmed);
    };

    const applyAndKeepFocus = (item: SearchSuggestion) => {
      setDraft(applySuggestion(draft, item.insert));
      setActiveIndex(-1);
    };

    const activeOptionId =
      open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;

    return (
      <div role="search" aria-label="Mail search" className="relative w-full max-w-2xl">
        <div className="flex items-center gap-2 rounded-full bg-surface-container-low px-3 py-2 transition-colors hover:bg-surface-container focus-within:outline-2 focus-within:outline-primary dark:bg-dark-surface-container-low dark:hover:bg-dark-surface-container">
          <Search
            aria-hidden="true"
            size={18}
            className="shrink-0 text-on-surface-variant dark:text-dark-on-surface-variant"
          />
          <Popover.Root open={open}>
            <Popover.Anchor asChild>
              <input
                ref={ref}
                type="text"
                value={draft}
                placeholder="Search mail…"
                aria-label="Search mail"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-activedescendant={activeOptionId}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setActiveIndex(-1);
                  setDismissed(false);
                }}
                onKeyDown={(event) => {
                  if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                    event.preventDefault();
                    const count = suggestions.length;
                    const delta = event.key === 'ArrowDown' ? 1 : -1;
                    setActiveIndex((index) => (count === 0 ? -1 : (index + delta + count) % count));
                    return;
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (open && activeIndex >= 0 && suggestions[activeIndex]) {
                      applyAndKeepFocus(suggestions[activeIndex]);
                    } else {
                      handleSubmit(draft);
                    }
                    return;
                  }
                  if (event.key === 'Tab' && open) {
                    event.preventDefault();
                    applyAndKeepFocus(suggestions[activeIndex >= 0 ? activeIndex : 0]);
                    return;
                  }
                  if (event.key === 'Escape' && !open) {
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
            </Popover.Anchor>
            <Popover.Portal>
              <Popover.Content
                align="start"
                sideOffset={6}
                onOpenAutoFocus={(event) => event.preventDefault()}
                style={{ width: 'var(--radix-popover-trigger-width)' }}
                className="z-50 max-h-64 overflow-auto rounded-md border border-outline-variant bg-surface-container-lowest p-1 shadow-lg dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
              >
                <KeywordSuggestions
                  id={listboxId}
                  items={suggestions}
                  activeIndex={activeIndex}
                  onSelect={applyAndKeepFocus}
                />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
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
