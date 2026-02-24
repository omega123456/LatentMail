import { Injectable, inject, effect } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { KeyboardService, KeyboardShortcut } from './keyboard.service';
import { AccountsStore } from '../../store/accounts.store';
import { ComposeStore } from '../../store/compose.store';
import { FoldersStore } from '../../store/folders.store';
import { UiStore } from '../../store/ui.store';
import { SettingsStore } from '../../store/settings.store';
import { ElectronService } from './electron.service';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Command {
  id: string;
  label: string;
  description?: string;
  /** Material Symbols icon name shown in the command palette. */
  icon: string;
  /**
   * Normalized key combo strings registered with KeyboardService.
   * The first entry is the "primary" binding displayed in the palette.
   * Additional entries are alternate bindings that trigger the same action.
   * Examples: `['ctrl+k']`, `['ctrl+f', '/']`, `['g i']` (chord).
   */
  defaultKeys: string[];
  action: () => void;
  /**
   * Optional context hint used for display/filtering in the palette.
   * Does NOT gate keyboard execution — all commands are registered globally.
   */
  context?: KeyboardShortcut['context'];
}

export interface ConflictResult {
  hasConflict: boolean;
  conflictingCommandId?: string;
}

// ---------------------------------------------------------------------------
// Platform helper (renderer process — navigator is always available)
// ---------------------------------------------------------------------------

