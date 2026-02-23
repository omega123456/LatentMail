import {
  Component,
  ChangeDetectionStrategy,
  computed,
  inject,
  input,
  output,
  signal,
  ViewContainerRef,
  TemplateRef,
  viewChild,
  OnDestroy,
  ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Overlay, OverlayConfig, OverlayModule } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
import type { OverlayRef } from '@angular/cdk/overlay';
import { FoldersStore } from '../../../store/folders.store';
import { AccountsStore } from '../../../store/accounts.store';
import { ColorPickerComponent } from '../../../shared/components/color-picker/color-picker.component';
import { DEFAULT_LABEL_COLOR } from '../../../shared/constants/label-colors';
import { Folder } from '../../../core/models/account.model';

@Component({
  selector: 'app-label-manager',
  standalone: true,
  imports: [CommonModule, FormsModule, OverlayModule, ColorPickerComponent],
  templateUrl: './label-manager.component.html',
  styleUrl: './label-manager.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LabelManagerComponent implements OnDestroy {
  readonly foldersStore = inject(FoldersStore);
  private readonly accountsStore = inject(AccountsStore);
  private readonly overlay = inject(Overlay);
  private readonly viewContainerRef = inject(ViewContainerRef);

  /** Whether the sidebar is collapsed — hides this section entirely. */
  readonly collapsed = input<boolean>(false);

  /** Emits the gmailLabelId when a label row is clicked for navigation. */
  readonly folderSelected = output<string>();

  readonly defaultLabelColor = DEFAULT_LABEL_COLOR;

  // ---- Add form state ----
  readonly showAddForm = signal(false);
  readonly newLabelName = signal('');
  readonly newLabelColor = signal<string | null>('#1976D2');
  readonly isCreating = signal(false);
  readonly createError = signal<string | null>(null);

  // ---- Delete confirmation state ----
  /** gmailLabelId of the label pending delete confirmation, or null. */
  readonly pendingDeleteLabelId = signal<string | null>(null);
  readonly isDeleting = signal(false);

  // ---- Color edit popover state ----
  private colorEditOverlayRef: OverlayRef | null = null;
  /** gmailLabelId of the label whose color is being edited. */
  readonly editingColorLabelId = signal<string | null>(null);
  /** The label currently being color-edited (computed from editingColorLabelId). */
  readonly editingLabel = computed(() => {
    const editingId = this.editingColorLabelId();
    if (!editingId) {
      return null;
    }
    return this.foldersStore.userLabels().find((label) => label.gmailLabelId === editingId) ?? null;
  });
  /** Pending color in the color-edit popover (updated on every change; applied on Apply or backdrop click). */
  readonly pendingColor = signal<string | null>(null);

  private readonly colorPopoverRef = viewChild<TemplateRef<unknown>>('colorPopover');

  // ---- Add form methods ----

  openAddForm(): void {
    this.showAddForm.set(true);
    this.newLabelName.set('');
    this.newLabelColor.set('#1976D2');
    this.createError.set(null);
  }

  cancelAddForm(): void {
    this.showAddForm.set(false);
    this.newLabelName.set('');
    this.newLabelColor.set('#1976D2');
    this.createError.set(null);
  }

  onNewLabelNameInput(event: Event): void {
    this.newLabelName.set((event.target as HTMLInputElement).value);
  }

  onNewLabelColorCommitted(color: string | null): void {
    this.newLabelColor.set(color);
  }

  async createLabel(): Promise<void> {
    const name = this.newLabelName().trim();
    if (!name) {
      this.createError.set('Label name is required');
      return;
    }
    const account = this.accountsStore.activeAccount();
    if (!account) {
      return;
    }
    this.isCreating.set(true);
    this.createError.set(null);
    try {
      await this.foldersStore.createLabel(account.id, name, this.newLabelColor());
      this.showAddForm.set(false);
      this.newLabelName.set('');
      this.newLabelColor.set('#1976D2');
    } catch (err) {
      this.createError.set(err instanceof Error ? err.message : 'Failed to create label');
    } finally {
      this.isCreating.set(false);
    }
  }

  // ---- Delete methods ----

  showDeleteConfirm(event: Event, gmailLabelId: string): void {
    event.stopPropagation();
    this.pendingDeleteLabelId.set(gmailLabelId);
  }

  cancelDelete(): void {
    this.pendingDeleteLabelId.set(null);
  }

  async confirmDelete(gmailLabelId: string): Promise<void> {
    const account = this.accountsStore.activeAccount();
    if (!account) {
      return;
    }
    this.isDeleting.set(true);
    try {
      await this.foldersStore.deleteLabel(account.id, gmailLabelId);
      this.pendingDeleteLabelId.set(null);
    } catch (err) {
      // On error, keep the confirmation visible briefly then dismiss
      setTimeout(() => this.pendingDeleteLabelId.set(null), 2000);
    } finally {
      this.isDeleting.set(false);
    }
  }

  // ---- Color edit popover ----

  openColorEdit(event: Event, label: Folder): void {
    event.stopPropagation();
    const trigger = event.currentTarget as HTMLElement;
    const popoverTpl = this.colorPopoverRef();
    if (!popoverTpl) {
      return;
    }

    this.disposeColorOverlay();
    this.editingColorLabelId.set(label.gmailLabelId);
    this.pendingColor.set(label.color ?? null);

    const positionStrategy = this.overlay
      .position()
      .flexibleConnectedTo(trigger)
      .withPositions([
        { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top' },
        { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom' },
      ])
      .withDefaultOffsetY(4);

    const config = new OverlayConfig({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      hasBackdrop: true,
      backdropClass: 'cdk-overlay-transparent-backdrop',
    });

    this.colorEditOverlayRef = this.overlay.create(config);
    this.colorEditOverlayRef.attach(
      new TemplatePortal(popoverTpl, this.viewContainerRef)
    );

    // Apply and close on backdrop click
    this.colorEditOverlayRef.backdropClick().subscribe(() => {
      this.applyColorEditAndClose();
    });
  }

  /** Apply pending color to the label being edited and close the popover. */
  applyColorEditAndClose(): void {
    const labelId = this.editingColorLabelId();
    if (labelId !== null) {
      this.onColorEditCommitted(this.pendingColor(), labelId);
    } else {
      this.disposeColorOverlay();
    }
  }

  async onColorEditCommitted(color: string | null, gmailLabelId: string): Promise<void> {
    const account = this.accountsStore.activeAccount();
    if (!account) {
      this.disposeColorOverlay();
      return;
    }
    await this.foldersStore.updateLabelColor(account.id, gmailLabelId, color);
    this.disposeColorOverlay();
  }

  private disposeColorOverlay(): void {
    if (this.colorEditOverlayRef) {
      this.colorEditOverlayRef.detach();
      this.colorEditOverlayRef.dispose();
      this.colorEditOverlayRef = null;
    }
    this.editingColorLabelId.set(null);
  }

  getLabelColor(label: Folder): string {
    return label.color || DEFAULT_LABEL_COLOR;
  }

  onLabelClick(gmailLabelId: string): void {
    if (this.foldersStore.searchActive()) {
      this.foldersStore.deactivateSearch();
    }
    this.foldersStore.setActiveFolder(gmailLabelId);
    this.folderSelected.emit(gmailLabelId);
  }

  ngOnDestroy(): void {
    this.disposeColorOverlay();
  }
}
