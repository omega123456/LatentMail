import { useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import type { LabelMenuEntry } from '@/components/actions/LabelsMenu';
import type { ComposeAction } from '@/lib/compose/entry';
import type { ThreadTriageIntent } from '@/lib/query/mutations';
import { selectedRowIds, starToggleIntent } from '@/lib/triage/intents';
import type { Conversation } from '@/lib/types/conversation';
import { useLayoutStore } from '@/stores/layout';
import { selectIsMultiSelectActive, useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';
import { ConversationRow } from './ConversationRow';
import { intersectSystemLabelIds, SearchIncompleteNotice } from './conversation-list-status';

type ConversationRowItemProps = {
  row: Conversation;
  index: number;
  allLabels: LabelMenuEntry[];
  selectionSystemLabelIds: string[];
  currentFolderId?: string;
  composeTargetThreadId?: string | null;
  onRowClick: (event: ReactMouseEvent, index: number) => void;
  onToggleStar: (row: Conversation) => void;
  onTriage?: (threadIds: string[], intent: ThreadTriageIntent) => void;
  onCompose?: (threadId: string, action: ComposeAction) => void;
};

function ConversationRowItem(props: ConversationRowItemProps) {
  const { row, index } = props;
  const density = useLayoutStore((layout) => layout.density);
  const cursor = useSelectionStore((selection) => selection.keyboardCursor);
  const flashThreadId = useSelectionStore((selection) => selection.flashThreadId);
  const selectedIds = useMultiSelectStore((multiSelect) => multiSelect.selectedIds);
  const multiSelectActive = useMultiSelectStore(selectIsMultiSelectActive);

  return (
    <ConversationRow
      conversation={row}
      density={density}
      active={cursor === index}
      selected={selectedIds.has(row.id)}
      flash={flashThreadId === row.id}
      onFlashComplete={() => useSelectionStore.getState().setFlashThreadId(null)}
      multiSelectActive={multiSelectActive}
      allLabels={props.allLabels}
      selectionCount={selectedIds.size}
      selectionSystemLabelIds={props.selectionSystemLabelIds}
      currentFolderId={props.currentFolderId}
      onOpen={(event) => props.onRowClick(event, index)}
      onStar={() => props.onToggleStar(row)}
      onTriage={(intent) =>
        props.onTriage?.(selectedRowIds(row.id, selectedIds, multiSelectActive), intent)
      }
      onCompose={
        !multiSelectActive && row.id === props.composeTargetThreadId
          ? (action) => props.onCompose?.(row.id, action)
          : undefined
      }
    />
  );
}

export type VirtualizedConversationRowsProps = {
  rows: Conversation[];
  rowHeight: number;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  showIncompleteNotice: boolean;
  hasMoreFixturePages: boolean;
  allLabels: LabelMenuEntry[];
  currentFolderId?: string;
  composeTargetThreadId?: string | null;
  onRowClick: (event: ReactMouseEvent, index: number) => void;
  onTriage?: (threadIds: string[], intent: ThreadTriageIntent) => void;
  onCompose?: (threadId: string, action: ComposeAction) => void;
};

export function VirtualizedConversationRows(props: VirtualizedConversationRowsProps) {
  'use no memo';
  const { rows, rowHeight, virtualizer } = props;
  const selectedIds = useMultiSelectStore((multiSelect) => multiSelect.selectedIds);
  const multiSelectActive = useMultiSelectStore(selectIsMultiSelectActive);
  const selectionSystemLabelIds = useMemo(
    () => intersectSystemLabelIds(rows.filter((row) => selectedIds.has(row.id))),
    [rows, selectedIds],
  );
  const items = virtualizer.getVirtualItems();
  const visible = items.length
    ? items
    : rows.map((_row, index) => ({ key: index, index: index, start: index * rowHeight }));

  const toggleStarForRow = (row: Conversation) => {
    const ids = selectedRowIds(row.id, selectedIds, multiSelectActive);
    const starred = rows.some((candidate) => ids.includes(candidate.id) && candidate.starred);
    props.onTriage?.(ids, starToggleIntent(starred));
  };

  return (
    <>
      <SearchIncompleteNotice visible={props.showIncompleteNotice} />
      <div style={{ height: `${virtualizer.getTotalSize()}px` }} className="relative">
        {visible.map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <ConversationRowItem
              row={rows[item.index]}
              index={item.index}
              allLabels={props.allLabels}
              selectionSystemLabelIds={selectionSystemLabelIds}
              currentFolderId={props.currentFolderId}
              composeTargetThreadId={props.composeTargetThreadId}
              onRowClick={props.onRowClick}
              onToggleStar={toggleStarForRow}
              onTriage={props.onTriage}
              onCompose={props.onCompose}
            />
          </div>
        ))}
      </div>
      <p className="p-stack-gap-sm text-center text-label-sm text-secondary dark:text-dark-secondary">
        {props.hasMoreFixturePages ? 'Loading more conversations…' : 'End of conversations'}
      </p>
    </>
  );
}
