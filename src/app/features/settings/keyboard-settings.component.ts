import { Component, inject, signal, computed, OnInit, ChangeDetectionStrategy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SettingsStore } from '../../store/settings.store';
import { CommandRegistryService, Command } from '../../core/services/command-registry.service';

/** A command enriched with its current effective binding and conflict state. */
interface CommandRow extends Command {
  effectiveKeys: string[];
  formattedPrimaryKey: string;
  hasCustomBinding: boolean;
}

/** Conflict information shown inline while the user is editing a binding. */
interface ConflictWarning {
  conflictingCommandId: string;
  conflictingCommandLabel: string;
}

@Component({
  selector: 'app-keyboard-settings',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatTooltipModule],
  templateUrl: './keyboard-settings.component.html',
  styleUrl: './keyboard-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeyboardSettingsComponent implements OnInit {
  /** Public so the template can call formatKeyCombo() and getCommand() directly. */
  readonly commandRegistry = inject(CommandRegistryService);
  readonly settingsStore = inject(SettingsStore);

  /**
   * All commands enriched with live effective key data.
   * Reactive: rebuilds whenever `customKeyBindings` changes (e.g. after apply/reset).
   */
  readonly commandRows = computed<CommandRow[]>(() => {
    // Reading customKeyBindings() establishes a reactive dependency so this
    // computed re-runs whenever any binding is added, changed, or removed.
    const customBindings = this.settingsStore.customKeyBindings();
    return this.commandRegistry.getAllCommands().map(command => {
      const effectiveKeys = this.commandRegistry.getEffectiveKeys(command.id);
      const primaryKey = effectiveKeys[0] ?? '';
      return {
        ...command,
        effectiveKeys,
        formattedPrimaryKey: primaryKey
          ? this.commandRegistry.formatKeyCombo(primaryKey)
          : 'None',
        hasCustomBinding: !!customBindings[command.id],
      };
    });
  });

  // -------------------------------------------------------------------------
  // Capture-mode state (one command at a time)
  // -------------------------------------------------------------------------

  /** The command currently being re-bound, or null if no capture is active. */
  readonly capturingCommandId = signal<string | null>(null);

  /** The key combo the user has pressed during capture (normalized string). */
  readonly pendingKeys = signal<string>('');

  /** Conflict info if the pending key combo is already assigned to another command. */
  readonly conflictWarning = signal<ConflictWarning | null>(null);

  /** Whether a save operation is in progress (disables buttons briefly). */
  readonly saving = signal<boolean>(false);

  constructor() {
    // Auto-focus the capture input whenever capture mode is activated.
    // setTimeout(0) defers to the next microtask so the @if block has time
    // to add the <input> element to the DOM before we query it.
    effect(() => {
      const isCapturing = this.capturingCommandId() !== null;
      if (isCapturing) {
        setTimeout(() => {
          const captureInput = document.querySelector<HTMLInputElement>('.capture-input');
          if (captureInput) {
            captureInput.focus();
          }
        }, 0);
      }
    });
  }

  ngOnInit(): void {
    // Ensure custom bindings are loaded from the DB before rendering.
    this.settingsStore.loadSettings();
  }

  // -------------------------------------------------------------------------
  // Capture-mode lifecycle
  // -------------------------------------------------------------------------

  /** Enter capture mode for the given command. */
  startCapture(commandId: string): void {
    this.capturingCommandId.set(commandId);
    this.pendingKeys.set('');
    this.conflictWarning.set(null);
  }

  /** Cancel capture without saving. */
  cancelCapture(): void {
    this.capturingCommandId.set(null);
    this.pendingKeys.set('');
    this.conflictWarning.set(null);
  }

  /**
   * Handle keydown events inside the capture input.
   *
   * The input has `readonly` so the browser does not insert characters, and
   * KeyboardService skips INPUT elements (except Escape), so our handler has
   * exclusive control over the captured keys.
   */
  onCaptureKeydown(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();

    // Escape → cancel without saving.
    if (event.key === 'Escape') {
      this.cancelCapture();
      return;
    }

    // Ignore lone modifier key presses (wait for a non-modifier key).
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
      return;
    }

    const keyCombo = this.buildKeyCombo(event);
    this.pendingKeys.set(keyCombo);

    // Check for conflicts immediately so the warning appears before the user
    // decides to apply.
    const commandId = this.capturingCommandId();
    if (commandId) {
      const conflict = this.commandRegistry.checkConflict(keyCombo, commandId);
      if (conflict.hasConflict && conflict.conflictingCommandId) {
        const conflicting = this.commandRegistry.getCommand(conflict.conflictingCommandId);
        this.conflictWarning.set({
          conflictingCommandId: conflict.conflictingCommandId,
          conflictingCommandLabel: conflicting?.label ?? conflict.conflictingCommandId,
        });
      } else {
        this.conflictWarning.set(null);
      }
    }
  }

  /**
   * Apply the pending key combo to the current command and exit capture mode.
   * `saving` is always cleared in `finally` to avoid a permanent locked-UI state
   * if the IPC call throws (disk/network error).
   */
  async applyCapture(): Promise<void> {
    const commandId = this.capturingCommandId();
    const keys = this.pendingKeys();
    if (!commandId || !keys) {
      return;
    }
    this.saving.set(true);
    try {
      await this.settingsStore.setKeyBinding(commandId, keys);
    } finally {
      this.saving.set(false);
      this.cancelCapture();
    }
  }

  /**
   * Reassign: clear the conflicting command's binding, then save the new binding
   * for the command currently being edited. Inlines the save logic (rather than
   * calling `applyCapture`) to avoid toggling `saving` twice and to keep one
   * clear `try/finally` guard for both IPC calls.
   */
  async reassignAndApply(): Promise<void> {
    const warning = this.conflictWarning();
    const commandId = this.capturingCommandId();
    const keys = this.pendingKeys();
    if (!warning || !commandId || !keys) {
      return;
    }
    this.saving.set(true);
    try {
      await this.settingsStore.resetKeyBinding(warning.conflictingCommandId);
      await this.settingsStore.setKeyBinding(commandId, keys);
    } finally {
      this.saving.set(false);
      this.cancelCapture();
    }
  }

  // -------------------------------------------------------------------------
  // Per-command and global reset
  // -------------------------------------------------------------------------

  /** Reset a single command to its default binding. */
  async resetBinding(commandId: string): Promise<void> {
    await this.settingsStore.resetKeyBinding(commandId);
    // If this command was being captured, also exit capture mode.
    if (this.capturingCommandId() === commandId) {
      this.cancelCapture();
    }
  }

  /** Reset ALL custom bindings, restoring every command to its default. */
  async resetAllBindings(): Promise<void> {
    this.cancelCapture();
    await this.settingsStore.resetAllKeyBindings();
  }

  // -------------------------------------------------------------------------
  // Template helpers
  // -------------------------------------------------------------------------

  /** True when at least one command has a custom override. */
  readonly hasAnyCustomBindings = computed<boolean>(() =>
    Object.keys(this.settingsStore.customKeyBindings()).length > 0
  );

  /**
   * Build a normalised key combo string from a KeyboardEvent.
   * Uses the same format as KeyboardService.getKeyCombo() so the resulting
   * string can be registered directly without conversion.
   */
  private buildKeyCombo(event: KeyboardEvent): string {
    const parts: string[] = [];
    if (event.ctrlKey || event.metaKey) {
      parts.push('ctrl');
    }
    if (event.shiftKey) {
      parts.push('shift');
    }
    if (event.altKey) {
      parts.push('alt');
    }
    const keyName = event.key.toLowerCase();
    parts.push(keyName);
    return parts.join('+');
  }
}
