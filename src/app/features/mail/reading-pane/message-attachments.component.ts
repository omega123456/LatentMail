import { Component, input, inject, computed, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { Email, Attachment } from '../../../core/models/email.model';
import { ElectronService } from '../../../core/services/electron.service';
import { ToastService } from '../../../core/services/toast.service';
import { FileSizePipe } from '../../../shared/pipes/file-size.pipe';
import { getMimeIcon, isImageMime } from '../../../shared/utils/mime-icon.util';
import {
  AttachmentPreviewDialogComponent,
  AttachmentPreviewDialogData,
} from '../../../shared/components/attachment-preview-dialog/attachment-preview-dialog.component';

@Component({
  selector: 'app-message-attachments',
  standalone: true,
  imports: [CommonModule, FileSizePipe, MatDialogModule],
  templateUrl: './message-attachments.component.html',
  styleUrl: './message-attachments.component.scss',
})
export class MessageAttachmentsComponent {
  readonly message = input.required<Email>();

  private readonly electronService = inject(ElectronService);
  private readonly toastService = inject(ToastService);
  private readonly dialog = inject(MatDialog);

  /** Set of attachment IDs currently being downloaded. */
  readonly downloadingIds = signal<Set<number>>(new Set());

  /** Thumbnail object URLs for image attachments (keyed by attachment id). */
  readonly thumbnailUrls = signal<Map<number, string>>(new Map());

  /** Set of attachment IDs currently loading thumbnails. */
  readonly loadingThumbnailIds = signal<Set<number>>(new Set());

  /** Attachment list resolved from the message signal. */
  readonly attachments = computed<Attachment[]>(() => {
    return this.message().attachments ?? [];
  });

  /** Whether there are any attachments to display. */
  readonly hasAttachments = computed<boolean>(() => this.attachments().length > 0);

  constructor() {
    effect(() => {
      const attachments = this.attachments();
      for (const att of attachments) {
        if (isImageMime(att.mimeType)) {
          const urls = this.thumbnailUrls();
          const loading = this.loadingThumbnailIds();
          if (!urls.has(att.id) && !loading.has(att.id)) {
            this.loadThumbnail(att);
          }
        }
      }
    });
  }

  getMimeIcon(mimeType: string | null | undefined): string {
    return getMimeIcon(mimeType);
  }

  isImageAttachment(attachment: Attachment): boolean {
    return isImageMime(attachment.mimeType);
  }

  getThumbnailUrl(attachment: Attachment): string | null {
    return this.thumbnailUrls().get(attachment.id) ?? null;
  }

  isThumbnailLoading(attachmentId: number): boolean {
    return this.loadingThumbnailIds().has(attachmentId);
  }

  private loadThumbnail(attachment: Attachment): void {
    this.loadingThumbnailIds.update((set) => {
      const next = new Set(set);
      next.add(attachment.id);
      return next;
    });

    this.electronService
      .getAttachmentContent(attachment.id)
      .then((response) => {
        if (!response.success || !response.data?.content) {
          return;
        }
        const binary = atob(response.data.content);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
          bytes[index] = binary.charCodeAt(index);
        }
        const blob = new Blob([bytes], { type: response.data.mimeType ?? 'image/*' });
        const url = URL.createObjectURL(blob);
        this.thumbnailUrls.update((map) => {
          const next = new Map(map);
          next.set(attachment.id, url);
          return next;
        });
      })
      .finally(() => {
        this.loadingThumbnailIds.update((set) => {
          const next = new Set(set);
          next.delete(attachment.id);
          return next;
        });
      });
  }

  ngOnDestroy(): void {
    const urls = this.thumbnailUrls();
    for (const url of urls.values()) {
      URL.revokeObjectURL(url);
    }
  }

  isDownloading(attachmentId: number): boolean {
    return this.downloadingIds().has(attachmentId);
  }

  openPreview(attachment: Attachment): void {
    const data: AttachmentPreviewDialogData = {
      attachmentId: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
    };
    this.dialog.open(AttachmentPreviewDialogComponent, {
      data,
      width: 'auto',
      maxWidth: '90vw',
      height: 'auto',
      maxHeight: '90vh',
      panelClass: 'attachment-preview-dialog',
      autoFocus: 'first-tabbable',
    });
  }

  async downloadAttachment(attachment: Attachment): Promise<void> {
    if (this.isDownloading(attachment.id)) {
      return;
    }

    // Mark as downloading
    this.downloadingIds.update(set => {
      const next = new Set(set);
      next.add(attachment.id);
      return next;
    });

    try {
      const response = await this.electronService.downloadAttachment(attachment.id);
      if (!response.success) {
        this.toastService.error(
          response.error?.message ?? `Failed to download ${attachment.filename}`
        );
      }
    } catch {
      this.toastService.error(`Failed to download ${attachment.filename}`);
    } finally {
      // Always clear the loading state regardless of outcome
      this.downloadingIds.update(set => {
        const next = new Set(set);
        next.delete(attachment.id);
        return next;
      });
    }
  }
}
