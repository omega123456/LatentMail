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
import { DEFAULT_LABEL_COLOR } from '../../constants/label-colors';

@Component({
  selector: 'app-labels-menu',
  standalone: true,
  imports: [CommonModule, FormsModule, OverlayModule],
  templateUrl: './labels-menu.component.html',
  styleUrl: './labels-menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LabelsMenuComponent implements OnDestroy {
  private readonly elRef = inject(ElementRef);
  private readonly overlay = inject(Overlay);
  private readonly viewContainerRef = inject(ViewContainerRef);

  private readonly triggerRef = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly dropdownPanelRef = viewChild<TemplateRef<unknown>>('dropdownPanel');

  private overlayRef: OverlayRef | null = null;

  /** The full folder list — filtered internally to user labels only. */
  readonly folders = input.required<Folder[]>();
  /** Current folder IDs the selected thread belongs to — used to pre-check labels. */
  readonly currentFolderIds = input<string[]>([]);

  /** Emits the gmailLabelId of a label that was checked. */
  readonly labelAdded = output<string>();
  /** Emits the gmailLabelId of a label that was unchecked. */
  readonly labelRemoved = output<string>();

  readonly isOpen = signal(false);
  readonly searchText = signal('');
  readonly focusedIndex = signal(-1);

  readonly defaultColor = DEFAULT_LABEL_COLOR;

  /** User labels only, sorted by name. */
  readonly userLabels = computed(() =>
    this.folders()
      .filter(folder => folder.type === 'user')
      .sort((labelA, labelB) => labelA.name.localeCompare(labelB.name))
  );

  /** Filtered user labels matching the search text. */
  readonly filteredLabels = computed(() => {
    const search = this.searchText().toLowerCase();
    if (!search) {
      return this.userLabels();
    }
    return this.userLabels().filter(label =>
      label.name.toLowerCase().includes(search)
    );
  });

  /** Whether the search input is shown (threshold: ≥10 user labels). */
  readonly showSearch = computed(() => this.userLabels().length >= 10);

  /** Whether a label is currently applied to the selected thread. */
  isLabelChecked(gmailLabelId: string): boolean {
    return this.currentFolderIds().includes(gmailLabelId);
  }

  getLabelColor(label: Folder): string {
    return label.color || DEFAULT_LABEL_COLOR;
  }

  toggle(): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

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

    const config = new OverlayConfig({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      hasBackdrop: false,
    });

    this.overlayRef = this.overlay.create(config);
    this.overlayRef.attach(
      new TemplatePortal(panelTpl, this.viewContainerRef)
    );

    setTimeout(() => {
      if (!this.overlayRef?.overlayElement) {
        return;
      }
      const searchInput = this.overlayRef.overlayElement.querySelector<HTMLInputElement>(
        '.labels-search-input'
      );
      if (searchInput) {
        searchInput.focus();
      } else {
        const dropdown = this.overlayRef.overlayElement.querySelector<HTMLElement>(
          '.labels-dropdown'
        );
        if (dropdown) {
          dropdown.focus();
        }
      }
    }, 0);
  }

  close(): void {
    if (this.isOpen()) {
      this.disposeOverlay();
      this.isOpen.set(false);
      this.searchText.set('');
      this.focusedIndex.set(-1);
    }
  }

  private disposeOverlay(): void {
    if (this.overlayRef) {
      this.overlayRef.detach();
      this.overlayRef.dispose();
      this.overlayRef = null;
    }
  }

  toggleLabel(label: Folder): void {
    if (this.isLabelChecked(label.gmailLabelId)) {
      this.labelRemoved.emit(label.gmailLabelId);
    } else {
      this.labelAdded.emit(label.gmailLabelId);
    }
  }

  onMenuKeydown(event: KeyboardEvent): void {
    const items = this.filteredLabels();
    const current = this.focusedIndex();
    const isSearchInput = (event.target as HTMLElement)?.classList?.contains('labels-search-input');

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
      case ' ':
        if (isSearchInput && event.key === ' ') {
          return;
        }
        event.preventDefault();
        if (current >= 0 && current < items.length) {
          this.toggleLabel(items[current]);
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as Node;
    const inTrigger = this.elRef.nativeElement.contains(target);
    const inOverlay = this.overlayRef?.overlayElement?.contains(target);
    if (this.isOpen() && !inTrigger && !inOverlay) {
      this.close();
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.isOpen()) {
      this.close();
    }
  }

  ngOnDestroy(): void {
    this.disposeOverlay();
  }
}
