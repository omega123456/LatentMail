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

type RibbonVisibility = ReturnType<typeof computeRibbonVisibility>;

function buildSecondaryActions({
  visibility,
  props,
}: {
  visibility: RibbonVisibility;
  props: ActionRibbonProps;
}) {
  const starButton = visibility.showStar && (
    <RibbonStarButton
      key="star"
      theme={THEME}
      starred={props.starred}
      onToggleStar={props.onToggleStar}
    />
  );
  const labelsButton = visibility.showLabels && (
    <RibbonLabelsPopover
      key="labels"
      theme={THEME}
      labels={props.labels}
      onCreateLabel={props.onCreateLabel}
      onApplyLabels={props.onApplyLabels}
    />
  );
  const moveToButton = visibility.showMoveTo && (
    <RibbonMoveToPopover
      key="move-to"
      theme={THEME}
      currentSystemLabelIds={props.moveToCurrentLabelIds ?? props.systemLabelIds}
      onMoveTo={props.onMoveTo}
    />
  );
  const spamButton = visibility.showSpamToggle && (
    <RibbonSpamButton
      key="spam"
      theme={THEME}
      spamMode={visibility.spamMode}
      onToggleSpam={props.onToggleSpam}
    />
  );
  const contiguousSecondary = [starButton, labelsButton, moveToButton].filter(Boolean);
  const secondaryItems = [...contiguousSecondary, spamButton].filter(Boolean);
  return {
    contiguousSecondary: contiguousSecondary,
    spamButton: spamButton,
    secondaryItems: secondaryItems,
  };
}

function RibbonSecondaryActions({
  narrow,
  overflowOpen,
  onOverflowOpenChange,
  contiguousSecondary,
  spamButton,
  secondaryItems,
}: {
  narrow: boolean;
  overflowOpen: boolean;
  onOverflowOpenChange: (open: boolean) => void;
  contiguousSecondary: ReturnType<typeof buildSecondaryActions>['contiguousSecondary'];
  spamButton: ReturnType<typeof buildSecondaryActions>['spamButton'];
  secondaryItems: ReturnType<typeof buildSecondaryActions>['secondaryItems'];
}) {
  if (secondaryItems.length === 0) return null;
  if (narrow) {
    return (
      <DropdownMenu.Root open={overflowOpen} onOpenChange={onOverflowOpenChange}>
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
    );
  }
  return (
    <>
      {contiguousSecondary}
      {spamButton && (
        <>
          <RibbonSeparator theme={THEME} />
          {spamButton}
        </>
      )}
    </>
  );
}

function RibbonMeasureProbe({
  probeRef,
  includeCompose,
  visibility,
  includeSecondary,
}: {
  probeRef: React.RefObject<HTMLDivElement | null>;
  includeCompose: boolean;
  visibility: RibbonVisibility;
  includeSecondary: boolean;
}) {
  return (
    <div
      ref={probeRef}
      aria-hidden="true"
      inert
      className="pointer-events-none invisible absolute left-0 top-0 -z-10 flex items-center gap-ribbon-gap"
    >
      <RibbonMeasure
        includeCompose={includeCompose}
        visibility={visibility}
        includeSecondary={includeSecondary}
      />
    </div>
  );
}

export function ActionRibbon(props: ActionRibbonProps) {
  const { containerRef, probeRef, narrow } = useMeasuredOverflow();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const visibility = computeRibbonVisibility(props.systemLabelIds);
  const hasCompose = Boolean(props.onReply && props.onReplyAll && props.onForward);
  const secondary = buildSecondaryActions({ visibility: visibility, props: props });

  return (
    <div ref={containerRef} className="relative w-full">
      <RibbonMeasureProbe
        probeRef={probeRef}
        includeCompose={hasCompose}
        visibility={visibility}
        includeSecondary={secondary.secondaryItems.length > 0}
      />
      <div
        data-testid="action-ribbon"
        role="toolbar"
        aria-label="Conversation actions"
        className="flex items-center gap-ribbon-gap"
      >
        {props.onReply && props.onReplyAll && props.onForward && (
          <RibbonComposeGroup
            theme={THEME}
            onReply={props.onReply}
            onReplyAll={props.onReplyAll}
            onForward={props.onForward}
            onEditDraft={props.onEditDraft}
          />
        )}
        {visibility.showReadToggle && (
          <RibbonReadButton
            key="read-unread"
            theme={THEME}
            unread={props.unread}
            onToggleRead={props.onToggleRead}
          />
        )}
        <RibbonSecondaryActions
          narrow={narrow}
          overflowOpen={overflowOpen}
          onOverflowOpenChange={setOverflowOpen}
          contiguousSecondary={secondary.contiguousSecondary}
          spamButton={secondary.spamButton}
          secondaryItems={secondary.secondaryItems}
        />
        {visibility.showDelete && (
          <>
            <RibbonSeparator theme={THEME} />
            <RibbonDeleteButton theme={THEME} onDelete={props.onDelete} />
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
