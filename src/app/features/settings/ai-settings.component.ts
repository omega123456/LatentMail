import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AiStore } from '../../store/ai.store';

@Component({
  selector: 'app-ai-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ai-settings.component.html',
  styleUrl: './ai-settings.component.scss',
})
export class AiSettingsComponent implements OnInit {
  readonly aiStore = inject(AiStore);
  readonly urlInput = signal('');
  readonly testingConnection = signal(false);
  /** Tracks whether the user has confirmed a model switch warning for a pending model */
  readonly pendingEmbeddingModel = signal<string | null>(null);
  /** True when the rebuild-all-index confirmation is shown (user clicked Rebuild all index but not yet confirmed) */
  readonly showRebuildAllConfirmation = signal(false);

  /**
   * True when the progress total is known (during an active build).
   * False outside of a build — in that case the indexed count is shown without a denominator.
   * Relies on the convention that `total === 0` signals "no total available" from the backend.
   */
  readonly isTotalKnown = computed(() => {
    const progress = this.aiStore.indexProgress();
    return progress !== null && progress.total > 0;
  });

  ngOnInit(): void {
    this.urlInput.set(this.aiStore.url());
    this.aiStore.checkStatus();
    this.aiStore.loadModels();
    this.aiStore.loadEmbeddingModels();
    this.aiStore.loadEmbeddingStatus();
  }

  async saveUrl(): Promise<void> {
    const url = this.urlInput().trim();
    if (!url) {
      return;
    }
    this.testingConnection.set(true);
    await this.aiStore.setUrl(url);
    await this.aiStore.loadModels();
    await this.aiStore.loadEmbeddingModels();
    this.testingConnection.set(false);
  }

  async testConnection(): Promise<void> {
    this.testingConnection.set(true);
    await this.aiStore.checkStatus();
    await this.aiStore.loadModels();
    await this.aiStore.loadEmbeddingModels();
    this.testingConnection.set(false);
  }

  async selectModel(modelName: string): Promise<void> {
    await this.aiStore.setModel(modelName);
  }

  /**
   * Called when the user clicks an embedding model card.
   * If an index already exists or is building, show a warning before switching.
   * Otherwise, select immediately.
   */
  async selectEmbeddingModel(modelName: string): Promise<void> {
    // No-op if the same model is already selected
    if (modelName === this.aiStore.embeddingModel()) {
      return;
    }
    // If an index exists or is currently building, require confirmation
    const currentStatus = this.aiStore.indexStatus();
    if (currentStatus === 'complete' || currentStatus === 'partial' || currentStatus === 'building') {
      this.pendingEmbeddingModel.set(modelName);
      return;
    }
    await this.aiStore.setEmbeddingModel(modelName);
  }

  /** User confirmed the model switch warning — proceed with the change */
  async confirmEmbeddingModelSwitch(): Promise<void> {
    const pendingModel = this.pendingEmbeddingModel();
    if (!pendingModel) {
      return;
    }
    this.pendingEmbeddingModel.set(null);
    await this.aiStore.setEmbeddingModel(pendingModel);
  }

  /** User dismissed the model switch warning — discard the pending model */
  cancelEmbeddingModelSwitch(): void {
    this.pendingEmbeddingModel.set(null);
  }

  /** Start indexing only emails not yet in the index (no confirmation). */
  checkForNewEmailsToIndex(): void {
    this.aiStore.buildIndex();
  }

  /** Show inline confirmation for rebuild-all, then wipe index and reindex on confirm. */
  requestRebuildAllIndex(): void {
    this.showRebuildAllConfirmation.set(true);
  }

  /** User confirmed rebuild-all — wipe index and start full reindex. */
  confirmRebuildAllIndex(): void {
    this.showRebuildAllConfirmation.set(false);
    this.aiStore.rebuildAllIndex();
  }

  /** User cancelled the rebuild-all confirmation. */
  cancelRebuildAllIndex(): void {
    this.showRebuildAllConfirmation.set(false);
  }

  async cancelBuild(): Promise<void> {
    await this.aiStore.cancelIndex();
  }

  formatSize(bytes?: number): string {
    if (!bytes) {
      return '';
    }
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) {
      return `${gb.toFixed(1)} GB`;
    }
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
  }

  /** Returns the display label for the current index status */
  get indexStatusLabel(): string {
    switch (this.aiStore.indexStatus()) {
      case 'not_started': return 'Not started';
      case 'building': return 'Building...';
      case 'complete': return 'Complete';
      case 'partial': return 'Partial';
      case 'unavailable': return 'Unavailable';
      default: return 'Unknown';
    }
  }

  /** Returns the Material icon name for the current index status */
  get indexStatusIcon(): string {
    switch (this.aiStore.indexStatus()) {
      case 'not_started': return 'radio_button_unchecked';
      case 'building': return 'sync';
      case 'complete': return 'check_circle';
      case 'partial': return 'pending';
      case 'unavailable': return 'error_outline';
      default: return 'radio_button_unchecked';
    }
  }
}

