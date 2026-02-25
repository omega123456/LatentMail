import {
  Component,
  inject,
  signal,
  computed,
  effect,
  OnDestroy,
  ViewChild,
  ElementRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiStore } from '../../store/ui.store';
import { CommandRegistryService, Command } from '../../core/services/command-registry.service';

/** Maximum number of recent commands displayed above the search results. */
const MAX_RECENT_DISPLAY = 5;
/** Maximum number of search results when filtering by query (no cap when query is empty). */
const MAX_SEARCH_RESULTS = 50;

@Component({
  selector: 'app-command-palette',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  templateUrl: './command-palette.component.html',
  styleUrl: './command-palette.component.scss',
})
export class CommandPaletteComponent implements OnDestroy {
  readonly uiStore = inject(UiStore);
  private readonly commandRegistry = inject(CommandRegistryService);

  @ViewChild('searchInput') searchInputRef!: ElementRef<HTMLInputElement>;

  readonly searchQuery = signal('');
  readonly focusedIndex = signal(0);

  private focusTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Reset state and auto-focus search input each time the palette opens.
    effect(() => {
      const isOpen = this.uiStore.commandPaletteOpen();
      if (isOpen) {
        this.searchQuery.set('');
        this.focusedIndex.set(0);
        // Defer by one frame so the DOM element is rendered.
        this.focusTimer = setTimeout(() => {
          // Guard: do not focus if the palette was closed before the timer fired.
          if (this.uiStore.commandPaletteOpen()) {
            this.searchInputRef?.nativeElement.focus();
          }
        }, 0);
      }
    });
  }

  ngOnDestroy(): void {
    if (this.focusTimer !== null) {
      clearTimeout(this.focusTimer);
    }
  }

  // -------------------------------------------------------------------------
  // Computed state
  // -------------------------------------------------------------------------

  /** Commands to show as recent (last 5 executed, resolved from registry). */
  readonly recentCommands = computed<Command[]>(() => {
    const ids = this.uiStore.recentCommandIds();
    return ids
      .map(id => this.commandRegistry.getCommand(id))
      .filter((cmd): cmd is Command => cmd !== undefined)
      .slice(0, MAX_RECENT_DISPLAY);
  });

  /**
   * All commands filtered by the current search query. Full list is always
   * rendered so the user can cycle through everything with arrow keys or
   * mouse scroll; the results container has a fixed max-height so only a
   * few rows are visible at once.
   */
  readonly filteredCommands = computed<Command[]>(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const all = this.commandRegistry.getAllCommands();
    if (!query) {
      const recentIds = new Set(this.recentCommands().map(cmd => cmd.id));
      return recentIds.size > 0
        ? all.filter(cmd => !recentIds.has(cmd.id))
        : all;
    }
    return all
      .filter(cmd =>
        this.fuzzyMatch(query, cmd.label) || this.fuzzyMatch(query, cmd.description ?? '')
      )
      .slice(0, MAX_SEARCH_RESULTS);
  });

  /** Show the "Recent" section only when the query is empty and there are recents. */
  readonly showRecentSection = computed<boolean>(
    () => this.searchQuery().trim() === '' && this.recentCommands().length > 0
  );

  /** Total number of focusable items in the current view. */
  readonly totalItems = computed<number>(() => {
    if (this.showRecentSection()) {
      return this.recentCommands().length + this.filteredCommands().length;
    }
    return this.filteredCommands().length;
  });

  /**
   * The DOM `id` of the currently focused item, used for `aria-activedescendant`
   * on the search input so screen readers announce the focused option.
   */
  readonly activeItemId = computed<string | null>(() => {
    const index = this.focusedIndex();
    const total = this.totalItems();
    if (total === 0) {
      return null;
    }
    return `palette-item-${index}`;
  });

  // -------------------------------------------------------------------------
  // Keyboard handling (bound on the search input only to avoid double-handling)
  // -------------------------------------------------------------------------

  onKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const total = Math.max(1, this.totalItems());
        this.focusedIndex.set((this.focusedIndex() + 1) % total);
        this.scrollFocusedIntoView();
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const total = Math.max(1, this.totalItems());
        this.focusedIndex.set((this.focusedIndex() - 1 + total) % total);
        this.scrollFocusedIntoView();
        break;
      }
      case 'Enter': {
        event.preventDefault();
        this.executeFocused();
        break;
      }
      case 'Escape': {
        event.preventDefault();
        this.close();
        break;
      }
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  onSearchInput(value: string): void {
    this.searchQuery.set(value);
    this.focusedIndex.set(0);
  }

  executeCommand(command: Command): void {
    this.close();
    // Defer by one tick so the palette DOM is gone before the action runs
    // (avoids focus conflicts when an action opens another overlay).
    setTimeout(() => {
      this.commandRegistry.executeCommand(command.id);
    }, 0);
  }

  closeOnBackdrop(event: MouseEvent): void {
    // Only close when clicking directly on the backdrop element, not children.
    if (event.target === event.currentTarget) {
      this.close();
    }
  }

  close(): void {
    this.uiStore.closeCommandPalette();
  }

  // -------------------------------------------------------------------------
  // Focus tracking helpers used by the template
  // -------------------------------------------------------------------------

  isRecentFocused(index: number): boolean {
    return this.focusedIndex() === index;
  }

  isFilteredFocused(index: number): boolean {
    const offset = this.showRecentSection() ? this.recentCommands().length : 0;
    return this.focusedIndex() === offset + index;
  }

  // -------------------------------------------------------------------------
  // Display helpers
  // -------------------------------------------------------------------------

  /** Returns the display string for the primary (first) effective keybinding. */
  formatCommandKeys(command: Command): string {
    const effectiveKeys = this.commandRegistry.getEffectiveKeys(command.id);
    if (!effectiveKeys.length) {
      return '';
    }
    return this.commandRegistry.formatKeyCombo(effectiveKeys[0]);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Scroll the list so the focused item is visible; minimal scroll only when needed. */
  private scrollFocusedIntoView(): void {
    setTimeout(() => {
      const id = this.activeItemId();
      const listbox = document.getElementById('palette-listbox');
      const item = id ? document.getElementById(id) : null;
      if (!listbox || !item) {
        return;
      }
      const listboxRect = listbox.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      if (itemRect.top < listboxRect.top) {
        listbox.scrollTop += itemRect.top - listboxRect.top;
      } else if (itemRect.bottom > listboxRect.bottom) {
        listbox.scrollTop += itemRect.bottom - listboxRect.bottom;
      }
    }, 0);
  }

  private executeFocused(): void {
    const index = this.focusedIndex();
    if (this.showRecentSection()) {
      const recentLen = this.recentCommands().length;
      if (index < recentLen) {
        this.executeCommand(this.recentCommands()[index]);
        return;
      }
      const filteredIndex = index - recentLen;
      const cmd = this.filteredCommands()[filteredIndex];
      if (cmd) {
        this.executeCommand(cmd);
      }
    } else {
      const cmd = this.filteredCommands()[index];
      if (cmd) {
        this.executeCommand(cmd);
      }
    }
  }

  /**
   * Fuzzy match: returns true if all characters of `query` appear in order
   * within `target` (case-insensitive).
   * A direct `includes` match also returns true.
   */
  private fuzzyMatch(query: string, target: string): boolean {
    const targetLower = target.toLowerCase();
    if (targetLower.includes(query)) {
      return true;
    }
    let queryIndex = 0;
    for (let targetIndex = 0; targetIndex < targetLower.length; targetIndex++) {
      if (targetLower[targetIndex] === query[queryIndex]) {
        queryIndex++;
        if (queryIndex === query.length) {
          return true;
        }
      }
    }
    return false;
  }
}
