import { useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import {
  FolderInput,
  Forward,
  Mail,
  MailOpen,
  MoreHorizontal,
  PenSquare,
  Reply,
  ReplyAll,
  ShieldAlert,
  ShieldOff,
  Star,
  Tag,
  Trash2,
} from 'lucide-react';
import { LabelsMenu, type LabelMenuEntry } from './LabelsMenu';
import { MoveToMenu, type MoveDestinationId } from './MoveToMenu';

export function computeRibbonVisibility(systemLabelIds: string[]) {
  const isDrafts = systemLabelIds.includes('DRAFT');
  const isTrash = systemLabelIds.includes('TRASH');
  const isSpam = systemLabelIds.includes('SPAM');
  return {
    showReadToggle: !isDrafts,
    showStar: !isDrafts && !isTrash,
    showLabels: !isDrafts,
    showMoveTo: !isDrafts,
    showSpamToggle: !isDrafts,
    showDelete: !isTrash,
    spamMode: (isSpam ? 'notSpam' : 'markSpam') as 'notSpam' | 'markSpam',
  };
}

export type ActionRibbonProps = {
  systemLabelIds: string[];
  moveToCurrentLabelIds?: string[];
  unread: boolean;
  starred: boolean;
  labels: LabelMenuEntry[];
  onToggleRead: () => void;
  onToggleStar: () => void;
  onApplyLabels: (changes: { add: string[]; remove: string[] }) => void;
  onMoveTo: (destination: MoveDestinationId) => void;
  onToggleSpam: () => void;
  onDelete: () => void;
  onCreateLabel?: () => void;
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  onEditDraft?: () => void;
};

const iconButtonClass =
  'inline-flex items-center justify-center gap-1 rounded p-2 text-secondary hover:bg-surface-container-low hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container dark:hover:text-dark-on-surface cursor-pointer';

function useMeasuredOverflow() {
  const containerRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [requiredWidth, setRequiredWidth] = useState(0);
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      setAvailableWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = probeRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      setRequiredWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { containerRef, probeRef, narrow: requiredWidth > availableWidth };
}

export function ActionRibbon({
  systemLabelIds,
  moveToCurrentLabelIds,
  unread,
  starred,
  labels,
  onToggleRead,
  onToggleStar,
  onApplyLabels,
  onMoveTo,
  onToggleSpam,
  onDelete,
  onCreateLabel,
  onReply,
  onReplyAll,
  onForward,
  onEditDraft,
}: ActionRibbonProps) {
  const { containerRef, probeRef, narrow } = useMeasuredOverflow();
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const visibility = computeRibbonVisibility(systemLabelIds);

  const composeGroup = onReply && onReplyAll && onForward && (
    <ComposeGroup
      onReply={onReply}
      onReplyAll={onReplyAll}
      onForward={onForward}
      onEditDraft={onEditDraft}
    />
  );

  const readUnreadButton = visibility.showReadToggle && (
    <button
      key="read-unread"
      type="button"
      aria-label={unread ? 'Mark read' : 'Mark unread'}
      title={unread ? 'Mark read' : 'Mark unread'}
      onClick={onToggleRead}
      className={iconButtonClass}
    >
      {unread ? <Mail aria-hidden="true" size={18} /> : <MailOpen aria-hidden="true" size={18} />}
    </button>
  );

  const starButton = visibility.showStar && (
    <button
      key="star"
      type="button"
      aria-label={starred ? 'Unstar' : 'Star'}
      title={starred ? 'Unstar' : 'Star'}
      onClick={onToggleStar}
      className={`${iconButtonClass} ${starred ? 'text-star dark:text-dark-star' : ''}`}
    >
      <Star aria-hidden="true" size={18} fill={starred ? 'currentColor' : 'none'} />
    </button>
  );

  const labelsButton = visibility.showLabels && (
    <DropdownMenu.Root key="labels" open={labelsOpen} onOpenChange={setLabelsOpen}>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label="Labels" title="Labels" className={iconButtonClass}>
          <Tag aria-hidden="true" size={18} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          className="z-50 min-w-64 rounded-md border border-outline-variant/40 bg-surface-container-lowest p-2 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
        >
          <LabelsMenu
            variant="staged"
            labels={labels}
            onCreateLabel={onCreateLabel}
            onApply={(changes) => {
              onApplyLabels(changes);
              setLabelsOpen(false);
            }}
            onCancel={() => setLabelsOpen(false)}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );

  const moveToButton = visibility.showMoveTo && (
    <DropdownMenu.Root key="move-to" open={moveOpen} onOpenChange={setMoveOpen}>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label="Move to" title="Move to" className={iconButtonClass}>
          <FolderInput aria-hidden="true" size={18} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          className="z-50 min-w-52 rounded-md border border-outline-variant/40 bg-surface-container-lowest p-2 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
        >
          <MoveToMenu
            currentSystemLabelIds={moveToCurrentLabelIds ?? systemLabelIds}
            onSelect={(destination) => {
              onMoveTo(destination);
              setMoveOpen(false);
            }}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );

  const spamButton = visibility.showSpamToggle && (
    <button
      key="spam"
      type="button"
      aria-label={visibility.spamMode === 'notSpam' ? 'Not spam' : 'Mark as spam'}
      title={visibility.spamMode === 'notSpam' ? 'Not spam' : 'Mark as spam'}
      onClick={onToggleSpam}
      className={iconButtonClass}
    >
      {visibility.spamMode === 'notSpam' ? (
        <ShieldOff aria-hidden="true" size={18} />
      ) : (
        <ShieldAlert aria-hidden="true" size={18} />
      )}
    </button>
  );

  const deleteButton = visibility.showDelete && (
    <button
      key="delete"
      type="button"
      aria-label="Delete"
      title="Delete"
      onClick={onDelete}
      className="inline-flex items-center justify-center rounded p-2 text-secondary hover:bg-error-container hover:text-error focus-visible:outline-2 focus-visible:outline-error dark:text-dark-secondary dark:hover:bg-dark-error-container dark:hover:text-dark-error cursor-pointer"
    >
      <Trash2 aria-hidden="true" size={18} />
    </button>
  );

  const contiguousSecondary = [starButton, labelsButton, moveToButton].filter(Boolean);
  const secondaryItems = [...contiguousSecondary, spamButton].filter(Boolean);

  return (
    <div ref={containerRef} className="relative w-full">
      <div
        ref={probeRef}
        aria-hidden="true"
        inert
        className="pointer-events-none invisible absolute left-0 top-0 -z-10 flex items-center gap-ribbon-gap"
      >
        <RibbonMeasure
          includeCompose={Boolean(composeGroup)}
          visibility={visibility}
          includeSecondary={secondaryItems.length > 0}
        />
      </div>
      <div
        data-testid="action-ribbon"
        role="toolbar"
        aria-label="Conversation actions"
        className="flex items-center gap-ribbon-gap"
      >
        {composeGroup}
        {readUnreadButton}
        {secondaryItems.length > 0 &&
          (narrow ? (
            <DropdownMenu.Root open={overflowOpen} onOpenChange={setOverflowOpen}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  aria-label="More actions"
                  title="More actions"
                  className={iconButtonClass}
                >
                  <MoreHorizontal aria-hidden="true" size={18} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  className="z-50 flex min-w-40 flex-col gap-1 rounded-md border border-outline-variant/40 bg-surface-container-lowest p-2 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
                >
                  {secondaryItems}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : (
            <>
              {contiguousSecondary}
              {spamButton && (
                <>
                  <span
                    aria-hidden="true"
                    className="mx-1 h-5 w-px bg-outline-variant/50 dark:bg-dark-outline-variant/50"
                  />
                  {spamButton}
                </>
              )}
            </>
          ))}
        {visibility.showDelete && (
          <>
            <span
              aria-hidden="true"
              className="mx-1 h-5 w-px bg-outline-variant/50 dark:bg-dark-outline-variant/50"
            />
            {deleteButton}
          </>
        )}
      </div>
    </div>
  );
}

function RibbonMeasure({
  includeCompose,
  visibility,
  includeSecondary,
}: {
  includeCompose: boolean;
  visibility: ReturnType<typeof computeRibbonVisibility>;
  includeSecondary: boolean;
}) {
  const icons = [
    ...(includeCompose ? [Reply, ReplyAll, Forward, PenSquare] : []),
    ...(visibility.showReadToggle ? [MailOpen] : []),
    ...(visibility.showStar ? [Star] : []),
    ...(visibility.showLabels ? [Tag] : []),
    ...(visibility.showMoveTo ? [FolderInput] : []),
    ...(visibility.showSpamToggle ? [ShieldAlert] : []),
    ...(visibility.showDelete ? [Trash2] : []),
    ...(includeSecondary ? [MoreHorizontal] : []),
  ];
  return icons.map((Icon, index) => (
    <span key={index} className={iconButtonClass}>
      <Icon aria-hidden="true" size={18} />
    </span>
  ));
}

function ComposeGroup({
  onReply,
  onReplyAll,
  onForward,
  onEditDraft,
}: {
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onEditDraft?: () => void;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Reply"
        title="Reply"
        onClick={onReply}
        className={iconButtonClass}
      >
        <Reply aria-hidden="true" size={18} />
      </button>
      <button
        type="button"
        aria-label="Reply all"
        title="Reply all"
        onClick={onReplyAll}
        className={iconButtonClass}
      >
        <ReplyAll aria-hidden="true" size={18} />
      </button>
      <button
        type="button"
        aria-label="Forward"
        title="Forward"
        onClick={onForward}
        className={iconButtonClass}
      >
        <Forward aria-hidden="true" size={18} />
      </button>
      {onEditDraft && (
        <button
          type="button"
          aria-label="Edit draft"
          title="Edit draft"
          onClick={onEditDraft}
          className={iconButtonClass}
        >
          <PenSquare aria-hidden="true" size={18} />
        </button>
      )}
      <span
        aria-hidden="true"
        className="mx-1 h-5 w-px bg-outline-variant/50 dark:bg-dark-outline-variant/50"
      />
    </>
  );
}
