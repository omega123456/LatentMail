import { forwardRef, useEffect, useId, useMemo, useState } from 'react';
import { Popover } from 'radix-ui';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { TextInput } from '@/components/shared/TextInput';
import { MAX_SEARCH_QUERY_LENGTH, useSearchStore } from '@/stores/search';
import { useToastStore } from '@/stores/toast';
import { AdvancedSearchPanel } from './AdvancedSearchPanel';
import { KeywordSuggestions } from './KeywordSuggestions';
import { applySuggestion, suggestionsFor, type SearchSuggestion } from './searchKeywords';
import type { MailLabel } from '@/lib/types/ipc';
import { formatBindingLabel, isMacPlatform, primaryBinding } from '@/lib/keyboard/format';
import { useCommandBindings } from '@/providers/CommandProvider';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { POPOVER_SIDE_OFFSET_PX } from '@/components/shared/floating-offsets';
import { wrapIndex } from '@/lib/collections';

type KeyDownContext = {
  open: boolean;
  suggestions: SearchSuggestion[];
  activeIndex: number;
  draft: string;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  applyAndKeepFocus: (item: SearchSuggestion) => void;
  handleSubmit: (text: string) => void;
  clear: () => void;
};

function stepActiveSuggestion(
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
  count: number,
  delta: number,
) {
  setActiveIndex((index) => (count === 0 ? -1 : wrapIndex(index, delta, count)));
}

function activeSuggestion(
  open: boolean,
  activeIndex: number,
  suggestions: SearchSuggestion[],
): SearchSuggestion | undefined {
  if (!open || activeIndex < 0) return undefined;
  return suggestions[activeIndex];
}

function handleSearchInputKeyDown(event: React.KeyboardEvent, context: KeyDownContext) {
  const { open, suggestions, activeIndex, draft } = context;
  const handlers: Record<string, () => void> = {
    ArrowDown: () => {
      if (!open) return;
      event.preventDefault();
      stepActiveSuggestion(context.setActiveIndex, suggestions.length, 1);
    },
    ArrowUp: () => {
      if (!open) return;
      event.preventDefault();
      stepActiveSuggestion(context.setActiveIndex, suggestions.length, -1);
    },
    Enter: () => {
      event.preventDefault();
      const selected = activeSuggestion(open, activeIndex, suggestions);
      if (selected) {
        context.applyAndKeepFocus(selected);
        return;
      }
      context.handleSubmit(draft);
    },
    Tab: () => {
      if (!open) return;
      event.preventDefault();
      context.applyAndKeepFocus(suggestions[activeIndex >= 0 ? activeIndex : 0]);
    },
    Escape: () => {
      if (open) return;
      if (draft.trim().length > 0) {
        event.preventDefault();
        context.clear();
        return;
      }
      (event.target as HTMLInputElement).blur();
    },
  };
  handlers[event.key]?.();
}

function SearchFieldTrailingControls({
  hasDraft,
  shortcutLabel,
  panelOpen,
  onClear,
  onTogglePanel,
}: {
  hasDraft: boolean;
  shortcutLabel: string | null;
  panelOpen: boolean;
  onClear: () => void;
  onTogglePanel: () => void;
}) {
  return (
    <>
      {hasDraft && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={onClear}
          className="shrink-0 cursor-pointer rounded p-0.5 text-on-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:text-dark-on-surface"
        >
          <X aria-hidden="true" size={ICON_SIZE.base} />
        </button>
      )}
      {shortcutLabel && (
        <span
          aria-hidden="true"
          className="shrink-0 rounded border border-outline-variant px-1.5 py-0.5 text-label-sm text-on-surface-variant dark:border-dark-outline-variant dark:text-dark-on-surface-variant"
        >
          {shortcutLabel}
        </span>
      )}
      <button
        type="button"
        aria-label={panelOpen ? 'Hide search options' : 'Show search options'}
        aria-expanded={panelOpen}
        onClick={onTogglePanel}
        className="shrink-0 cursor-pointer rounded p-0.5 text-on-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:text-dark-on-surface"
      >
        {panelOpen ? (
          <ChevronUp aria-hidden="true" size={ICON_SIZE.base} />
        ) : (
          <ChevronDown aria-hidden="true" size={ICON_SIZE.base} />
        )}
      </button>
    </>
  );
}