const IS_MAC = navigator.platform.toLowerCase().startsWith('mac');

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class CommandRegistryService {
  private readonly keyboardService = inject(KeyboardService);
  private readonly settingsStore = inject(SettingsStore);
  private readonly uiStore = inject(UiStore);
  private readonly accountsStore = inject(AccountsStore);
  private readonly composeStore = inject(ComposeStore);
  private readonly foldersStore = inject(FoldersStore);
  private readonly router = inject(Router);
  private readonly electronService = inject(ElectronService);

  private readonly commands = new Map<string, Command>();
  private readonly commandExecutedSubject = new Subject<string>();

  /** Emits the command ID whenever a command is executed (via keyboard or palette). */
  readonly commandTriggered$ = this.commandExecutedSubject.asObservable();

  constructor() {
    this.registerDefaultCommands();
    // Re-register ALL keyboard shortcuts whenever customKeyBindings changes in
    // SettingsStore (including after the async loadSettings() call at startup).
    effect(() => {
      // Signal read establishes reactive dependency; effect body re-runs on change.
      const _bindings = this.settingsStore.customKeyBindings();
      this.reRegisterAllBindings();
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Returns all registered commands, sorted by label. */
  getAllCommands(): Command[] {
    return Array.from(this.commands.values()).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
  }

  /** Returns a single command by ID, or `undefined` if not found. */
  getCommand(commandId: string): Command | undefined {
    return this.commands.get(commandId);
  }

  /**
   * Execute a command by ID.
   * Tracks recent usage in `UiStore` and emits on `commandTriggered$`.
   */
  executeCommand(commandId: string): void {
    const command = this.commands.get(commandId);
    if (!command) {
      return;
    }
    command.action();
    this.commandExecutedSubject.next(commandId);
    this.uiStore.trackCommandExecution(commandId);
  }

  /**
   * Check whether a key combo is already used by another command.
   * Pass `excludeId` to ignore the command being edited (self-conflict).
   */
  checkConflict(keys: string, excludeId?: string): ConflictResult {
    for (const command of this.commands.values()) {
      if (command.id === excludeId) {
        continue;
      }
      const effectiveKeys = this.getEffectiveKeys(command.id);
      if (effectiveKeys.includes(keys)) {
        return { hasConflict: true, conflictingCommandId: command.id };
      }
    }
    return { hasConflict: false };
  }

  /**
   * Format a normalized key combo for human-readable display.
   * Respects the current platform (Mac vs Windows/Linux).
   *
   * Examples:
   *  `'ctrl+k'`   → `'⌘K'` (Mac) / `'Ctrl+K'` (Win)
   *  `'shift+r'`  → `'⇧R'` (Mac) / `'Shift+R'` (Win)
   *  `'g i'`      → `'G then I'` (chord)
   *  `'/'`        → `'/'`
   */
  formatKeyCombo(keys: string): string {
    // Chord: two tokens separated by a space (e.g. 'g i')
    if (keys.includes(' ')) {
      return keys
        .split(' ')
        .map(part => this.formatSingleCombo(part))
        .join(' then ');
    }
    return this.formatSingleCombo(keys);
  }

  /**
   * Returns the effective key list for a command:
   * - The custom binding (single entry) when the user has overridden the default
   * - All default bindings otherwise
   *
   * Public so the command palette can display the currently active binding.
   */
  getEffectiveKeys(commandId: string): string[] {
    const command = this.commands.get(commandId);
    if (!command) {
      return [];
    }
    const custom = this.settingsStore.customKeyBindings()[commandId];
    return custom ? [custom] : command.defaultKeys;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private registerCommand(command: Command): void {
    // Only stores the command definition — keyboard registration happens via the
    // reactive effect in the constructor so custom bindings are always applied.
    this.commands.set(command.id, command);
  }

  /**
   * Re-register every command's keyboard shortcuts from scratch.
   * Reads the current `customKeyBindings` from SettingsStore so custom
   * overrides (or their removal) are always honoured.
   * Called reactively via `effect()` whenever `customKeyBindings` changes.
   */
  private reRegisterAllBindings(): void {
    for (const command of this.commands.values()) {
      this.unregisterFromKeyboard(command);
      this.registerWithKeyboard(command);
    }
  }

  /** Register all effective key bindings for a command with `KeyboardService`. */
  private registerWithKeyboard(command: Command): void {
    const effectiveKeys = this.getEffectiveKeys(command.id);
    effectiveKeys.forEach((keys, index) => {
      const shortcutId = index === 0 ? command.id : `${command.id}:alt:${index - 1}`;
      this.keyboardService.register({
        id: shortcutId,
        keys,
        description: command.label,
        context: command.context,
        action: () => { this.executeCommand(command.id); },
      });
    });
  }

  /** Unregister all key bindings for a command from `KeyboardService`. */
  private unregisterFromKeyboard(command: Command): void {
    this.keyboardService.unregister(command.id);
    // Unregister all possible alternate slots based on the number of default
    // keys (custom bindings only ever use the primary slot, so unregistering
    // default alternates is always safe even after a custom override).
    command.defaultKeys.forEach((_, index) => {
      if (index > 0) {
        this.keyboardService.unregister(`${command.id}:alt:${index - 1}`);
      }
    });
  }

  private formatSingleCombo(combo: string): string {
    const parts = combo.split('+');
    const formatted = parts.map(part => {
      switch (part) {
        case 'ctrl': return IS_MAC ? '⌘' : 'Ctrl';
        case 'shift': return IS_MAC ? '⇧' : 'Shift';
        case 'alt': return IS_MAC ? '⌥' : 'Alt';
        case 'arrowup': return '↑';
        case 'arrowdown': return '↓';
        case 'arrowleft': return '←';
        case 'arrowright': return '→';
        case 'enter': return '↵';
        case 'escape': return 'Esc';
        case 'backspace': return '⌫';
        default: return part.toUpperCase();
      }
    });

    // On Mac, modifier glyphs are joined without a separator.
    // On Win/Linux, use '+' between parts.
    if (IS_MAC) {
      const modifiers = formatted.filter(part => ['⌘', '⇧', '⌥'].includes(part));
      const keys = formatted.filter(part => !['⌘', '⇧', '⌥'].includes(part));
      return [...modifiers, ...keys].join('');
    }
    return formatted.join('+');
  }

  // -------------------------------------------------------------------------
  // Default commands
  // -------------------------------------------------------------------------

  private registerDefaultCommands(): void {
    // --- Global / Navigation ---

    this.registerCommand({
      id: 'compose-new',
      label: 'Compose New Email',
      description: 'Open a new compose window',
      icon: 'edit',
      defaultKeys: ['ctrl+n'],
      context: 'global',
      action: () => {
        const account = this.accountsStore.activeAccount();
        if (!account) {
          return;
        }
        this.composeStore.openCompose({
          mode: 'new',
          accountId: account.id,
          accountEmail: account.email,
          accountDisplayName: account.displayName,
        });
      },
    });

    this.registerCommand({
      id: 'search-focus',
      label: 'Search Emails',
      description: 'Focus the search bar',
      icon: 'search',
      defaultKeys: ['ctrl+f', '/'],
      context: 'global',
      action: () => {
        // Handled by mail-shell via commandTriggered$ subscription (Part 3)
      },
    });

    this.registerCommand({
      id: 'sync-now',
      label: 'Sync Now',
      description: 'Sync the current account immediately',
      icon: 'sync',
      defaultKeys: ['ctrl+r'],
      context: 'global',
      action: () => {
        const account = this.accountsStore.activeAccount();
        if (!account) {
          return;
        }
        void this.electronService.syncAccount(String(account.id));
      },
    });

    this.registerCommand({
      id: 'open-settings',
      label: 'Open Settings',
      description: 'Navigate to the settings page',
      icon: 'settings',
      defaultKeys: ['ctrl+,'],
      context: 'global',
      action: () => {
        void this.router.navigate(['/settings']);
      },
    });

    this.registerCommand({
      id: 'toggle-command-palette',
      label: 'Command Palette',
      description: 'Open or close the command palette',
      icon: 'terminal',
      defaultKeys: ['ctrl+k'],
      context: 'global',
      action: () => {
        this.uiStore.toggleCommandPalette();
      },
    });

    this.registerCommand({
      id: 'toggle-sidebar',
      label: 'Toggle Sidebar',
      description: 'Show or hide the folder sidebar',
      icon: 'dock_to_right',
      defaultKeys: ['ctrl+b'],
      context: 'global',
      action: () => {
        this.uiStore.toggleSidebar();
      },
    });

    this.registerCommand({
      id: 'toggle-reading-pane',
      label: 'Toggle Reading Pane',
      description: 'Switch between three-column and list-only layouts',
      icon: 'article',
      defaultKeys: ['ctrl+.'],
      context: 'global',
      action: () => {
        const current = this.uiStore.layout();
        const next = current === 'list-only' ? 'three-column' : 'list-only';
        this.uiStore.setLayout(next);
      },
    });

    // --- Folder navigation ---

    this.registerCommand({
      id: 'go-inbox',
      label: 'Go to Inbox',
      description: 'Switch to the Inbox folder',
      icon: 'inbox',
      defaultKeys: ['g i'],
      context: 'global',
      action: () => {
        // Pre-set the active folder so that when mail-shell initialises it loads
        // the correct folder immediately (covers the cross-route case from settings).
        this.foldersStore.setActiveFolder('INBOX');
        void this.router.navigate(['/mail']);
        // Mail-shell's commandTriggered$ subscription also handles the in-shell case.
      },
    });

    this.registerCommand({
      id: 'go-sent',
      label: 'Go to Sent',
      description: 'Switch to the Sent folder',
      icon: 'send',
      defaultKeys: ['g s'],
      context: 'global',
      action: () => {
        this.foldersStore.setActiveFolder('[Gmail]/Sent Mail');
        void this.router.navigate(['/mail']);
      },
    });

    this.registerCommand({
      id: 'go-drafts',
      label: 'Go to Drafts',
      description: 'Switch to the Drafts folder',
      icon: 'edit_note',
      defaultKeys: ['g d'],
      context: 'global',
      action: () => {
        this.foldersStore.setActiveFolder('[Gmail]/Drafts');
        void this.router.navigate(['/mail']);
      },
    });

    // --- Email actions (context: email-selected) ---

    this.registerCommand({
      id: 'reply',
      label: 'Reply',
      description: 'Reply to the selected email',
      icon: 'reply',
      defaultKeys: ['r'],
      context: 'email-selected',
      action: () => {
        // Delegated to mail-shell via commandTriggered$ (Part 3)
      },
    });

    this.registerCommand({
      id: 'reply-all',
      label: 'Reply All',
      description: 'Reply to all recipients of the selected email',
      icon: 'reply_all',
      defaultKeys: ['shift+r'],
      context: 'email-selected',
      action: () => {
        // Delegated to mail-shell via commandTriggered$ (Part 3)
      },
    });

    this.registerCommand({
      id: 'forward',
      label: 'Forward',
      description: 'Forward the selected email',
      icon: 'forward',
      defaultKeys: ['f'],
      context: 'email-selected',
      action: () => {
        // Delegated to mail-shell via commandTriggered$ (Part 3)
      },
    });

    this.registerCommand({
      id: 'delete',
      label: 'Delete',
      description: 'Move the selected email or thread to Trash',
      icon: 'delete',
      defaultKeys: ['delete'],
      context: 'email-selected',
      action: () => {
        // Delegated to mail-shell / email-list via commandTriggered$ (Part 3)
      },
    });

    this.registerCommand({
      id: 'star',
      label: 'Star / Unstar',
      description: 'Toggle star on the selected email or thread',
      icon: 'star',
      defaultKeys: ['s'],
      context: 'email-selected',
      action: () => {
        // Delegated to mail-shell via commandTriggered$ (Part 3)
      },
    });

    this.registerCommand({
      id: 'mark-read',
      label: 'Mark Read',
      description: 'Mark the selected email or thread as read',
      icon: 'mark_email_read',
      defaultKeys: ['shift+i'],
      context: 'email-selected',
      action: () => {
        // Delegated to mail-shell via commandTriggered$ (Part 3)
      },
    });

    this.registerCommand({
      id: 'mark-unread',
      label: 'Mark Unread',
      description: 'Mark the selected email or thread as unread',
      icon: 'mark_email_unread',
      defaultKeys: ['shift+u'],
      context: 'email-selected',
      action: () => {
        // Delegated to mail-shell via commandTriggered$ (Part 3)
      },
    });

    // --- Email list navigation ---

    this.registerCommand({
      id: 'nav-next',
      label: 'Next Email',
      description: 'Select the next email in the list',
      icon: 'arrow_downward',
      defaultKeys: ['j', 'arrowdown'],
      context: 'email-list',
      action: () => {
        // Delegated to email-list via commandTriggered$ (Part 3)
      },
    });

    this.registerCommand({
      id: 'nav-prev',
      label: 'Previous Email',
      description: 'Select the previous email in the list',
      icon: 'arrow_upward',
      defaultKeys: ['k', 'arrowup'],
      context: 'email-list',
      action: () => {
        // Delegated to email-list via commandTriggered$ (Part 3)
      },
    });

    this.registerCommand({
      id: 'open-thread',
      label: 'Open Thread',
      description: 'Open the selected thread in the reading pane',
      icon: 'open_in_new',
      defaultKeys: ['enter', 'o'],
      context: 'email-list',
      action: () => {
        // Delegated to email-list via commandTriggered$ (Part 3)
      },
    });

    // --- Misc ---

    this.registerCommand({
      id: 'ai-summarize',
      label: 'AI Summarize Thread',
      description: 'Summarize the selected thread using AI',
      icon: 'auto_awesome',
      defaultKeys: ['ctrl+j'],
      context: 'email-selected',
      action: () => {
        // Delegated to reading-pane via commandTriggered$ (Part 3)
      },
    });

    this.registerCommand({
      id: 'select-all',
      label: 'Select All',
      description: 'Select all visible emails',
      icon: 'select_all',
      defaultKeys: ['ctrl+a'],
      context: 'email-list',
      action: () => {
        // Delegated to email-list / mail-shell via commandTriggered$ (Part 3)
      },
    });

    this.registerCommand({
      id: 'escape',
      label: 'Escape / Close',
      description: 'Deselect emails or close the active overlay',
      icon: 'close',
      defaultKeys: ['escape'],
      context: 'global',
      action: () => {
        // Close command palette if open; otherwise delegate to mail-shell (Part 3)
        if (this.uiStore.commandPaletteOpen()) {
          this.uiStore.closeCommandPalette();
        }
      },
    });
  }
}
