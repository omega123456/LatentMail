import { Component, input, output, signal, viewChild, ElementRef, effect, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DraftAttachment } from '../../core/models/email.model';
import { FileSizePipe } from '../../shared/pipes/file-size.pipe';
import { getMimeIcon, isImageMime } from '../../shared/utils/mime-icon.util';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-attachment-upload',
  standalone: true,
  imports: [CommonModule, FileSizePipe],
  templateUrl: './attachment-upload.component.html',
  styleUrl: './attachment-upload.component.scss',
})
export class AttachmentUploadComponent {
  readonly attachments = input<DraftAttachment[]>([]);
  readonly add = output<DraftAttachment>();
  readonly remove = output<number>();

  private readonly toastService = inject(ToastService);

  /** Reference to the hidden file input element. */
  private readonly fileInputRef = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  /**
   * Map from DraftAttachment.id → data-URL for image preview thumbnails.
   * Only populated for attachments added in the current session.
   */
  readonly previews = signal<Map<string, string>>(new Map());

  constructor() {
    // Keep previews in sync with the attachments input.
    // When the parent removes all attachments (e.g. discard draft), clean up preview data.
    effect(() => {
      const current = this.attachments();
      const currentIds = new Set(current.map(a => a.id).filter((id): id is string => !!id));
      this.previews.update(map => {
        const next = new Map(map);
        for (const key of next.keys()) {
          if (!currentIds.has(key)) {
            next.delete(key);
          }
        }
        return next;
      });
    });
  }

  getMimeIcon(mimeType: string | null | undefined): string {
    return getMimeIcon(mimeType);
  }

  isImageMime(mimeType: string | null | undefined): boolean {
    return isImageMime(mimeType);
  }

  /**
   * Get an image preview URL for an attachment.
   * Checks the session previews map first, then falls back to constructing a data URL
   * from the attachment's base64 data (e.g. for restored draft attachments).
   */
  getPreview(att: DraftAttachment): string | null {
    if (att.id) {
      const cached = this.previews().get(att.id);
      if (cached) {
        return cached;
      }
    }
    // Construct data URL from base64 content for restored draft attachments
    if (att.data && att.mimeType) {
      return `data:${att.mimeType};base64,${att.data}`;
    }
    return null;
  }

  openFilePicker(): void {
    this.fileInputRef().nativeElement.click();
  }

  onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files) {
      return;
    }

    for (let i = 0; i < input.files.length; i++) {
      this.readFile(input.files[i]);
    }

    input.value = '';
  }

  handleDrop(event: DragEvent): void {
    event.preventDefault();
    if (!event.dataTransfer?.files) {
      return;
    }

    for (let i = 0; i < event.dataTransfer.files.length; i++) {
      this.readFile(event.dataTransfer.files[i]);
    }
  }

  handleDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  removeAttachment(index: number): void {
    // Clean up preview for the removed attachment before emitting removal
    const att = this.attachments()[index];
    if (att?.id) {
      this.previews.update(map => {
        const next = new Map(map);
        next.delete(att.id!);
        return next;
      });
    }
    this.remove.emit(index);
  }

  private readFile(file: File): void {
    const reader = new FileReader();
    const mimeType = file.type || 'application/octet-stream';
    const id = crypto.randomUUID();

    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];

      const attachment: DraftAttachment = {
        id,
        filename: file.name,
        mimeType,
        size: file.size,
        data: base64,
      };

      // Cache data-URL preview for image types
      if (isImageMime(mimeType)) {
        this.previews.update(map => {
          const next = new Map(map);
          next.set(id, dataUrl);
          return next;
        });
      }

      this.add.emit(attachment);
    };

    reader.onerror = () => {
      this.toastService.error(`Failed to read file: ${file.name}`);
    };

    reader.readAsDataURL(file);
  }
}