function useDismissOnEscape(open: boolean, onDismiss: () => void) {
  useEffect(() => {
    if (!open) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [open, onDismiss]);
}

function useSearchFieldState(labels: MailLabel[]) {
  const search = useSearchStore();
  const showError = useToastStore((toaster) => toaster.showError);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  const isMac = isMacPlatform();
  const searchBinding = primaryBinding(useCommandBindings().focusSearch, isMac);
  const hasDraft = search.draft.length > 0;
  const shortcutLabel =
    !hasDraft && searchBinding !== null ? formatBindingLabel(searchBinding, isMac) : null;
  const suggestions = useMemo(() => suggestionsFor(search.draft, labels), [search.draft, labels]);
  const open = focused && !dismissed && !search.panelOpen && suggestions.length > 0;
  useDismissOnEscape(open, () => setDismissed(true));

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed.length > MAX_SEARCH_QUERY_LENGTH) {
      showError(`Search is limited to ${MAX_SEARCH_QUERY_LENGTH} characters.`);
      return;
    }
    search.submit(trimmed);
  };

  const applyAndKeepFocus = (item: SearchSuggestion) => {
    search.setDraft(applySuggestion(search.draft, item.insert));
    setActiveIndex(-1);
  };

  return {
    search: search,
    activeIndex: activeIndex,
    setActiveIndex: setActiveIndex,
    setDismissed: setDismissed,
    setFocused: setFocused,
    hasDraft: hasDraft,
    shortcutLabel: shortcutLabel,
    suggestions: suggestions,
    open: open,
    handleSubmit: handleSubmit,
    applyAndKeepFocus: applyAndKeepFocus,
  };
}

type SearchComboboxProps = {
  inputRef: React.ForwardedRef<HTMLInputElement>;
  listboxId: string;
  state: ReturnType<typeof useSearchFieldState>;
};

function SearchCombobox({ inputRef, listboxId, state }: SearchComboboxProps) {
  const activeOptionId =
    state.open && state.activeIndex >= 0 ? `${listboxId}-option-${state.activeIndex}` : undefined;
  return (
    <Popover.Root open={state.open}>
      <Popover.Anchor asChild>
        <TextInput
          ref={inputRef}
          value={state.search.draft}
          placeholder="Search mail…"
          aria-label="Search mail"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={state.open}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          onFocus={() => state.setFocused(true)}
          onBlur={() => state.setFocused(false)}
          onChange={(event) => {
            state.search.setDraft(event.target.value);
            state.setActiveIndex(-1);
            state.setDismissed(false);
          }}
          onKeyDown={(event) =>
            handleSearchInputKeyDown(event, {
              open: state.open,
              suggestions: state.suggestions,
              activeIndex: state.activeIndex,
              draft: state.search.draft,
              setActiveIndex: state.setActiveIndex,
              applyAndKeepFocus: state.applyAndKeepFocus,
              handleSubmit: state.handleSubmit,
              clear: state.search.clear,
            })
          }
          variant="bare"
          className="min-w-0 flex-1 text-body-sm text-on-surface placeholder:text-on-surface-variant dark:text-dark-on-surface dark:placeholder:text-dark-on-surface-variant"
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={POPOVER_SIDE_OFFSET_PX}
          onOpenAutoFocus={(event) => event.preventDefault()}
          style={{ width: 'var(--radix-popover-trigger-width)' }}
          className="z-50 max-h-64 overflow-auto rounded-md border border-outline-variant bg-surface-container-lowest p-1 shadow-lg dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
        >
          <KeywordSuggestions
            id={listboxId}
            items={state.suggestions}
            activeIndex={state.activeIndex}
            onSelect={state.applyAndKeepFocus}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export const SearchField = forwardRef<HTMLInputElement, { labels: MailLabel[] }>(
  function SearchField({ labels }, ref) {
    const listboxId = useId();
    const state = useSearchFieldState(labels);
    const { search } = state;

    return (
      <div role="search" aria-label="Mail search" className="relative w-full max-w-2xl">
        <div className="flex items-center gap-2 rounded-full bg-surface-container-low px-3 py-2 transition-colors hover:bg-surface-container focus-within:outline-2 focus-within:outline-primary dark:bg-dark-surface-container-low dark:hover:bg-dark-surface-container">
          <Search
            aria-hidden="true"
            size={ICON_SIZE.lg}
            className="shrink-0 text-on-surface-variant dark:text-dark-on-surface-variant"
          />
          <SearchCombobox inputRef={ref} listboxId={listboxId} state={state} />
          <SearchFieldTrailingControls
            hasDraft={state.hasDraft}
            shortcutLabel={state.shortcutLabel}
            panelOpen={search.panelOpen}
            onClear={() => search.clear()}
            onTogglePanel={() => (search.panelOpen ? search.closePanel() : search.openPanel())}
          />
        </div>
        {search.panelOpen && (
          <AdvancedSearchPanel
            initialQuery={search.draft}
            labels={labels}
            scope={search.scope}
            onScopeChange={search.setScope}
            onSubmit={(query) => {
              search.setDraft(query);
              state.handleSubmit(query);
            }}
            onClose={search.closePanel}
          />
        )}
      </div>
    );
  },
);
