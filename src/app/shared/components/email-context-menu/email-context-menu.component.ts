import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  output,
  computed,
  effect,
  OnDestroy,
  viewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';

import { Thread } from '../../../core/models/email.model';
import { Folder } from '../../../core/models/account.model';
import {
  EmailAction,
  EmailActionContext,
  EmailActionEvent,
} from '../email-actions/email-action.model';
import { getDefaultEmailActions } from '../email-actions/email-action-defaults';
import { DEFAULT_LABEL_COLOR } from '../../constants/label-colors';
import { FoldersStore } from '../../../store/folders.store';

/**
 * The five visual sections rendered in the context menu, in order.
 * This ordering is independent of the EmailActionGroup enum values.
 */
const SECTION_ACTION_IDS: ReadonlyArray<ReadonlyArray<string>> = [
  ['edit-draft'],                        // Draft section
  ['reply', 'reply-all', 'forward'],     // Compose section
  ['move-to', 'labels', 'mark-spam', 'mark-not-spam'],  // Manage section (nested menus + spam actions)
  ['star', 'mark-read-unread'],          // State section
  ['delete'],                            // Delete section (destructive)
];

/** All non-AI actions from the default list, in the order used by the context menu. */
const NON_AI_ACTIONS: ReadonlyArray<EmailAction> = getDefaultEmailActions().filter(
  (action) => action.group !== 'ai'
);

/** Gmail folder IDs excluded from the Move To submenu. */
const EXCLUDED_FOLDER_IDS = ['[Gmail]/All Mail', '[Gmail]/Sent Mail', '[Gmail]/Important'];

/** Display order for system folders in the Move To submenu (keyed by gmailLabelId). */
const SYSTEM_FOLDER_ORDER: Record<string, number> = {
  'INBOX': 0,
  '[Gmail]/Starred': 1,
  '[Gmail]/Drafts': 2,
  '[Gmail]/Spam': 3,
  '[Gmail]/Trash': 4,
};

/** Fallback order keyed by RFC 6154 specialUse attribute (for locale-variant folder names). */
const SPECIAL_USE_FOLDER_ORDER: Record<string, number> = {
  '\\Inbox': 0,
  '\\Flagged': 1,
  '\\Drafts': 2,
  '\\Junk': 3,
  '\\Trash': 4,
};

/** Maps Gmail special-use folder IDs to Material Symbols icon names (keyed by gmailLabelId). */
const FOLDER_ICON_MAP: Record<string, string> = {
  'INBOX': 'inbox',
  '[Gmail]/Drafts': 'edit_note',
  '[Gmail]/Trash': 'delete',
  '[Gmail]/Spam': 'report',
  '[Gmail]/Starred': 'star',
};

/** Fallback icon map keyed by RFC 6154 specialUse attribute (for locale-variant folder names). */
const SPECIAL_USE_ICON_MAP: Record<string, string> = {
  '\\Inbox': 'inbox',
  '\\Drafts': 'edit_note',
  '\\Trash': 'delete',
  '\\Junk': 'report',
  '\\Flagged': 'star',
};

