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
import { ICON_SIZE } from '@/components/shared/icon-size';
import { MENU_COLLISION_PADDING_PX } from '@/components/shared/floating-offsets';

export const menuContentClass =
  'z-50 min-w-56 rounded-md border border-outline-variant/40 bg-surface-container-lowest p-1 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest';
export const itemClass =
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

const separatorClass = 'my-1 h-px bg-outline-variant/40 dark:bg-dark-outline-variant/40';

function SingleSelectionMenuItems({
  multi,
  onOpen,
  onReply,
  onReplyAll,
  onForward,
  onEditDraft,
}: {
  multi: boolean;
  onOpen: () => void;
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  onEditDraft?: () => void;
}) {
  if (multi) return null;
  const hasComposeActions = [onReply, onReplyAll, onForward, onEditDraft].some(Boolean);
  return (
    <>
      <ContextMenu.Item className={itemClass} onSelect={onOpen}>
        Open
      </ContextMenu.Item>
      {onReply && (
        <ContextMenu.Item className={itemClass} onSelect={onReply}>
          <Reply aria-hidden="true" size={ICON_SIZE.base} />
          Reply
        </ContextMenu.Item>
      )}
      {onReplyAll && (
        <ContextMenu.Item className={itemClass} onSelect={onReplyAll}>
          <ReplyAll aria-hidden="true" size={ICON_SIZE.base} />
          Reply all
        </ContextMenu.Item>
      )}
      {onForward && (
        <ContextMenu.Item className={itemClass} onSelect={onForward}>
          <Forward aria-hidden="true" size={ICON_SIZE.base} />
          Forward
        </ContextMenu.Item>
      )}
      {onEditDraft && (
        <ContextMenu.Item className={itemClass} onSelect={onEditDraft}>
          <PenSquare aria-hidden="true" size={ICON_SIZE.base} />
          Edit draft
        </ContextMenu.Item>
      )}
      {hasComposeActions && <ContextMenu.Separator className={separatorClass} />}
    </>
  );
}

function ReadToggleMenuItem({
  visible,
  unread,
  countSuffix,
  onToggleRead,
}: {
  visible: boolean;
  unread: boolean;
  countSuffix: string;
  onToggleRead: () => void;
}) {
  if (!visible) return null;
  return (
    <ContextMenu.Item className={itemClass} onSelect={onToggleRead}>
      {unread ? (
        <MailOpen aria-hidden="true" size={ICON_SIZE.base} />
      ) : (
        <Mail aria-hidden="true" size={ICON_SIZE.base} />
      )}
      {unread ? `Mark${countSuffix} read` : `Mark${countSuffix} unread`}
    </ContextMenu.Item>
  );
}

function StarMenuItem({
  visible,
  starred,
  countSuffix,
  onToggleStar,
}: {
  visible: boolean;
  starred: boolean;
  countSuffix: string;
  onToggleStar: () => void;
}) {
  if (!visible) return null;
  return (
    <ContextMenu.Item className={itemClass} onSelect={onToggleStar}>
      <Star aria-hidden="true" size={ICON_SIZE.base} fill={starred ? 'currentColor' : 'none'} />
      {starred ? `Unstar${countSuffix}` : `Star${countSuffix}`}
    </ContextMenu.Item>
  );
}

