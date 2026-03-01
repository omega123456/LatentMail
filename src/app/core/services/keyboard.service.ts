import { Injectable, NgZone, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { ComposeStore } from '../../store/compose.store';

export interface KeyboardShortcut {
  id: string;
  keys: string; // e.g., 'ctrl+k', 'g i' (chord)
  description: string;
  context?: 'global' | 'email-list' | 'email-selected' | 'compose';
  action: () => void;
}

@Injectable({ providedIn: 'root' })
export class KeyboardService {
  private readonly composeStore = inject(ComposeStore);
  private shortcuts: Map<string, KeyboardShortcut> = new Map();
  private chordPrefix: string | null = null;
  private chordTimeout: ReturnType<typeof setTimeout> | null = null;
  readonly shortcutTriggered = new Subject<string>();

  constructor(private ngZone: NgZone) {
    document.addEventListener('keydown', (event) => this.handleKeyDown(event));
  }

  register(shortcut: KeyboardShortcut): void {
    this.shortcuts.set(shortcut.id, shortcut);
  }

  unregister(id: string): void {
    this.shortcuts.delete(id);
  }

  getAll(): KeyboardShortcut[] {
    return Array.from(this.shortcuts.values());
  }

  private handleKeyDown(event: KeyboardEvent): void {
    // When compose is open, only global shortcuts and Escape (no reply/forward etc.).
    // When compose is closed, also skip non-global when focus is in input/textarea/contenteditable.
    const target = event.target as HTMLElement;
    const composeOpen = this.composeStore.isOpen();
    const inComposeOverlay = target.closest?.('.compose-window') !== null;
    const inEditable =
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable;
    if (composeOpen || inEditable || inComposeOverlay) {
      const keyCombo = this.getKeyCombo(event);
      const globalShortcut = this.findShortcut(keyCombo, 'global');
      if (globalShortcut) {
        event.preventDefault();
        this.ngZone.run(() => {
          globalShortcut.action();
          this.shortcutTriggered.next(globalShortcut.id);
        });
        return;
      }
      // Allow escape to still work
      if (event.key !== 'Escape') {
        return;
      }
    }

    const keyCombo = this.getKeyCombo(event);

    // Handle chord (two-key sequence like "g i")
    if (this.chordPrefix) {
      const chordKey = `${this.chordPrefix} ${keyCombo}`;
      this.chordPrefix = null;
      if (this.chordTimeout) {
        clearTimeout(this.chordTimeout);
        this.chordTimeout = null;
      }

      const shortcut = this.findShortcut(chordKey);
      if (shortcut) {
        event.preventDefault();
        this.ngZone.run(() => {
          shortcut.action();
          this.shortcutTriggered.next(shortcut.id);
        });
        return;
      }
    }

    // Check if this could be the start of a chord
    const potentialChords = Array.from(this.shortcuts.values()).filter(
      s => s.keys.startsWith(keyCombo + ' ')
    );

    if (potentialChords.length > 0) {
      event.preventDefault();
      this.chordPrefix = keyCombo;
      this.chordTimeout = setTimeout(() => {
        this.chordPrefix = null;
      }, 1000);
      return;
    }

    // Direct shortcut match
    const shortcut = this.findShortcut(keyCombo);
    if (shortcut) {
      event.preventDefault();
      this.ngZone.run(() => {
        shortcut.action();
        this.shortcutTriggered.next(shortcut.id);
      });
    }
  }

  private findShortcut(keys: string, context?: KeyboardShortcut['context']): KeyboardShortcut | undefined {
    return Array.from(this.shortcuts.values()).find(
      shortcut => shortcut.keys === keys && (context === undefined || shortcut.context === context)
    );
  }

  private getKeyCombo(event: KeyboardEvent): string {
    const parts: string[] = [];

    if (event.ctrlKey || event.metaKey) parts.push('ctrl');
    if (event.shiftKey) parts.push('shift');
    if (event.altKey) parts.push('alt');

    const key = event.key.toLowerCase();
    if (!['control', 'shift', 'alt', 'meta'].includes(key)) {
      parts.push(key);
    }

    return parts.join('+');
  }
}
