import { useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import {
  FolderInput,
  Mail,
  MailOpen,
  ShieldAlert,
  ShieldOff,
  Star,
  Tag,
  Trash2,
} from 'lucide-react';
import { computeRibbonVisibility } from './ActionRibbon';
import { LabelsMenu, type LabelMenuEntry } from './LabelsMenu';
import { MoveToMenu, type MoveDestinationId } from './MoveToMenu';

export type MessageActionRibbonProps = {
  mailboxId: string;
  unread: boolean;
  starred: boolean;
  labels: LabelMenuEntry[];
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
  'inline-flex items-center justify-center rounded p-1.5 text-secondary hover:bg-surface-container-low hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container dark:hover:text-dark-on-surface';

/** Per-message triage actions, applying to the whole conversation (star and
 * read/unread are conversation-wide even here — FR "Triage actions"). Always
 * rendered — never hover-revealed, which the plan explicitly rejects for
 * failing keyboard and touch discoverability — and drawn smaller (14px) than
 * the thread-level `ActionRibbon` (18px) to read as subordinate. */
export function MessageActionRibbon({
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
}: MessageActionRibbonProps) {
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const visibility = computeRibbonVisibility(mailboxId);

  return (
    <div
      data-testid="message-action-ribbon"
      role="toolbar"
      aria-label="Message actions"
      className="flex items-center gap-1"
    >
      {visibility.showReadToggle && (
        <button
          type="button"
          aria-label={unread ? 'Mark read' : 'Mark unread'}
          title={unread ? 'Mark read' : 'Mark unread'}
          onClick={onToggleRead}
          className={iconButtonClass}
        >
          {unread ? (
            <Mail aria-hidden="true" size={14} />
          ) : (
            <MailOpen aria-hidden="true" size={14} />
          )}
        </button>
      )}
      {visibility.showStar && (
        <button
          type="button"
          aria-label={starred ? 'Unstar' : 'Star'}
          title={starred ? 'Unstar' : 'Star'}
          onClick={onToggleStar}
          className={`${iconButtonClass} ${starred ? 'text-star dark:text-dark-star' : ''}`}
        >
          <Star aria-hidden="true" size={14} fill={starred ? 'currentColor' : 'none'} />
        </button>
      )}
      {visibility.showLabels && (
        <DropdownMenu.Root open={labelsOpen} onOpenChange={setLabelsOpen}>
          <DropdownMenu.Trigger asChild>
            <button type="button" aria-label="Labels" title="Labels" className={iconButtonClass}>
              <Tag aria-hidden="true" size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
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
      )}
      {visibility.showMoveTo && (
        <DropdownMenu.Root open={moveOpen} onOpenChange={setMoveOpen}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Move to"
              title="Move to"
              className={iconButtonClass}
            >
              <FolderInput aria-hidden="true" size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
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
      )}
      {visibility.showSpamToggle && (
        <>
          <span
            aria-hidden="true"
            className="mx-0.5 h-4 w-px bg-outline-variant/50 dark:bg-dark-outline-variant/50"
          />
          <button
            type="button"
            aria-label={visibility.spamMode === 'notSpam' ? 'Not spam' : 'Mark as spam'}
            title={visibility.spamMode === 'notSpam' ? 'Not spam' : 'Mark as spam'}
            onClick={onToggleSpam}
            className={iconButtonClass}
          >
            {visibility.spamMode === 'notSpam' ? (
              <ShieldOff aria-hidden="true" size={14} />
            ) : (
              <ShieldAlert aria-hidden="true" size={14} />
            )}
          </button>
        </>
      )}
      {visibility.showDelete && (
        <>
          <span
            aria-hidden="true"
            className="mx-0.5 h-4 w-px bg-outline-variant/50 dark:bg-dark-outline-variant/50"
          />
          <button
            type="button"
            aria-label="Delete"
            title="Delete"
            onClick={onDelete}
            className="inline-flex items-center justify-center rounded p-1.5 text-secondary hover:bg-error-container hover:text-error focus-visible:outline-2 focus-visible:outline-error dark:text-dark-secondary dark:hover:bg-dark-error-container dark:hover:text-dark-error"
          >
            <Trash2 aria-hidden="true" size={14} />
          </button>
        </>
      )}
    </div>
  );
}
