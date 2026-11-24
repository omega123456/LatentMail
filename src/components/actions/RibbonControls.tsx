import { useState, type ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
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
import { LabelsMenu, type LabelMenuEntry } from './LabelsMenu';
import { MoveToMenu, type MoveDestinationId } from './MoveToMenu';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { popoverPanelClass } from '@/components/shared/styles';

export type RibbonScale = 'lg' | 'sm';

export type RibbonTheme = {
  iconSize: number;
  iconButtonClass: string;
  deleteButtonClass: string;
  separatorClass: string;
  popoverAlign: 'start' | 'end';
};

export const RIBBON_THEMES: Record<RibbonScale, RibbonTheme> = {
  lg: {
    iconSize: ICON_SIZE.lg,
    iconButtonClass:
      'inline-flex items-center justify-center gap-1 rounded p-2 text-secondary hover:bg-surface-container-low hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container dark:hover:text-dark-on-surface cursor-pointer',
    deleteButtonClass:
      'inline-flex items-center justify-center rounded p-2 text-secondary hover:bg-error-container hover:text-error focus-visible:outline-2 focus-visible:outline-error dark:text-dark-secondary dark:hover:bg-dark-error-container dark:hover:text-dark-error cursor-pointer',
    separatorClass: 'mx-1 h-5 w-px bg-outline-variant/50 dark:bg-dark-outline-variant/50',
    popoverAlign: 'start',
  },
  sm: {
    iconSize: ICON_SIZE.sm,
    iconButtonClass:
      'inline-flex items-center justify-center rounded p-1.5 text-secondary hover:bg-surface-container-low hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container dark:hover:text-dark-on-surface cursor-pointer',
    deleteButtonClass:
      'inline-flex items-center justify-center rounded p-1.5 text-secondary hover:bg-error-container hover:text-error focus-visible:outline-2 focus-visible:outline-error dark:text-dark-secondary dark:hover:bg-dark-error-container dark:hover:text-dark-error cursor-pointer',
    separatorClass: 'mx-0.5 h-4 w-px bg-outline-variant/50 dark:bg-dark-outline-variant/50',
    popoverAlign: 'end',
  },
};

export const POPOVER_SURFACE_CLASS = `${popoverPanelClass} p-2`;

export function computeRibbonVisibility(systemLabelIds: string[]) {
  const isDrafts = systemLabelIds.includes('DRAFT');
  const isTrash = systemLabelIds.includes('TRASH');
  const isSpam = systemLabelIds.includes('SPAM');
  const spamMode: 'notSpam' | 'markSpam' = isSpam ? 'notSpam' : 'markSpam';
  return {
    showReadToggle: !isDrafts,
    showStar: !isDrafts && !isTrash,
    showLabels: !isDrafts,
    showMoveTo: !isDrafts,
    showSpamToggle: !isDrafts,
    showDelete: !isTrash,
    spamMode: spamMode,
  };
}

export function RibbonSeparator({ theme }: { theme: RibbonTheme }) {
  return <span aria-hidden="true" className={theme.separatorClass} />;
}

export function RibbonIconButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className: string;
  children: ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={className}>
      {children}
    </button>
  );
}

export function RibbonComposeGroup({
  theme,
  onReply,
  onReplyAll,
  onForward,
  onEditDraft,
}: {
  theme: RibbonTheme;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onEditDraft?: () => void;
}) {
  return (
    <>
      <RibbonIconButton label="Reply" onClick={onReply} className={theme.iconButtonClass}>
        <Reply aria-hidden="true" size={theme.iconSize} />
      </RibbonIconButton>
      <RibbonIconButton label="Reply all" onClick={onReplyAll} className={theme.iconButtonClass}>
        <ReplyAll aria-hidden="true" size={theme.iconSize} />
      </RibbonIconButton>
      <RibbonIconButton label="Forward" onClick={onForward} className={theme.iconButtonClass}>
        <Forward aria-hidden="true" size={theme.iconSize} />
      </RibbonIconButton>
      {onEditDraft && (
        <RibbonIconButton
          label="Edit draft"
          onClick={onEditDraft}
          className={theme.iconButtonClass}
        >
          <PenSquare aria-hidden="true" size={theme.iconSize} />
        </RibbonIconButton>
      )}
      <RibbonSeparator theme={theme} />
    </>
  );
}

