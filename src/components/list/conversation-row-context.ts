import type { MouseEvent as ReactMouseEvent } from 'react';
import type { LabelMenuEntry } from '@/components/actions/LabelsMenu';
import type { MoveDestinationId } from '@/components/actions/MoveToMenu';
import type { ComposeAction } from '@/lib/compose/entry';
import { sourceBadge, userBadgesByName } from '@/lib/labels/badges';
import type { ThreadTriageIntent } from '@/lib/query/mutations';
import { readToggleIntent, spamToggleIntent } from '@/lib/triage/intents';
import type { Conversation } from '@/lib/types/conversation';
import type { Density } from '@/lib/types/ipc';

export type RowVisualState = 'selected' | 'active' | 'idle';

export type ConversationRowProps = {
  conversation: Conversation;
  density: Density;
  active: boolean;
  selected?: boolean;
  flash?: boolean;
  onFlashComplete?: () => void;
  multiSelectActive?: boolean;
  allLabels?: LabelMenuEntry[];
  selectionCount?: number;
  selectionSystemLabelIds?: string[];
  currentFolderId?: string;
  onOpen: (event: ReactMouseEvent) => void;
  onStar: () => void;
  onTriage?: (intent: ThreadTriageIntent) => void;
  onCompose?: (action: ComposeAction) => void;
};

export const ROW_STATE_CLASSES: Record<RowVisualState, string> = {
  selected: 'border-primary/30 bg-primary/10 dark:border-dark-primary/30 dark:bg-dark-primary/10',
  active:
    'border-primary/20 bg-surface-container-highest shadow-sm dark:border-dark-primary/20 dark:bg-dark-surface-container-highest',
  idle: 'border-transparent hover:border-outline-variant/30 hover:bg-surface-container-low dark:hover:border-dark-outline-variant/30 dark:hover:bg-dark-surface-container-low',
};

export const NOTCH_RING_CLASSES: Record<RowVisualState, string> = {
  selected: 'ring-primary/10 dark:ring-dark-primary/10',
  active: 'ring-surface-container-highest dark:ring-dark-surface-container-highest',
  idle: 'ring-surface group-hover:ring-surface-container-low dark:ring-dark-surface-container dark:group-hover:ring-dark-surface-container-low',
};

function visualStateFor(selected: boolean, showActive: boolean): RowVisualState {
  if (selected) return 'selected';
  if (showActive) return 'active';
  return 'idle';
}

export function formatRowSubject(conversation: Conversation): string {
  const countSuffix =
    conversation.messageCount && conversation.messageCount > 1
      ? ` (${conversation.messageCount})`
      : '';
  const draftSuffix = conversation.draft ? ' · Draft' : '';
  return `${conversation.subject}${countSuffix}${draftSuffix}`;
}

function composeMenuCallbacks(
  draft: boolean | undefined,
  onCompose?: (action: ComposeAction) => void,
) {
  if (!onCompose) {
    return {
      onReply: undefined,
      onReplyAll: undefined,
      onForward: undefined,
      onEditDraft: undefined,
    };
  }
  return {
    onReply: () => onCompose('reply'),
    onReplyAll: () => onCompose('reply-all'),
    onForward: () => onCompose('forward'),
    onEditDraft: draft ? () => onCompose('edit-draft') : undefined,
  };
}

function noop() {
  return undefined;
}

export function resolveRowPresentation(props: ConversationRowProps) {
  const { conversation, density, active } = props;
  const selected = props.selected ?? false;
  const multiSelectActive = props.multiSelectActive ?? false;
  const flash = props.flash ?? false;
  const allLabels = props.allLabels ?? [];
  const compact = density === 'compact';
  const showActive = active && !multiSelectActive;
  const visualState = visualStateFor(selected, showActive);
  const source = sourceBadge(conversation.systemLabelIds);
  return {
    selected: selected,
    flash: flash,
    compact: compact,
    spacious: density === 'spacious',
    showActive: showActive,
    visualState: visualState,
    systemLabelIds: conversation.systemLabelIds ?? [],
    rowBadges: userBadgesByName(conversation.labels ?? [], allLabels),
    source: source,
    showSource: Boolean(source && source.id !== props.currentFolderId),
    flashClass: flash
      ? 'motion-safe:animate-row-flash dark:motion-safe:animate-row-flash-dark'
      : '',
  };
}

export function resolveRowContextProps(props: ConversationRowProps, selected: boolean) {
  const { conversation } = props;
  const multiSelectActive = props.multiSelectActive ?? false;
  const selectionCount = props.selectionCount ?? 1;
  const onTriage = props.onTriage ?? noop;
  const systemLabelIds = conversation.systemLabelIds ?? [];
  const effectiveSelectionCount = selected && multiSelectActive ? selectionCount : 1;
  const contextMenuSystemLabelIds =
    effectiveSelectionCount > 1
      ? (props.selectionSystemLabelIds ?? systemLabelIds)
      : systemLabelIds;
  const isSpam = contextMenuSystemLabelIds.includes('SPAM');
  const rowLabels: LabelMenuEntry[] = (props.allLabels ?? []).map((label) => ({
    ...label,
    membership: (conversation.labels ?? []).includes(label.name) ? 'checked' : 'unchecked',
  }));
  return {
    systemLabelIds: contextMenuSystemLabelIds,
    unread: conversation.unread,
    starred: conversation.starred,
    labels: rowLabels,
    selectionCount: effectiveSelectionCount,
    onOpen: () =>
      props.onOpen({ shiftKey: false, metaKey: false, ctrlKey: false } as ReactMouseEvent),
    onToggleRead: () => onTriage(readToggleIntent(conversation.unread)),
    onToggleStar: props.onStar,
    onMoveTo: (destination: MoveDestinationId) =>
      onTriage({ kind: 'move', destination: destination }),
    onToggleLabel: (labelId: string, checked: boolean) =>
      onTriage({ kind: 'label', add: checked ? [labelId] : [], remove: checked ? [] : [labelId] }),
    onToggleSpam: () => onTriage(spamToggleIntent(isSpam)),
    onDelete: () => onTriage({ kind: 'delete' }),
    ...composeMenuCallbacks(conversation.draft, props.onCompose),
  };
}
