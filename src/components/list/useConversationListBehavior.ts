import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import { useCommands } from '@/lib/keyboard/useCommands';
import type { ThreadTriageIntent } from '@/lib/query/mutations';
import { starToggleIntent } from '@/lib/triage/intents';
import { selectIsMultiSelectActive, useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';
import type { Conversation } from '@/lib/types/conversation';

function hasRowModifier(event: ReactMouseEvent): boolean {
  return event.shiftKey || event.metaKey || event.ctrlKey;
}

export function useConversationListPagination(
  pages: Conversation[][] | undefined,
  threads: Conversation[],
  mailboxId: string,
) {
  const [fixturePage, setFixturePage] = useState(0);
  const [source, setSource] = useState(() => ({ pages, threads, mailboxId }));
  const sourceChanged =
    source.pages !== pages || source.threads !== threads || source.mailboxId !== mailboxId;
  if (sourceChanged) {
    setSource({ pages, threads, mailboxId });
    setFixturePage(0);
  }
  const rows = useMemo(
    () => (pages ? pages.slice(0, fixturePage + 1).flat() : threads),
    [pages, fixturePage, threads],
  );
  const loadNextPage = () => {
    if (!pages || fixturePage >= pages.length - 1) return;
    setFixturePage((current) => current + 1);
  };
  return { rows: rows, fixturePage: fixturePage, loadNextPage: loadNextPage };
}

export function useScrollSynchronization(input: {
  parentRef: RefObject<HTMLDivElement | null>;
  rows: Conversation[];
  density: string;
  mailboxId: string;
  searchActive: boolean;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
}) {
  const { parentRef, rows, density, mailboxId, searchActive, virtualizer } = input;
  const previousRows = useRef(rows);
  const previousHeight = useRef(0);
  const flashThreadId = useSelectionStore((selection) => selection.flashThreadId);
  const setCursor = useSelectionStore((selection) => selection.setKeyboardCursor);
  const setFlashThreadId = useSelectionStore((selection) => selection.setFlashThreadId);

  useLayoutEffect(() => {
    const parent = parentRef.current;
    const headChanged =
      Boolean(previousRows.current[0] && rows[0]) && previousRows.current[0].id !== rows[0].id;
    if (parent && headChanged && parent.scrollTop > 0) {
      parent.scrollTop += parent.scrollHeight - previousHeight.current;
    }
    previousRows.current = rows;
    previousHeight.current = parent?.scrollHeight ?? 0;
  }, [parentRef, rows]);

  useEffect(() => {
    virtualizer.measure();
  }, [density, virtualizer]);

  useLayoutEffect(() => {
    previousRows.current = [];
    previousHeight.current = 0;
    virtualizer.scrollToOffset(0);
  }, [mailboxId, searchActive, virtualizer]);

  useEffect(() => {
    if (!flashThreadId) return;
    const index = rows.findIndex((row) => row.id === flashThreadId);
    if (index < 0) return;
    setCursor(index);
    virtualizer.scrollToIndex(index, { align: 'auto' });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setFlashThreadId(null);
  }, [flashThreadId, rows, setCursor, setFlashThreadId, virtualizer]);
}

function buildTriageCommands(input: {
  rows: Conversation[];
  rowIds: string[];
  commandTargetIds: () => string[];
  selectAll: (ids: string[]) => void;
  onTriage?: (threadIds: string[], intent: ThreadTriageIntent) => void;
}) {
  return {
    selectAll: (event: KeyboardEvent) => {
      event.preventDefault();
      input.selectAll(input.rowIds);
    },
    toggleStar: () => {
      const ids = input.commandTargetIds();
      if (!ids.length) return;
      const starred = input.rows.some((row) => ids.includes(row.id) && row.starred);
      input.onTriage?.(ids, starToggleIntent(starred));
    },
    markRead: () =>
      input.onTriage?.(input.commandTargetIds(), { kind: 'label', add: [], remove: ['UNREAD'] }),
    markUnread: () =>
      input.onTriage?.(input.commandTargetIds(), { kind: 'label', add: ['UNREAD'], remove: [] }),
    markSpam: () =>
      input.onTriage?.(input.commandTargetIds(), { kind: 'move', destination: 'SPAM' }),
    markNotSpam: () =>
      input.onTriage?.(input.commandTargetIds(), { kind: 'move', destination: 'INBOX' }),
    deleteConversation: () => input.onTriage?.(input.commandTargetIds(), { kind: 'delete' }),
  };
}

function useCursorNavigation(
  rows: Conversation[],
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  openRow: (index: number) => void,
) {
  const cursor = useSelectionStore((selection) => selection.keyboardCursor);
  const moveCursor = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const from = cursor ?? (delta > 0 ? -1 : rows.length);
      const next = Math.min(rows.length - 1, Math.max(0, from + delta));
      openRow(next);
      virtualizer.scrollToIndex(next, { align: 'auto' });
    },
    [cursor, openRow, rows.length, virtualizer],
  );
  return { cursor: cursor, moveCursor: moveCursor };
}