function MoveToSubMenu({
  visible,
  multi,
  countSuffix,
  systemLabelIds,
  onSelect,
}: {
  visible: boolean;
  multi: boolean;
  countSuffix: string;
  systemLabelIds: string[];
  onSelect: (destination: MoveDestinationId) => void;
}) {
  if (!visible) return null;
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={subTriggerClass}>
        <span className="flex items-center gap-2">
          <FolderInput aria-hidden="true" size={ICON_SIZE.base} />
          {multi ? `Move${countSuffix} to` : 'Move to'}
        </span>
        <span aria-hidden="true">▸</span>
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          className={menuContentClass}
          collisionPadding={MENU_COLLISION_PADDING_PX}
        >
          <MoveToMenu currentSystemLabelIds={systemLabelIds} onSelect={onSelect} />
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

function LabelsSubMenu({
  visible,
  multi,
  selectionCount,
  labels,
  onToggleLabel,
}: {
  visible: boolean;
  multi: boolean;
  selectionCount: number;
  labels: LabelMenuEntry[];
  onToggleLabel: (labelId: string, checked: boolean) => void;
}) {
  if (!visible) return null;
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={subTriggerClass}>
        <span className="flex items-center gap-2">
          <Tag aria-hidden="true" size={ICON_SIZE.base} />
          {multi ? `Labels (${selectionCount})` : 'Labels'}
        </span>
        <span aria-hidden="true">▸</span>
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          className={`${menuContentClass} w-64`}
          collisionPadding={MENU_COLLISION_PADDING_PX}
        >
          <LabelsMenu variant="immediate" labels={labels} onToggle={onToggleLabel} />
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

function SpamMenuItem({
  visible,
  spamMode,
  countSuffix,
  onToggleSpam,
}: {
  visible: boolean;
  spamMode: ReturnType<typeof computeRibbonVisibility>['spamMode'];
  countSuffix: string;
  onToggleSpam: () => void;
}) {
  if (!visible) return null;
  const isNotSpam = spamMode === 'notSpam';
  return (
    <>
      <ContextMenu.Separator className={separatorClass} />
      <ContextMenu.Item className={itemClass} onSelect={onToggleSpam}>
        {isNotSpam ? (
          <ShieldOff aria-hidden="true" size={ICON_SIZE.base} />
        ) : (
          <ShieldAlert aria-hidden="true" size={ICON_SIZE.base} />
        )}
        {isNotSpam ? `Mark${countSuffix} as not spam` : `Mark${countSuffix} as spam`}
      </ContextMenu.Item>
    </>
  );
}

function DeleteMenuItem({
  visible,
  countSuffix,
  onDelete,
}: {
  visible: boolean;
  countSuffix: string;
  onDelete: () => void;
}) {
  if (!visible) return null;
  return (
    <>
      <ContextMenu.Separator className={separatorClass} />
      <ContextMenu.Item
        className={`${itemClass} text-error hover:bg-error-container dark:text-dark-error dark:hover:bg-dark-error-container`}
        onSelect={onDelete}
      >
        <Trash2 aria-hidden="true" size={ICON_SIZE.base} />
        {`Delete${countSuffix}`}
      </ContextMenu.Item>
    </>
  );
}

function RowContextDestructiveItems({
  visibility,
  countSuffix,
  onToggleSpam,
  onDelete,
}: {
  visibility: ReturnType<typeof computeRibbonVisibility>;
  countSuffix: string;
  onToggleSpam: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <SpamMenuItem
        visible={visibility.showSpamToggle}
        spamMode={visibility.spamMode}
        countSuffix={countSuffix}
        onToggleSpam={onToggleSpam}
      />
      <DeleteMenuItem
        visible={visibility.showDelete}
        countSuffix={countSuffix}
        onDelete={onDelete}
      />
    </>
  );
}

function RowContextMenuItems({
  props,
  onSelectMoveTo,
}: {
  props: RowContextMenuProps;
  onSelectMoveTo: (destination: MoveDestinationId) => void;
}) {
  const selectionCount = props.selectionCount ?? 1;
  const visibility = computeRibbonVisibility(props.systemLabelIds);
  const multi = selectionCount > 1;
  const countSuffix = multi ? ` ${selectionCount}` : '';

  return (
    <>
      <SingleSelectionMenuItems
        multi={multi}
        onOpen={props.onOpen}
        onReply={props.onReply}
        onReplyAll={props.onReplyAll}
        onForward={props.onForward}
        onEditDraft={props.onEditDraft}
      />
      <ReadToggleMenuItem
        visible={visibility.showReadToggle}
        unread={props.unread}
        countSuffix={countSuffix}
        onToggleRead={props.onToggleRead}
      />
      <StarMenuItem
        visible={visibility.showStar}
        starred={props.starred}
        countSuffix={countSuffix}
        onToggleStar={props.onToggleStar}
      />
      <MoveToSubMenu
        visible={visibility.showMoveTo}
        multi={multi}
        countSuffix={countSuffix}
        systemLabelIds={props.systemLabelIds}
        onSelect={onSelectMoveTo}
      />
      <LabelsSubMenu
        visible={visibility.showLabels}
        multi={multi}
        selectionCount={selectionCount}
        labels={props.labels}
        onToggleLabel={props.onToggleLabel}
      />
      <RowContextDestructiveItems
        visibility={visibility}
        countSuffix={countSuffix}
        onToggleSpam={props.onToggleSpam}
        onDelete={props.onDelete}
      />
    </>
  );
}

export function RowContextMenu(props: RowContextMenuProps) {
  const [open, setOpen] = useState(false);

  const handleMoveTo = (destination: MoveDestinationId) => {
    setOpen(false);
    props.onMoveTo(destination);
  };

  return (
    <ContextMenu.Root open={open} onOpenChange={setOpen}>
      <ContextMenu.Trigger asChild>{props.children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={menuContentClass}
          collisionPadding={MENU_COLLISION_PADDING_PX}
        >
          <RowContextMenuItems props={props} onSelectMoveTo={handleMoveTo} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
