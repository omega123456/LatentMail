import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  signal,
  computed,
  ElementRef,
  inject,
  OnDestroy,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Folder } from '../../../core/models/account.model';

/** Folder IDs excluded from the Move To menu */
const EXCLUDED_FOLDER_IDS = [
  '[Gmail]/All Mail',
  '[Gmail]/Sent Mail',
  '[Gmail]/Important',
];

/** System folder display order */
const SYSTEM_FOLDER_ORDER: Record<string, number> = {
  'INBOX': 0,
  '[Gmail]/Starred': 1,
  '[Gmail]/Drafts': 2,
  '[Gmail]/Spam': 3,
  '[Gmail]/Trash': 4,
};

/** Map Gmail special-use paths to icons */
const FOLDER_ICON_MAP: Record<string, string> = {
  'INBOX': 'inbox',
  '[Gmail]/Sent Mail': 'send',
  '[Gmail]/Drafts': 'edit_note',
  '[Gmail]/Trash': 'delete',
  '[Gmail]/Spam': 'report',
  '[Gmail]/Starred': 'star',
  '[Gmail]/Important': 'label_important',
};

@Component({
  selector: 'app-move-to-menu',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './move-to-menu.component.html',
  styleUrl: './move-to-menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MoveToMenuComponent implements OnDestroy {
  private readonly elRef = inject(ElementRef);

  /** The full list of folders. */
  readonly folders = input.required<Folder[]>();
  /** The currently active folder ID (to exclude from the list). */
  readonly activeFolderId = input<string | null>(null);

  /** Emits the gmailLabelId of the selected destination folder. */
  readonly folderSelected = output<string>();
  /** Emits when the menu closes. */
  readonly menuClosed = output<void>();

  /** Whether the dropdown is open. */
  readonly isOpen = signal(false);
  /** Current search/filter text. */
  readonly searchText = signal('');
  /** Index of the currently focused item for keyboard navigation (-1 = none). */
  readonly focusedIndex = signal(-1);

  /** Filtered system folders (excluding active, excluded IDs, and filter-label type). */
  readonly filteredSystemFolders = computed(() => {
    const active = this.activeFolderId();
    const search = this.searchText().toLowerCase();
    return this.folders()
      .filter(f =>
        f.type === 'system' &&
        !EXCLUDED_FOLDER_IDS.includes(f.gmailLabelId) &&
        f.gmailLabelId !== active &&
        (search === '' || f.name.toLowerCase().includes(search))
      )
      .sort((a, b) => {
        const orderA = SYSTEM_FOLDER_ORDER[a.gmailLabelId] ?? Number.MAX_SAFE_INTEGER;
        const orderB = SYSTEM_FOLDER_ORDER[b.gmailLabelId] ?? Number.MAX_SAFE_INTEGER;
        return orderA - orderB;
      });
  });

  /** Filtered user label folders (excluding active and filter-label type). */
  readonly filteredUserLabels = computed(() => {
    const active = this.activeFolderId();
    const search = this.searchText().toLowerCase();
    return this.folders()
      .filter(f =>
        f.type === 'user' &&
        f.gmailLabelId !== active &&
        (search === '' || f.name.toLowerCase().includes(search))
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  /** All visible items in a flat list (for keyboard navigation). */
  readonly flatItems = computed(() => {
    return [...this.filteredSystemFolders(), ...this.filteredUserLabels()];
  });

  /** Total visible folder count (to determine if search input is shown). */
  readonly totalVisible = computed(() => {
    // Count total eligible folders BEFORE search filtering (just excluding active + excluded IDs + filter-label)
    const active = this.activeFolderId();
    return this.folders().filter(f =>
      f.type !== 'filter-label' &&
      !EXCLUDED_FOLDER_IDS.includes(f.gmailLabelId) &&
      f.gmailLabelId !== active
    ).length;
  });

  /** Whether to show the search input. */
  readonly showSearch = computed(() => this.totalVisible() >= 10);

  /** Get the icon for a folder. */
  getFolderIcon(folder: Folder): string {
    return folder.icon || FOLDER_ICON_MAP[folder.gmailLabelId] || 'folder';
  }

  /** Toggle the dropdown open/close. */
  toggle(): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  /** Open the dropdown and focus the search input or dropdown container. */
  open(): void {
    this.isOpen.set(true);
    this.searchText.set('');
    this.focusedIndex.set(-1);

    // Focus search input or dropdown container after Angular renders it
    setTimeout(() => {
      const el: HTMLElement = this.elRef.nativeElement;
      const searchInput = el.querySelector<HTMLInputElement>('.search-input');
      if (searchInput) {
        searchInput.focus();
      } else {
        const dropdown = el.querySelector<HTMLElement>('.move-to-dropdown');
        if (dropdown) {
          dropdown.focus();
        }
      }
    }, 0);
  }

  /** Close the dropdown. */
  close(): void {
    if (this.isOpen()) {
      this.isOpen.set(false);
      this.searchText.set('');
      this.focusedIndex.set(-1);
      this.menuClosed.emit();
    }
  }

  /** Select a folder. */
  selectFolder(folder: Folder): void {
    this.folderSelected.emit(folder.gmailLabelId);
    this.close();
  }

  /** Handle keyboard events when the menu is open. */
  onMenuKeydown(event: KeyboardEvent): void {
    const items = this.flatItems();
    const current = this.focusedIndex();
    const isSearchInput = (event.target as HTMLElement)?.classList?.contains('search-input');

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.focusedIndex.set(current < items.length - 1 ? current + 1 : 0);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.focusedIndex.set(current > 0 ? current - 1 : items.length - 1);
        break;
      case 'Enter':
        event.preventDefault();
        if (current >= 0 && current < items.length) {
          this.selectFolder(items[current]);
        }
        break;
      case ' ':
        // Allow space in search input for typing
        if (isSearchInput) {
          return;
        }
        event.preventDefault();
        if (current >= 0 && current < items.length) {
          this.selectFolder(items[current]);
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
    }
  }

  /** Handle click outside to close the dropdown. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.isOpen() && !this.elRef.nativeElement.contains(event.target)) {
      this.close();
    }
  }

  /** Handle Escape key globally when open. */
  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.isOpen()) {
      this.close();
    }
  }

  ngOnDestroy(): void {
    // Ensure menu is closed on destroy
    if (this.isOpen()) {
      this.close();
    }
  }
}
