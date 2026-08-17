import { useState, type ReactNode } from 'react';
import { ContextMenu } from 'radix-ui';
import {
  FolderInput,
  Forward,
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
import { computeRibbonVisibility } from './ActionRibbon';
import { LabelsMenu, type LabelMenuEntry } from './LabelsMenu';
import { MoveToMenu, type MoveDestinationId } from './MoveToMenu';

const menuContentClass =
  'z-50 min-w-56 rounded-md border border-outline-variant/40 bg-surface-container-lowest p-1 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest';
const itemClass =
  'flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-body-sm text-on-surface outline-none data-[highlighted]:bg-surface-container-low dark:text-dark-on-surface dark:data-[highlighted]:bg-dark-surface-container';
const subTriggerClass = `${itemClass} justify-between`;

export type RowContextMenuProps = {
  children: ReactNode;
  systemLabelIds: string[];
  unread: boolean;
  starred: boolean;
  labels: LabelMenuEntry[];
  selectionCount?: number;
  onOpen: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onMoveTo: (destination: MoveDestinationId) => void;
  onToggleLabel: (labelId: string, checked: boolean) => void;
  onToggleSpam: () => void;
  onDelete: () => void;
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  onEditDraft?: () => void;
};

export function RowContextMenu({
  children,
  systemLabelIds,
  unread,
  starred,
  labels,
  selectionCount = 1,
  onOpen,
  onToggleRead,
  onToggleStar,
  onMoveTo,
  onToggleLabel,
  onToggleSpam,
  onDelete,
  onReply,
  onReplyAll,
  onForward,
  onEditDraft,
}: RowContextMenuProps) {
  const [open, setOpen] = useState(false);
  const visibility = computeRibbonVisibility(systemLabelIds);
  const multi = selectionCount > 1;
  const countSuffix = multi ? ` ${selectionCount}` : '';

  return (
    <ContextMenu.Root open={open} onOpenChange={setOpen}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContentClass} collisionPadding={8}>
          {!multi && (
            <ContextMenu.Item className={itemClass} onSelect={onOpen}>
              Open
            </ContextMenu.Item>
          )}
          {!multi && onReply && (
            <ContextMenu.Item className={itemClass} onSelect={onReply}>
              <Reply aria-hidden="true" size={16} />
              Reply
            </ContextMenu.Item>
          )}
          {!multi && onReplyAll && (
            <ContextMenu.Item className={itemClass} onSelect={onReplyAll}>
              <ReplyAll aria-hidden="true" size={16} />
              Reply all
            </ContextMenu.Item>
          )}
          {!multi && onForward && (
            <ContextMenu.Item className={itemClass} onSelect={onForward}>
              <Forward aria-hidden="true" size={16} />
              Forward
            </ContextMenu.Item>
          )}
          {!multi && onEditDraft && (
            <ContextMenu.Item className={itemClass} onSelect={onEditDraft}>
              <PenSquare aria-hidden="true" size={16} />
              Edit draft
            </ContextMenu.Item>
          )}
          {!multi && (onReply || onReplyAll || onForward || onEditDraft) && (
            <ContextMenu.Separator className="my-1 h-px bg-outline-variant/40 dark:bg-dark-outline-variant/40" />
          )}
          {visibility.showReadToggle && (
            <ContextMenu.Item className={itemClass} onSelect={onToggleRead}>
              {unread ? (
                <MailOpen aria-hidden="true" size={16} />
              ) : (
                <Mail aria-hidden="true" size={16} />
              )}
              {unread ? `Mark${countSuffix} read` : `Mark${countSuffix} unread`}
            </ContextMenu.Item>
          )}
          {visibility.showStar && (
            <ContextMenu.Item className={itemClass} onSelect={onToggleStar}>
              <Star aria-hidden="true" size={16} fill={starred ? 'currentColor' : 'none'} />
              {starred ? `Unstar${countSuffix}` : `Star${countSuffix}`}
            </ContextMenu.Item>
          )}
          {visibility.showMoveTo && (
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className={subTriggerClass}>
                <span className="flex items-center gap-2">
                  <FolderInput aria-hidden="true" size={16} />
                  {multi ? `Move${countSuffix} to` : 'Move to'}
                </span>
                <span aria-hidden="true">▸</span>
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className={menuContentClass} collisionPadding={8}>
                  <MoveToMenu
                    currentSystemLabelIds={systemLabelIds}
                    onSelect={(destination) => {
                      setOpen(false);
                      onMoveTo(destination);
                    }}
                  />
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          )}
          {visibility.showLabels && (
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className={subTriggerClass}>
                <span className="flex items-center gap-2">
                  <Tag aria-hidden="true" size={16} />
                  {multi ? `Labels (${selectionCount})` : 'Labels'}
                </span>
                <span aria-hidden="true">▸</span>
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className={`${menuContentClass} w-64`} collisionPadding={8}>
                  <LabelsMenu variant="immediate" labels={labels} onToggle={onToggleLabel} />
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          )}
          {visibility.showSpamToggle && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-outline-variant/40 dark:bg-dark-outline-variant/40" />
              <ContextMenu.Item className={itemClass} onSelect={onToggleSpam}>
                {visibility.spamMode === 'notSpam' ? (
                  <ShieldOff aria-hidden="true" size={16} />
                ) : (
                  <ShieldAlert aria-hidden="true" size={16} />
                )}
                {visibility.spamMode === 'notSpam'
                  ? `Mark${countSuffix} as not spam`
                  : `Mark${countSuffix} as spam`}
              </ContextMenu.Item>
            </>
          )}
          {visibility.showDelete && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-outline-variant/40 dark:bg-dark-outline-variant/40" />
              <ContextMenu.Item
                className={`${itemClass} text-error hover:bg-error-container dark:text-dark-error dark:hover:bg-dark-error-container`}
                onSelect={onDelete}
              >
                <Trash2 aria-hidden="true" size={16} />
                {`Delete${countSuffix}`}
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