export function RibbonReadButton({
  theme,
  unread,
  onToggleRead,
}: {
  theme: RibbonTheme;
  unread: boolean;
  onToggleRead: () => void;
}) {
  const label = unread ? 'Mark read' : 'Mark unread';
  return (
    <RibbonIconButton label={label} onClick={onToggleRead} className={theme.iconButtonClass}>
      {unread ? (
        <Mail aria-hidden="true" size={theme.iconSize} />
      ) : (
        <MailOpen aria-hidden="true" size={theme.iconSize} />
      )}
    </RibbonIconButton>
  );
}

export function RibbonStarButton({
  theme,
  starred,
  onToggleStar,
}: {
  theme: RibbonTheme;
  starred: boolean;
  onToggleStar: () => void;
}) {
  const label = starred ? 'Unstar' : 'Star';
  const className = `${theme.iconButtonClass} ${starred ? 'text-star dark:text-dark-star' : ''}`;
  return (
    <RibbonIconButton label={label} onClick={onToggleStar} className={className}>
      <Star aria-hidden="true" size={theme.iconSize} fill={starred ? 'currentColor' : 'none'} />
    </RibbonIconButton>
  );
}

export function RibbonLabelsPopover({
  theme,
  labels,
  onCreateLabel,
  onApplyLabels,
}: {
  theme: RibbonTheme;
  labels: LabelMenuEntry[];
  onCreateLabel?: () => void;
  onApplyLabels: (changes: { add: string[]; remove: string[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label="Labels" title="Labels" className={theme.iconButtonClass}>
          <Tag aria-hidden="true" size={theme.iconSize} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={theme.popoverAlign}
          className={`min-w-64 ${POPOVER_SURFACE_CLASS}`}
        >
          <LabelsMenu
            variant="staged"
            labels={labels}
            onCreateLabel={onCreateLabel}
            onApply={(changes) => {
              onApplyLabels(changes);
              setOpen(false);
            }}
            onCancel={() => setOpen(false)}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function RibbonMoveToPopover({
  theme,
  currentSystemLabelIds,
  onMoveTo,
}: {
  theme: RibbonTheme;
  currentSystemLabelIds: string[];
  onMoveTo: (destination: MoveDestinationId) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Move to"
          title="Move to"
          className={theme.iconButtonClass}
        >
          <FolderInput aria-hidden="true" size={theme.iconSize} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={theme.popoverAlign}
          className={`min-w-52 ${POPOVER_SURFACE_CLASS}`}
        >
          <MoveToMenu
            currentSystemLabelIds={currentSystemLabelIds}
            onSelect={(destination) => {
              onMoveTo(destination);
              setOpen(false);
            }}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function RibbonSpamButton({
  theme,
  spamMode,
  onToggleSpam,
}: {
  theme: RibbonTheme;
  spamMode: 'notSpam' | 'markSpam';
  onToggleSpam: () => void;
}) {
  const isNotSpam = spamMode === 'notSpam';
  const label = isNotSpam ? 'Not spam' : 'Mark as spam';
  return (
    <RibbonIconButton label={label} onClick={onToggleSpam} className={theme.iconButtonClass}>
      {isNotSpam ? (
        <ShieldOff aria-hidden="true" size={theme.iconSize} />
      ) : (
        <ShieldAlert aria-hidden="true" size={theme.iconSize} />
      )}
    </RibbonIconButton>
  );
}

export function RibbonDeleteButton({
  theme,
  onDelete,
}: {
  theme: RibbonTheme;
  onDelete: () => void;
}) {
  return (
    <RibbonIconButton label="Delete" onClick={onDelete} className={theme.deleteButtonClass}>
      <Trash2 aria-hidden="true" size={theme.iconSize} />
    </RibbonIconButton>
  );
}
