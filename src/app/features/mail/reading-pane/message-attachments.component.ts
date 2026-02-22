import { Component, input, inject, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Email, Attachment } from '../../../core/models/email.model';
import { ElectronService } from '../../../core/services/electron.service';
import { ToastService } from '../../../core/services/toast.service';
import { FileSizePipe } from '../../../shared/pipes/file-size.pipe';
import { getMimeIcon } from '../../../shared/utils/mime-icon.util';

@Component({
  selector: 'app-message-attachments',
  standalone: true,
  imports: [CommonModule, FileSizePipe],
  templateUrl: './message-attachments.component.html',
  styleUrl: './message-attachments.component.scss',
})
export class MessageAttachmentsComponent {
  readonly message = input.required<Email>();

  private readonly electronService = inject(ElectronService);
  private readonly toastService = inject(ToastService);

  /** Set of attachment IDs currently being downloaded. */
  readonly downloadingIds = signal<Set<number>>(new Set());

  /** Attachment list resolved from the message signal. */
  readonly attachments = computed<Attachment[]>(() => {
    return this.message().attachments ?? [];
  });

  /** Whether there are any attachments to display. */
  readonly hasAttachments = computed<boolean>(() => this.attachments().length > 0);

  getMimeIcon(mimeType: string | null | undefined): string {
    return getMimeIcon(mimeType);
  }

  isDownloading(attachmentId: number): boolean {
    return this.downloadingIds().has(attachmentId);
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