@Component({
  selector: 'app-email-context-menu',
  standalone: true,
  imports: [CommonModule, MatMenuModule, MatDividerModule],
  templateUrl: './email-context-menu.component.html',
  styleUrl: './email-context-menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmailContextMenuComponent implements OnDestroy {
  private readonly foldersStore = inject(FoldersStore);

  /**
   * Zero-size hidden div positioned at right-click coordinates.
   * Used as the MatMenuTrigger anchor — both viewChild calls target the same
   * template ref `#menuTrigger`, reading different tokens.
   */
  private readonly triggerDiv = viewChild<ElementRef<HTMLDivElement>>('menuTrigger');
  private readonly contextMenuTrigger = viewChild('menuTrigger', { read: MatMenuTrigger });

  /** Handle for the pending setTimeout that defers openMenu() after Angular's render cycle. */
  private pendingMenuTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // ─── Inputs ───────────────────────────────────────────────────────────────

  /** Whether the context menu should be open. */
  readonly isOpen = input.required<boolean>();
  /** Viewport coordinates for menu placement (right-click position). */
  readonly position = input<{ x: number; y: number } | null>(null);
  /** The thread the context menu is acting on. */
  readonly thread = input<Thread | null>(null);
  /** Full folder list passed through to Move To and Labels submenus. */
  readonly folders = input<Folder[]>([]);
  /** Active folder ID used for isVisible predicate evaluation. */
  readonly activeFolderId = input<string | null>(null);

  // ─── Outputs ──────────────────────────────────────────────────────────────

  /** Emitted when an action is selected. */
  readonly actionTriggered = output<EmailActionEvent>();
  /** Emitted when the menu closes by any means (action, Escape, outside click). */
  readonly closed = output<void>();

  // ─── Computed Signals ─────────────────────────────────────────────────────

  /**
   * The EmailActionContext built from the current thread and activeFolderId inputs.
   * Returns null if thread is null.
   */
  readonly actionContext = computed((): EmailActionContext | null => {
    const thread = this.thread();
    if (!thread) {
      return null;
    }
    return {
      message: null,
      thread,
      activeFolderId: this.activeFolderId(),
      aiConnected: false,
      isStarred: thread.isStarred,
      isRead: thread.isRead,
      isDraft: thread.hasDraft ?? false,
      summaryLoading: false,
      replyLoading: false,
      followUpLoading: false,
      currentFolderIds: thread.folders ?? [],
      trashFolderId: this.foldersStore.trashFolderId(),
    };
  });

  /**
   * Per-section visibility: whether each section (by SECTION_ACTION_IDS index)
   * has at least one visible item. Drives divider rendering.
   */
  readonly sectionHasVisibleItems = computed((): boolean[] => {
    const ctx = this.actionContext();
    return SECTION_ACTION_IDS.map((sectionIds) => {
      if (!ctx) {
        return false;
      }
      return sectionIds.some((actionId) => {
        const action = NON_AI_ACTIONS.find((a) => a.id === actionId);
        return action ? action.isVisible(ctx) : false;
      });
    });
  });

  /**
   * System folders eligible for Move To: excludes the active folder and
   * folders that make no sense as move targets. Sorted by predefined order.
   */
  readonly moveToFolders = computed((): Folder[] => {
    const active = this.activeFolderId();
    return this.folders()
      .filter(
        (folder) =>
          folder.type === 'system' &&
          !EXCLUDED_FOLDER_IDS.includes(folder.gmailLabelId) &&
          folder.gmailLabelId !== active,
      )
      .sort(
        (folderA, folderB) => {
          const orderA = SYSTEM_FOLDER_ORDER[folderA.gmailLabelId]
            ?? (folderA.specialUse ? SPECIAL_USE_FOLDER_ORDER[folderA.specialUse] : undefined)
            ?? Number.MAX_SAFE_INTEGER;
          const orderB = SYSTEM_FOLDER_ORDER[folderB.gmailLabelId]
            ?? (folderB.specialUse ? SPECIAL_USE_FOLDER_ORDER[folderB.specialUse] : undefined)
            ?? Number.MAX_SAFE_INTEGER;
          return orderA - orderB;
        },
      );
  });

  /**
   * User-defined label folders, sorted alphabetically.
   */
  readonly labelFolders = computed((): Folder[] =>
    this.folders()
      .filter((folder) => folder.type === 'user')
      .sort((folderA, folderB) => folderA.name.localeCompare(folderB.name)),
  );

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * React to isOpen/position changes: position the hidden trigger div and
   * call openMenu(), or close the menu if isOpen becomes false.
   *
   * Why setTimeout(0): the @if (isOpen()) guard in the template means the
   * trigger div is not in the DOM until Angular commits the render. The deferred
   * callback runs after Angular's change detection cycle, so ViewChild is resolved.
   *
   * Why closeMenu() is safe (no feedback loop): MatMenuTrigger.closeMenu() is a
   * no-op when _menuOpen is already false — it does not re-emit menuClosed.
   */
  private readonly menuLifecycleEffect = effect(() => {
    const open = this.isOpen();
    const pos = this.position();

    if (open && pos) {
      const capturedPos = { ...pos };
      this.pendingMenuTimeoutId = setTimeout(() => {
        this.pendingMenuTimeoutId = null;
        if (!this.isOpen() || !this.position()) {
          return;
        }
        const divEl = this.triggerDiv()?.nativeElement;
        if (!divEl) {
          return;
        }
        divEl.style.left = capturedPos.x + 'px';
        divEl.style.top = capturedPos.y + 'px';
        this.contextMenuTrigger()?.openMenu();
      }, 0);
    } else if (!open) {
      if (this.pendingMenuTimeoutId !== null) {
        clearTimeout(this.pendingMenuTimeoutId);
        this.pendingMenuTimeoutId = null;
      }
      this.contextMenuTrigger()?.closeMenu();
    }
  });

  ngOnDestroy(): void {
    if (this.pendingMenuTimeoutId !== null) {
      clearTimeout(this.pendingMenuTimeoutId);
    }
  }

  // ─── MatMenu Callbacks ────────────────────────────────────────────────────

  /** Called by MatMenuTrigger's (menuClosed) event when the menu closes for any reason. */
  onMatMenuClosed(): void {
    this.closed.emit();
  }

  // ─── Action Handlers ──────────────────────────────────────────────────────

  /** Move focus to the hovered item so the highlight follows the cursor (first item no longer stays focused). */
  onItemMouseEnter(event: Event): void {
    (event.currentTarget as HTMLElement).focus();
  }

  /** Handle a regular action item click. */
  onActionClick(actionId: string): void {
    this.actionTriggered.emit({ action: actionId });
  }

  /** Handle folder selection from the Move To submenu. */
  onFolderSelected(folderId: string): void {
    this.actionTriggered.emit({ action: 'move-to', targetFolder: folderId });
  }

  /**
   * Immediately toggles a label on the current thread.
   * MatMenu closes the submenu (and the parent menu) automatically after the click.
   */
  onLabelToggle(folder: Folder): void {
    if (this.isLabelActive(folder)) {
      this.actionTriggered.emit({ action: 'remove-labels', targetLabels: [folder.gmailLabelId] });
    } else {
      this.actionTriggered.emit({ action: 'add-labels', targetLabels: [folder.gmailLabelId] });
    }
  }

  // ─── Template Helpers ─────────────────────────────────────────────────────

  /** Returns the display icon for the given action, accounting for toggle state. */
  getActionIcon(action: EmailAction): string {
    const ctx = this.actionContext();
    if (action.isToggle && action.isActive && action.activeIcon && ctx) {
      return action.isActive(ctx) ? action.activeIcon : action.icon;
    }
    return action.icon;
  }

  /** Returns the display label for the given action, accounting for toggle state. */
  getActionLabel(action: EmailAction): string {
    const ctx = this.actionContext();
    if (action.isToggle && action.isActive && action.activeLabel && ctx) {
      return action.isActive(ctx) ? action.activeLabel : action.label;
    }
    return action.label;
  }

  /** Returns whether a given action is visible given the current context. */
  isActionVisible(actionId: string): boolean {
    const ctx = this.actionContext();
    if (!ctx) {
      return false;
    }
    const action = NON_AI_ACTIONS.find((a) => a.id === actionId);
    return action ? action.isVisible(ctx) : false;
  }

  /** Returns whether a divider should be rendered between section[index] and section[index+1]. */
  shouldShowDivider(afterSectionIndex: number): boolean {
    const visibility = this.sectionHasVisibleItems();
    return (
      visibility[afterSectionIndex] === true &&
      visibility[afterSectionIndex + 1] === true
    );
  }

  /** Expose the action object for a given ID (for template use). */
  getAction(actionId: string): EmailAction | undefined {
    return NON_AI_ACTIONS.find((a) => a.id === actionId);
  }

  /** Returns whether the given label folder is currently applied to the thread. */
  isLabelActive(folder: Folder): boolean {
    return this.thread()?.folders?.includes(folder.gmailLabelId) ?? false;
  }

  /** Returns the display icon for a folder in the Move To list. */
  getFolderIcon(folder: Folder): string {
    return folder.icon
      || FOLDER_ICON_MAP[folder.gmailLabelId]
      || (folder.specialUse ? SPECIAL_USE_ICON_MAP[folder.specialUse] : undefined)
      || 'folder';
  }

  /** Returns the display color for a label folder, falling back to the default. */
  getLabelColor(folder: Folder): string {
    return folder.color || DEFAULT_LABEL_COLOR;
  }
}
