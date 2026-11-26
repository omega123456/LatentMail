import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import { wrapIndex } from '@/lib/collections';
import { parseParticipant } from '@/lib/format/participants';
import { CONTACT_QUERY_MIN_LENGTH, useContactSuggestionsQuery } from '@/lib/query/hooks';
import type { ContactSuggestion } from '@/lib/types/ipc';
import { type RecipientRole, useComposeStore } from '@/stores/compose';
import { useEscapeCapture } from './useEscapeCapture';

const CHIP_ROWS_3_PX = 96;
const CONTACT_LOOKUP_DEBOUNCE_MS = 150;

function useDebouncedValue(liveValue: string, delayMs: number) {
  const [debounced, setDebounced] = useState(liveValue);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(liveValue), delayMs);
    return () => clearTimeout(timer);
  }, [liveValue, delayMs]);
  return debounced;
}

export function chipLabel(raw: string) {
  const { name, address } = parseParticipant(raw);
  return name || address;
}

function activeSuggestionFor(
  open: boolean,
  activeIndex: number,
  suggestions: ContactSuggestion[],
): ContactSuggestion | undefined {
  if (!open || activeIndex < 0) return undefined;
  return suggestions[activeIndex];
}

function stepSuggestionIndex(
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
  count: number,
  delta: number,
) {
  setActiveIndex((index) => (count === 0 ? -1 : wrapIndex(index, delta, count)));
}

function dispatchRecipientKeyDown(
  event: KeyboardEvent<HTMLInputElement>,
  context: {
    open: boolean;
    suggestions: ContactSuggestion[];
    activeIndex: number;
    inputValue: string;
    setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
    selectSuggestion: (item: ContactSuggestion) => void;
    commit: () => void;
    removeLast: () => void;
  },
) {
  const handlers: Record<string, () => void> = {
    ArrowDown: () => {
      if (!context.open) return;
      event.preventDefault();
      stepSuggestionIndex(context.setActiveIndex, context.suggestions.length, 1);
    },
    ArrowUp: () => {
      if (!context.open) return;
      event.preventDefault();
      stepSuggestionIndex(context.setActiveIndex, context.suggestions.length, -1);
    },
    Enter: () => {
      event.preventDefault();
      const active = activeSuggestionFor(context.open, context.activeIndex, context.suggestions);
      if (active) {
        context.selectSuggestion(active);
        return;
      }
      context.commit();
    },
    ',': () => {
      event.preventDefault();
      context.commit();
    },
    Tab: () => context.commit(),
    Backspace: () => {
      if (context.inputValue === '') context.removeLast();
    },
  };
  handlers[event.key]?.();
}

export function useRecipientOverflow(
  chipListRef: RefObject<HTMLDivElement | null>,
  fieldRole: RecipientRole,
  chipCount: number,
) {
  const setOverflowCount = useComposeStore((compose) => compose.setOverflowCount);
  const [visibleCount, setVisibleCount] = useState(chipCount);
  const [measuredForLength, setMeasuredForLength] = useState(chipCount);

  if (chipCount !== measuredForLength) {
    setMeasuredForLength(chipCount);
    setVisibleCount(chipCount);
  }

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
  }, [chipListRef]);

  const hiddenCount = chipCount - visibleCount;
  useEffect(() => {
    setOverflowCount(fieldRole, Math.max(hiddenCount, 0));
  }, [hiddenCount, fieldRole, setOverflowCount]);

  return {
    visibleCount: visibleCount,
    hiddenCount: hiddenCount,
    expandAll: () => setVisibleCount(chipCount),
  };
}

function formatSuggestionAddress(item: ContactSuggestion): string {
  return item.displayName ? `${item.displayName} <${item.address}>` : item.address;
}

function useDebouncedSuggestions(accountId: string | null, trimmedQuery: string) {
  const debouncedQuery = useDebouncedValue(trimmedQuery, CONTACT_LOOKUP_DEBOUNCE_MS);
  return useContactSuggestionsQuery(accountId, debouncedQuery).data ?? [];
}

export function useRecipientFieldController(fieldRole: RecipientRole, accountId: string | null) {
  const commitRecipient = useComposeStore((compose) => compose.commitRecipient);
  const removeLastRecipient = useComposeStore((compose) => compose.removeLastRecipient);
  const [inputValue, setInputValue] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dismissed, setDismissed] = useState(false);

  const trimmedQuery = inputValue.trim();
  const suggestions = useDebouncedSuggestions(accountId, trimmedQuery);
  const open =
    !dismissed && trimmedQuery.length >= CONTACT_QUERY_MIN_LENGTH && suggestions.length > 0;
  useEscapeCapture(open, () => setDismissed(true));

  const resetInput = (nextDismissed: boolean) => {
    setInputValue('');
    setActiveIndex(-1);
    setDismissed(nextDismissed);
  };

  const commit = () => {
    if (!trimmedQuery) return;
    commitRecipient(fieldRole, inputValue);
    resetInput(false);
  };

  const selectSuggestion = (item: ContactSuggestion) => {
    commitRecipient(fieldRole, formatSuggestionAddress(item));
    resetInput(true);
  };

  const handleInputChange = (nextValue: string) => {
    setInputValue(nextValue);
    setActiveIndex(-1);
    setDismissed(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) =>
    dispatchRecipientKeyDown(event, {
      open: open,
      suggestions: suggestions,
      activeIndex: activeIndex,
      inputValue: inputValue,
      setActiveIndex: setActiveIndex,
      selectSuggestion: selectSuggestion,
      commit: commit,
      removeLast: () => removeLastRecipient(fieldRole),
    });

  return {
    inputValue,
    activeIndex,
    suggestions,
    open,
    commit,
    selectSuggestion,
    handleInputChange,
    handleKeyDown,
  };
}
