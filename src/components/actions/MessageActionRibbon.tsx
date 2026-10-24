import { useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import {
  Download,
  EllipsisVertical,
  FileCode,
  FolderInput,
  Forward,
  Globe,
  Mail,
  MailOpen,
  PenSquare,
  Reply,
  ReplyAll,
  ShieldAlert,
  ShieldOff,
  Star,
  Tag,
  Trash2,
} from 'lucide-react';
import { formatBindingParts, isMacPlatform, primaryBinding } from '@/lib/keyboard/format';
import { useCommandBindings } from '@/providers/CommandProvider';
import { computeRibbonVisibility } from './ActionRibbon';
import { LabelsMenu, type LabelMenuEntry } from './LabelsMenu';
import { MoveToMenu, type MoveDestinationId } from './MoveToMenu';
import { itemClass, menuContentClass } from './RowContextMenu';

export type MessageExportActions = {
  onShowOriginal: () => void;
  onDownloadEml: () => void;
  onDownloadHtml: () => void;
};

export type MessageActionRibbonProps = {
  systemLabelIds: string[];
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
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onEditDraft?: () => void;
  exportActions?: MessageExportActions;
};

const iconButtonClass =
  'inline-flex items-center justify-center rounded p-1.5 text-secondary hover:bg-surface-container-low hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container dark:hover:text-dark-on-surface cursor-pointer';

export function MessageActionRibbon({
  systemLabelIds,
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
  exportActions,
}: MessageActionRibbonProps) {
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const visibility = computeRibbonVisibility(systemLabelIds);

  return (
    <div
      data-testid="message-action-ribbon"
      role="toolbar"
      aria-label="Message actions"
      className="flex items-center gap-1"
    >
      <button
        type="button"
        aria-label="Reply"
        title="Reply"
        onClick={onReply}
        className={iconButtonClass}
      >
        <Reply aria-hidden="true" size={14} />
      </button>
      <button
        type="button"
        aria-label="Reply all"
        title="Reply all"
        onClick={onReplyAll}
        className={iconButtonClass}
      >
        <ReplyAll aria-hidden="true" size={14} />
      </button>
      <button
        type="button"
        aria-label="Forward"
        title="Forward"
        onClick={onForward}
        className={iconButtonClass}
      >
        <Forward aria-hidden="true" size={14} />
      </button>
      {onEditDraft && (
        <button
          type="button"
          aria-label="Edit draft"
          title="Edit draft"
          onClick={onEditDraft}
          className={iconButtonClass}
        >
          <PenSquare aria-hidden="true" size={14} />
        </button>
      )}
      <span
        aria-hidden="true"
        className="mx-0.5 h-4 w-px bg-outline-variant/50 dark:bg-dark-outline-variant/50"
      />
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
            <button type="button" aria-label="Move to" title="Move to" className={iconButtonClass}>
              <FolderInput aria-hidden="true" size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              className="z-50 min-w-52 rounded-md border border-outline-variant/40 bg-surface-container-lowest p-2 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
            >
              <MoveToMenu
                currentSystemLabelIds={systemLabelIds}
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
            className="inline-flex items-center justify-center rounded p-1.5 text-secondary hover:bg-error-container hover:text-error focus-visible:outline-2 focus-visible:outline-error dark:text-dark-secondary dark:hover:bg-dark-error-container dark:hover:text-dark-error cursor-pointer"
          >
            <Trash2 aria-hidden="true" size={14} />
          </button>
        </>
      )}
      {exportActions && <MoreMessageActions actions={exportActions} />}
    </div>
  );
}

function MoreMessageActions({ actions }: { actions: MessageExportActions }) {
  const bindings = useCommandBindings();
  const isMac = isMacPlatform();
  const binding = primaryBinding(bindings.showOriginal, isMac);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="More message actions"
          title="More message actions"
          className={iconButtonClass}
        >
          <EllipsisVertical aria-hidden="true" size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className={menuContentClass} collisionPadding={8}>
          <DropdownMenu.Item className={itemClass} onSelect={actions.onShowOriginal}>
            <FileCode aria-hidden="true" size={16} />
            Show original
            {binding && (
              <span className="ml-auto pl-4 text-label-sm text-secondary dark:text-dark-secondary">
                {formatBindingParts(binding, isMac).join(isMac ? '' : '+')}
              </span>
            )}
          </DropdownMenu.Item>
          <DropdownMenu.Item className={itemClass} onSelect={actions.onDownloadEml}>
            <Download aria-hidden="true" size={16} />
            Download message (.eml)
          </DropdownMenu.Item>
          <DropdownMenu.Item className={itemClass} onSelect={actions.onDownloadHtml}>
            <Globe aria-hidden="true" size={16} />
            Download as web page (.html)
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
