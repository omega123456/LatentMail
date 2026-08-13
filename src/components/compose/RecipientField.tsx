import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Popover } from 'radix-ui';
import { X } from 'lucide-react';
import { ContactSuggestions } from './ContactSuggestions';
import { useContactSuggestionsQuery } from '@/lib/query/hooks';
import { parseParticipant } from '@/lib/format/participants';
import { type RecipientRole, useComposeStore } from '@/stores/compose';
import type { ContactSuggestion } from '@/lib/types/ipc';

/** The container clamps its natural height to this many pixels — matching
 * `--spacing-chip-rows-3` in `index.css` — before chips collapse behind the
 * overflow control. jsdom never lays elements out, so this comparison is
 * exercised in tests by driving the ResizeObserver harness directly. */
const CHIP_ROWS_3_PX = 96;

function useDebouncedValue(value: string, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function chipLabel(raw: string) {
  const { name, address } = parseParticipant(raw);
  return name || address;
}

export function RecipientField({
  fieldRole,
  label,
  accountId,
  placeholder,
  inputRef,
}: {
  /** Named `fieldRole` rather than `role` — an ARIA-lint false positive
   * (`jsx-a11y/aria-role`) fires on any JSX attribute literally named
   * `role`, even on a custom component that never forwards it to a DOM
   * node's `role` attribute. */
  fieldRole: RecipientRole;
  label: string;
  accountId: string | null;
  placeholder: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const session = useComposeStore((state) => state.session);
  const commitRecipient = useComposeStore((state) => state.commitRecipient);
  const removeRecipient = useComposeStore((state) => state.removeRecipient);
  const removeLastRecipient = useComposeStore((state) => state.removeLastRecipient);
  const setOverflowCount = useComposeStore((state) => state.setOverflowCount);
  const chips = session?.recipients[fieldRole] ?? [];

  const [inputValue, setInputValue] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const [visibleCount, setVisibleCount] = useState(chips.length);
  // Re-attempt showing every chip whenever the committed set changes size —
  // the observer below trims it back down if it still overflows. Adjusted
  // during render (React's documented "adjusting state when a prop
  // changes" pattern) rather than in an effect, so it never causes an
  // extra committed render.
  const [measuredForLength, setMeasuredForLength] = useState(chips.length);
  if (chips.length !== measuredForLength) {
    setMeasuredForLength(chips.length);
    setVisibleCount(chips.length);
  }
  const chipListRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const trimmedQuery = inputValue.trim();
  const debouncedQuery = useDebouncedValue(trimmedQuery, 150);
  const suggestionsQuery = useContactSuggestionsQuery(accountId, debouncedQuery);
  const suggestions: ContactSuggestion[] = suggestionsQuery.data ?? [];
  const open = !dismissed && trimmedQuery.length >= 2 && suggestions.length > 0;

  useEffect(() => {
    const node = chipListRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      if (height > CHIP_ROWS_3_PX) {
        setVisibleCount((count) => (count > 0 ? count - 1 : count));
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const hiddenCount = chips.length - visibleCount;
  useEffect(() => {
    setOverflowCount(fieldRole, Math.max(hiddenCount, 0));
  }, [hiddenCount, fieldRole, setOverflowCount]);

  const commit = () => {
    if (!trimmedQuery) return;
    commitRecipient(fieldRole, inputValue);
    setInputValue('');
    setActiveIndex(-1);
    setDismissed(false);
  };

  const selectSuggestion = (item: ContactSuggestion) => {
    const value = item.displayName ? `${item.displayName} <${item.address}>` : item.address;
    commitRecipient(fieldRole, value);
    setInputValue('');
    setActiveIndex(-1);
    setDismissed(true);
  };

  // Radix's Dialog dismisses on Escape via a `document`-level *capture*
  // listener, which fires before this input's own (bubble-phase) onKeyDown
  // ever runs — a React `stopPropagation()` there would be too late. A
  // `window`-level capture listener, registered only while suggestions are
  // open, intercepts Escape first and stops it reaching `document`, so
  // Escape dismisses the popover without also closing the composer.
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

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
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
        selectSuggestion(suggestions[activeIndex]);
      } else {
        commit();
      }
      return;
    }
    if (event.key === ',') {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === 'Tab') {
      commit();
      return;
    }
    if (event.key === 'Backspace' && inputValue === '') {
      removeLastRecipient(fieldRole);
    }
  };

  const activeOptionId =
    open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;

  return (
    <div className="flex min-w-0 flex-1 items-start gap-1">
      <span
        id={`${listboxId}-label`}
        className="w-13 shrink-0 pt-1 text-label-md text-secondary dark:text-dark-secondary"
      >
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={chipListRef} className="flex flex-wrap items-center gap-1">
          {chips.slice(0, visibleCount).map((chip, index) => (
            <span
              key={`${chip}-${index}`}
              className="inline-flex items-center gap-1 rounded-full bg-surface-container-high px-2 py-0.5 text-body-sm text-on-surface dark:bg-dark-surface-container-high dark:text-dark-on-surface"
            >
              {chipLabel(chip)}
              <button
                type="button"
                aria-label={`Remove ${chipLabel(chip)}`}
                title={`Remove ${chipLabel(chip)}`}
                onClick={() => removeRecipient(fieldRole, index)}
                className="rounded-full text-secondary hover:text-error dark:text-dark-secondary dark:hover:text-dark-error"
              >
                <X aria-hidden="true" size={12} />
              </button>
            </span>
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              aria-label={`${hiddenCount} more recipient${hiddenCount === 1 ? '' : 's'} hidden`}
              title={`${hiddenCount} more recipient${hiddenCount === 1 ? '' : 's'} hidden`}
              onClick={() => setVisibleCount(chips.length)}
              className="rounded-full bg-surface-container px-2 py-0.5 text-label-md text-secondary hover:text-on-surface dark:bg-dark-surface-container dark:text-dark-secondary dark:hover:text-dark-on-surface"
            >
              +{hiddenCount} more
            </button>
          )}
          <Popover.Root open={open}>
            <Popover.Anchor asChild>
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                placeholder={chips.length === 0 ? placeholder : undefined}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-activedescendant={activeOptionId}
                aria-labelledby={`${listboxId}-label`}
                onChange={(event) => {
                  setInputValue(event.target.value);
                  setActiveIndex(-1);
                  setDismissed(false);
                }}
                onKeyDown={handleKeyDown}
                onBlur={commit}
                className="min-w-24 flex-1 bg-transparent text-body-md text-on-surface outline-none placeholder:text-outline dark:text-dark-on-surface dark:placeholder:text-dark-outline"
              />
            </Popover.Anchor>
            <Popover.Portal>
              <Popover.Content
                align="start"
                sideOffset={4}
                onOpenAutoFocus={(event) => event.preventDefault()}
                className="z-50 max-h-64 w-72 overflow-auto rounded-md border border-outline-variant bg-surface-container-lowest shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
              >
                <ContactSuggestions
                  id={listboxId}
                  items={suggestions}
                  activeIndex={activeIndex}
                  onSelect={selectSuggestion}
                />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </div>
    </div>
  );
}
