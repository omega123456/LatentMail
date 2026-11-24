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

export const SearchField = forwardRef<HTMLInputElement, { labels: MailLabel[] }>(
  function SearchField({ labels }, ref) {
    const draft = useSearchStore((search) => search.draft);
    const setDraft = useSearchStore((search) => search.setDraft);
    const scope = useSearchStore((search) => search.scope);
    const setScope = useSearchStore((search) => search.setScope);
    const panelOpen = useSearchStore((search) => search.panelOpen);
    const openPanel = useSearchStore((search) => search.openPanel);
    const closePanel = useSearchStore((search) => search.closePanel);
    const submit = useSearchStore((search) => search.submit);
    const clear = useSearchStore((search) => search.clear);
    const showError = useToastStore((toaster) => toaster.showError);

    const [activeIndex, setActiveIndex] = useState(-1);
    const [dismissed, setDismissed] = useState(false);
    const [focused, setFocused] = useState(false);
    const listboxId = useId();
    const isMac = isMacPlatform();
    const searchBinding = primaryBinding(useCommandBindings().focusSearch, isMac);
    const hasDraft = draft.length > 0;
    const shortcutLabel =
      !hasDraft && searchBinding !== null ? formatBindingLabel(searchBinding, isMac) : null;

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
            size={ICON_SIZE.lg}
            className="shrink-0 text-on-surface-variant dark:text-dark-on-surface-variant"
          />
          <Popover.Root open={open}>
            <Popover.Anchor asChild>
              <TextInput
                ref={ref}
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
                onKeyDown={(event) =>
                  handleSearchInputKeyDown(event, {
                    open: open,
                    suggestions: suggestions,
                    activeIndex: activeIndex,
                    draft: draft,
                    setActiveIndex: setActiveIndex,
                    applyAndKeepFocus: applyAndKeepFocus,
                    handleSubmit: handleSubmit,
                    clear: clear,
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
                  items={suggestions}
                  activeIndex={activeIndex}
                  onSelect={applyAndKeepFocus}
                />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <SearchFieldTrailingControls
            hasDraft={hasDraft}
            shortcutLabel={shortcutLabel}
            panelOpen={panelOpen}
            onClear={() => clear()}
            onTogglePanel={() => (panelOpen ? closePanel() : openPanel())}
          />
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
