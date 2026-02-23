import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  signal,
  computed,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  HostListener,
  viewChild,
  ViewContainerRef,
  TemplateRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Overlay, OverlayConfig, OverlayModule } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
import type { OverlayRef } from '@angular/cdk/overlay';
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
  imports: [CommonModule, FormsModule, OverlayModule],
  templateUrl: './move-to-menu.component.html',
  styleUrl: './move-to-menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MoveToMenuComponent implements OnDestroy {
  private readonly elRef = inject(ElementRef);
  private readonly overlay = inject(Overlay);
  private readonly viewContainerRef = inject(ViewContainerRef);

  /** Trigger button element for overlay origin. */
  private readonly triggerRef = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  /** Panel content rendered in overlay. */
  private readonly dropdownPanelRef = viewChild<TemplateRef<unknown>>('dropdownPanel');

  private overlayRef: OverlayRef | null = null;

  /** The full list of folders. */
  readonly folders = input.required<Folder[]>();
  /** The currently active folder ID (to exclude from the list). */
  readonly activeFolderId = input<string | null>(null);
  /** When set by the parent, close this menu if another menu is the open one. */
  readonly openMenuId = input<string | null>(null);

  /** Emits the gmailLabelId of the selected destination folder. */
  readonly folderSelected = output<string>();
  /** Emits when the menu closes. */
  readonly menuClosed = output<void>();
  /** Emits when the menu opens (so parent can close other menus). */
  readonly menuOpened = output<void>();

  /** Whether the dropdown is open. */
  readonly isOpen = signal(false);
  /** Current search/filter text. */
  readonly searchText = signal('');
  /** Index of the currently focused item for keyboard navigation (-1 = none). */
  readonly focusedIndex = signal(-1);

  /** Filtered system folders (excluding active and excluded IDs). */
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

  /** All visible items in a flat list (for keyboard navigation — system folders only). */
  readonly flatItems = computed(() => {
    return [...this.filteredSystemFolders()];
  });

  /** Total visible folder count (system folders only, to determine if search input is shown). */
  readonly totalVisible = computed(() => {
    const active = this.activeFolderId();
    return this.folders().filter(f =>
      f.type === 'system' &&
      !EXCLUDED_FOLDER_IDS.includes(f.gmailLabelId) &&
      f.gmailLabelId !== active
    ).length;
  });

  /** Whether to show the search input. */
  readonly showSearch = computed(() => this.totalVisible() >= 10);

  /** Close this menu when the parent reports another menu is open. */
  private readonly closeWhenOtherMenuOpens = effect(() => {
    const current = this.openMenuId();
    if (current !== null && current !== 'move-to' && this.isOpen()) {
      this.close();
    }
  });

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

  /** Open the dropdown in an overlay and focus the search input or panel. */
  open(): void {
    const triggerEl = this.triggerRef()?.nativeElement;
    const panelTpl = this.dropdownPanelRef();
    if (!triggerEl || !panelTpl) {
      setTimeout(() => this.open(), 0);
      return;
    }

    this.disposeOverlay();
    this.isOpen.set(true);
    this.searchText.set('');
    this.focusedIndex.set(-1);

    const positionStrategy = this.overlay
      .position()
      .flexibleConnectedTo(triggerEl)
      .withPositions([
        { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top' },
        { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom' },
      ])
      .withDefaultOffsetY(4);
    const scrollStrategy = this.overlay.scrollStrategies.reposition();
    const config = new OverlayConfig({
      positionStrategy,
      scrollStrategy,
      hasBackdrop: false,
    });

    this.overlayRef = this.overlay.create(config);
    this.overlayRef.attach(
      new TemplatePortal(panelTpl, this.viewContainerRef)
    );
    this.menuOpened.emit();

    setTimeout(() => {
      if (!this.overlayRef?.overlayElement) {
        return;
      }
      const searchInput = this.overlayRef.overlayElement.querySelector<HTMLInputElement>(
        '.search-input'
      );
      if (searchInput) {
        searchInput.focus();
      } else {
        const dropdown = this.overlayRef.overlayElement.querySelector<HTMLElement>(
          '.move-to-dropdown'
        );
        if (dropdown) {
          dropdown.focus();
        }
      }
    }, 0);
  }

  private disposeOverlay(): void {
    if (this.overlayRef) {
      this.overlayRef.detach();
      this.overlayRef.dispose();
      this.overlayRef = null;
    }
  }

  /** Close the dropdown and dispose the overlay. */
  close(): void {
    if (this.isOpen()) {
      this.disposeOverlay();
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

  /** Handle click outside to close the dropdown (trigger or overlay pane). */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as Node;
    const inTrigger = this.elRef.nativeElement.contains(target);
    const inOverlay = this.overlayRef?.overlayElement?.contains(target);
    if (this.isOpen() && !inTrigger && !inOverlay) {
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
    this.disposeOverlay();
    if (this.isOpen()) {
      this.isOpen.set(false);
      this.searchText.set('');
      this.focusedIndex.set(-1);
    }
  }
}
