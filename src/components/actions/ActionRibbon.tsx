import { useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import {
  FolderInput,
  Forward,
  MailOpen,
  MoreHorizontal,
  PenSquare,
  Reply,
  ReplyAll,
  ShieldAlert,
  Star,
  Tag,
  Trash2,
} from 'lucide-react';
import type { LabelMenuEntry } from './LabelsMenu';
import type { MoveDestinationId } from './MoveToMenu';
import {
  computeRibbonVisibility,
  POPOVER_SURFACE_CLASS,
  RIBBON_THEMES,
  RibbonComposeGroup,
  RibbonDeleteButton,
  RibbonLabelsPopover,
  RibbonMoveToPopover,
  RibbonReadButton,
  RibbonSeparator,
  RibbonSpamButton,
  RibbonStarButton,
} from './RibbonControls';
import { ICON_SIZE } from '@/components/shared/icon-size';

export { computeRibbonVisibility };

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

const THEME = RIBBON_THEMES.lg;

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
  return { containerRef: containerRef, probeRef: probeRef, narrow: requiredWidth > availableWidth };
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
  const [overflowOpen, setOverflowOpen] = useState(false);
  const visibility = computeRibbonVisibility(systemLabelIds);

  const composeGroup = onReply && onReplyAll && onForward && (
    <RibbonComposeGroup
      theme={THEME}
      onReply={onReply}
      onReplyAll={onReplyAll}
      onForward={onForward}
      onEditDraft={onEditDraft}
    />
  );

  const readUnreadButton = visibility.showReadToggle && (
    <RibbonReadButton key="read-unread" theme={THEME} unread={unread} onToggleRead={onToggleRead} />
  );

  const starButton = visibility.showStar && (
    <RibbonStarButton key="star" theme={THEME} starred={starred} onToggleStar={onToggleStar} />
  );

  const labelsButton = visibility.showLabels && (
    <RibbonLabelsPopover
      key="labels"
      theme={THEME}
      labels={labels}
      onCreateLabel={onCreateLabel}
      onApplyLabels={onApplyLabels}
    />
  );

  const moveToButton = visibility.showMoveTo && (
    <RibbonMoveToPopover
      key="move-to"
      theme={THEME}
      currentSystemLabelIds={moveToCurrentLabelIds ?? systemLabelIds}
      onMoveTo={onMoveTo}
    />
  );

  const spamButton = visibility.showSpamToggle && (
    <RibbonSpamButton
      key="spam"
      theme={THEME}
      spamMode={visibility.spamMode}
      onToggleSpam={onToggleSpam}
    />
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
                  className={THEME.iconButtonClass}
                >
                  <MoreHorizontal aria-hidden="true" size={ICON_SIZE.lg} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  className={`flex min-w-40 flex-col gap-1 ${POPOVER_SURFACE_CLASS}`}
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
                  <RibbonSeparator theme={THEME} />
                  {spamButton}
                </>
              )}
            </>
          ))}
        {visibility.showDelete && (
          <>
            <RibbonSeparator theme={THEME} />
            <RibbonDeleteButton theme={THEME} onDelete={onDelete} />
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
    <span key={index} className={THEME.iconButtonClass}>
      <Icon aria-hidden="true" size={ICON_SIZE.lg} />
    </span>
  ));
}
