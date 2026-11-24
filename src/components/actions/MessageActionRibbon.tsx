import { DropdownMenu } from 'radix-ui';
import { Download, EllipsisVertical, FileCode, Globe } from 'lucide-react';
import { formatBindingLabel, isMacPlatform, primaryBinding } from '@/lib/keyboard/format';
import { useCommandBindings } from '@/providers/CommandProvider';
import type { LabelMenuEntry } from './LabelsMenu';
import type { MoveDestinationId } from './MoveToMenu';
import { itemClass, menuContentClass } from './RowContextMenu';
import {
  computeRibbonVisibility,
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
import { MENU_COLLISION_PADDING_PX } from '@/components/shared/floating-offsets';

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

const THEME = RIBBON_THEMES.sm;

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
  const visibility = computeRibbonVisibility(systemLabelIds);

  return (
    <div
      data-testid="message-action-ribbon"
      role="toolbar"
      aria-label="Message actions"
      className="flex items-center gap-1"
    >
      <RibbonComposeGroup
        theme={THEME}
        onReply={onReply}
        onReplyAll={onReplyAll}
        onForward={onForward}
        onEditDraft={onEditDraft}
      />
      {visibility.showReadToggle && (
        <RibbonReadButton theme={THEME} unread={unread} onToggleRead={onToggleRead} />
      )}
      {visibility.showStar && (
        <RibbonStarButton theme={THEME} starred={starred} onToggleStar={onToggleStar} />
      )}
      {visibility.showLabels && (
        <RibbonLabelsPopover
          theme={THEME}
          labels={labels}
          onCreateLabel={onCreateLabel}
          onApplyLabels={onApplyLabels}
        />
      )}
      {visibility.showMoveTo && (
        <RibbonMoveToPopover
          theme={THEME}
          currentSystemLabelIds={systemLabelIds}
          onMoveTo={onMoveTo}
        />
      )}
      {visibility.showSpamToggle && (
        <>
          <RibbonSeparator theme={THEME} />
          <RibbonSpamButton
            theme={THEME}
            spamMode={visibility.spamMode}
            onToggleSpam={onToggleSpam}
          />
        </>
      )}
      {visibility.showDelete && (
        <>
          <RibbonSeparator theme={THEME} />
          <RibbonDeleteButton theme={THEME} onDelete={onDelete} />
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
          className={THEME.iconButtonClass}
        >
          <EllipsisVertical aria-hidden="true" size={ICON_SIZE.sm} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className={menuContentClass}
          collisionPadding={MENU_COLLISION_PADDING_PX}
        >
          <DropdownMenu.Item className={itemClass} onSelect={actions.onShowOriginal}>
            <FileCode aria-hidden="true" size={ICON_SIZE.base} />
            Show original
            {binding && (
              <span className="ml-auto pl-4 text-label-sm text-secondary dark:text-dark-secondary">
                {formatBindingLabel(binding, isMac)}
              </span>
            )}
          </DropdownMenu.Item>
          <DropdownMenu.Item className={itemClass} onSelect={actions.onDownloadEml}>
            <Download aria-hidden="true" size={ICON_SIZE.base} />
            Download message (.eml)
          </DropdownMenu.Item>
          <DropdownMenu.Item className={itemClass} onSelect={actions.onDownloadHtml}>
            <Globe aria-hidden="true" size={ICON_SIZE.base} />
            Download as web page (.html)
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