export function useConversationListCommands(input: {
  rows: Conversation[];
  rowIds: string[];
  rowHeight: number;
  parentRef: RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  openRow: (index: number) => void;
  onTriage?: (threadIds: string[], intent: ThreadTriageIntent) => void;
}) {
  const { rows, rowIds, rowHeight, parentRef, virtualizer, openRow, onTriage } = input;
  const { cursor, moveCursor } = useCursorNavigation(rows, virtualizer, openRow);
  const setCursor = useSelectionStore((selection) => selection.setKeyboardCursor);
  const setThread = useSelectionStore((selection) => selection.setActiveThreadId);
  const selectedIds = useMultiSelectStore((multiSelect) => multiSelect.selectedIds);
  const multiSelectActive = useMultiSelectStore(selectIsMultiSelectActive);
  const selectAll = useMultiSelectStore((multiSelect) => multiSelect.selectAll);
  const clearMultiSelect = useMultiSelectStore((multiSelect) => multiSelect.clear);

  const visibleRowCount = () =>
    Math.max(1, Math.floor((parentRef.current?.clientHeight ?? rowHeight) / rowHeight) - 1);

  const commandTargetIds = (): string[] => {
    if (multiSelectActive) return [...selectedIds];
    const cursorRow = cursor === null ? undefined : rows[cursor];
    return cursorRow ? [cursorRow.id] : [];
  };

  useCommands({
    moveCursorDown: (event) => {
      event.preventDefault();
      moveCursor(1);
    },
    moveCursorUp: (event) => {
      event.preventDefault();
      moveCursor(-1);
    },
    pageCursorDown: (event) => {
      event.preventDefault();
      moveCursor(visibleRowCount());
    },
    pageCursorUp: (event) => {
      event.preventDefault();
      moveCursor(-visibleRowCount());
    },
    openConversation: () => {
      if (cursor !== null) openRow(cursor);
    },
    dismiss: () => {
      if (multiSelectActive) {
        clearMultiSelect();
        return;
      }
      setThread(null);
      setCursor(null);
    },
    ...buildTriageCommands({ rows, rowIds, commandTargetIds, selectAll, onTriage }),
  });
}

export function useRowInteraction(input: {
  rows: Conversation[];
  rowIds: string[];
  onTriage?: (threadIds: string[], intent: ThreadTriageIntent) => void;
}) {
  const { rows, rowIds, onTriage } = input;
  const cursor = useSelectionStore((selection) => selection.keyboardCursor);
  const setCursor = useSelectionStore((selection) => selection.setKeyboardCursor);
  const setThread = useSelectionStore((selection) => selection.setActiveThreadId);
  const multiSelectActive = useMultiSelectStore(selectIsMultiSelectActive);
  const toggleSelected = useMultiSelectStore((multiSelect) => multiSelect.toggle);
  const selectRange = useMultiSelectStore((multiSelect) => multiSelect.selectRange);
  const pruneSelected = useMultiSelectStore((multiSelect) => multiSelect.prune);

  useEffect(() => {
    pruneSelected(rowIds);
  }, [rowIds, pruneSelected]);

  const openRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setCursor(index);
      setThread(row.id);
      if (row.unread) onTriage?.([row.id], { kind: 'label', add: [], remove: ['UNREAD'] });
    },
    [onTriage, rows, setCursor, setThread],
  );

  const handleRowClick = useCallback(
    (event: ReactMouseEvent, index: number) => {
      const row = rows[index];
      if (!row) return;
      const activeId = cursor === null ? undefined : rows[cursor]?.id;
      if (hasRowModifier(event) && !multiSelectActive && activeId) toggleSelected(activeId);
      if (event.shiftKey) {
        selectRange(rowIds, row.id);
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        toggleSelected(row.id);
        return;
      }
      openRow(index);
    },
    [cursor, multiSelectActive, rows, rowIds, selectRange, toggleSelected, openRow],
  );

  return { openRow: openRow, handleRowClick: handleRowClick };
}
