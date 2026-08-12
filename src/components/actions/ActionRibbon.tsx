import { useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import {
  FolderInput,
  Mail,
  MailOpen,
  MoreHorizontal,
  ShieldAlert,
  ShieldOff,
  Star,
  Tag,
  Trash2,
} from 'lucide-react';
import { LabelsMenu, type LabelMenuEntry } from './LabelsMenu';
import { MoveToMenu, type MoveDestinationId } from './MoveToMenu';

/** Below this reader width, the secondary action group (star, labels, move
 * to, spam) collapses into a single overflow menu — Read/Unread and Delete
 * stay outside it while width allows (AC2). */
const OVERFLOW_WIDTH_THRESHOLD = 500;

/** Per-mailbox hide-vs-disable rules (D-series wireframe): every
 * label-mutating action — star, labels, move, spam, and read/unread itself
 * (Gmail's read state is a label) — is hidden in Drafts; Trash hides star
 * and delete; Spam swaps "Mark as spam" for "Not spam". Shared with
 * `RowContextMenu`, whose entry set follows the identical rule so the two
 * surfaces can never drift apart. */
export function computeRibbonVisibility(mailboxId: string) {
  const isDrafts = mailboxId === 'DRAFT';
  const isTrash = mailboxId === 'TRASH';
  const isSpam = mailboxId === 'SPAM';
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
  /** The mailbox currently browsed — governs which actions render at all
   * (hidden, never merely disabled, per the wireframe). */
  mailboxId: string;
  /** Aggregate read state across the thread(s) this ribbon acts on. */
  unread: boolean;
  /** Aggregate star state across the thread(s) this ribbon acts on. */
  starred: boolean;
  /** Every user label in the account, for the Labels menu. */
  labels: LabelMenuEntry[];
  /** Display name of the current mailbox when it is itself a user label —
   * threaded into `MoveToMenu` so it can render "the removed source". */
  currentLabelName?: string;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onApplyLabels: (changes: { add: string[]; remove: string[] }) => void;
  onMoveTo: (destination: MoveDestinationId) => void;
  onToggleSpam: () => void;
  onDelete: () => void;
  onCreateLabel?: () => void;
};

const iconButtonClass =
  'inline-flex items-center justify-center gap-1 rounded p-2 text-secondary hover:bg-surface-container-low hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container dark:hover:text-dark-on-surface';

function useNarrowRibbon(threshold: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setNarrow(width > 0 && width < threshold);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold]);
  return { ref, narrow };
}

export function ActionRibbon({
  mailboxId,
  unread,
  starred,
  labels,
  currentLabelName,
  onToggleRead,
  onToggleStar,
  onApplyLabels,
  onMoveTo,
  onToggleSpam,
  onDelete,
  onCreateLabel,
}: ActionRibbonProps) {
  const { ref, narrow } = useNarrowRibbon(OVERFLOW_WIDTH_THRESHOLD);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const visibility = computeRibbonVisibility(mailboxId);

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
            currentMailboxId={mailboxId}
            currentLabelName={currentLabelName}
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
      className="inline-flex items-center justify-center rounded p-2 text-secondary hover:bg-error-container hover:text-error focus-visible:outline-2 focus-visible:outline-error dark:text-dark-secondary dark:hover:bg-dark-error-container dark:hover:text-dark-error"
    >
      <Trash2 aria-hidden="true" size={18} />
    </button>
  );

  // Star/Labels/Move-to sit contiguous; Spam gets its own separator before
  // it per the wireframe (`... Move to | Spam | Delete`) even though all
  // four collapse into the same overflow menu below the width threshold.
  const contiguousSecondary = [starButton, labelsButton, moveToButton].filter(Boolean);
  const secondaryItems = [...contiguousSecondary, spamButton].filter(Boolean);

  return (
    <div
      ref={ref}
      data-testid="action-ribbon"
      role="toolbar"
      aria-label="Conversation actions"
      className="flex items-center gap-ribbon-gap"
    >
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
  );
}
