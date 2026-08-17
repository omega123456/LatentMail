import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Popover } from 'radix-ui';
import { X } from 'lucide-react';
import { ContactSuggestions } from './ContactSuggestions';
import { useContactSuggestionsQuery } from '@/lib/query/hooks';
import { parseParticipant } from '@/lib/format/participants';
import { type RecipientRole, useComposeStore } from '@/stores/compose';
import type { ContactSuggestion } from '@/lib/types/ipc';

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
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span
        id={`${listboxId}-label`}
        className="w-13 shrink-0 text-label-md text-secondary dark:text-dark-secondary"
      >
        {label}
      </span>
      <Popover.Root open={open}>
        <Popover.Anchor asChild>
          <div className="flex min-w-0 flex-1 flex-col">
            <div ref={chipListRef} className="flex flex-wrap items-center gap-1">
              {chips.slice(0, visibleCount).map((chip, index) => (
                <span
                  key={`${chip}-${index}`}
                  className="inline-flex items-center gap-1 rounded-full bg-surface-container-high py-0.5 pl-2 pr-1 text-snippet text-on-surface dark:bg-dark-surface-container-high dark:text-dark-on-surface"
                >
                  {chipLabel(chip)}
                  <button
                    type="button"
                    aria-label={`Remove ${chipLabel(chip)}`}
                    title={`Remove ${chipLabel(chip)}`}
                    onClick={() => removeRecipient(fieldRole, index)}
                    className="cursor-pointer rounded-full text-secondary hover:bg-surface-container-highest hover:text-on-surface dark:text-dark-secondary dark:hover:bg-dark-surface-container-highest dark:hover:text-dark-on-surface"
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
                  className="cursor-pointer rounded-sm px-1.5 py-0.5 text-label-md text-primary hover:bg-surface-container-high dark:text-dark-primary dark:hover:bg-dark-surface-container-high"
                >
                  +{hiddenCount} more
                </button>
              )}
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
            </div>
          </div>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            onOpenAutoFocus={(event) => event.preventDefault()}
            style={{ width: 'var(--radix-popover-trigger-width)' }}
            className="z-50 max-h-64 overflow-auto rounded-md border border-outline-variant bg-surface-container-lowest p-1 shadow-lg dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
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
  );
}
