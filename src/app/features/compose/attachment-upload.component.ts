import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DraftAttachment } from '../../core/models/email.model';
import { FileSizePipe } from '../../shared/pipes/file-size.pipe';

@Component({
  selector: 'app-attachment-upload',
  standalone: true,
  imports: [CommonModule, FileSizePipe],
  template: `
    @if (attachments().length > 0) {
      <div class="attachment-bar">
        @for (att of attachments(); track att.filename; let i = $index) {
          <div class="attachment-chip">
            <span class="material-symbols-outlined att-icon">attach_file</span>
            <span class="att-name">{{ att.filename }}</span>
            <span class="att-size">({{ att.size | fileSize }})</span>
            <button class="att-remove" (click)="remove.emit(i)">
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>
        }
      </div>
    }

    <input
      #fileInput
      type="file"
      multiple
      style="display: none"
      (change)="onFilesSelected($event)"
    />
  `,
  styles: [`
    .attachment-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px 12px;
      border-top: 1px solid var(--color-border);
    }

    .attachment-chip {
      display: flex;
      align-items: center;
      gap: 4px;
      background: var(--color-surface-variant);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 12px;
      color: var(--color-text-primary);
    }

    .att-icon {
      font-size: 14px;
      color: var(--color-text-tertiary);
    }

    .att-name {
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .att-size {
      color: var(--color-text-tertiary);
    }

    .att-remove {
      display: flex;
      align-items: center;
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
      color: var(--color-text-tertiary);

      &:hover { color: var(--color-error); }

      .material-symbols-outlined { font-size: 14px; }
    }
  `]
})
export class AttachmentUploadComponent {
  readonly attachments = input<DraftAttachment[]>([]);
  readonly add = output<DraftAttachment>();
  readonly remove = output<number>();

  openFilePicker(): void {
    const input = document.querySelector('app-attachment-upload input[type="file"]') as HTMLInputElement;
    input?.click();
  }

  onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files) return;

    for (let i = 0; i < input.files.length; i++) {
      const file = input.files[i];
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        this.add.emit({
          id: crypto.randomUUID(),
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          data: base64,
        });
      };
      reader.readAsDataURL(file);
    }

    input.value = '';
  }

  handleDrop(event: DragEvent): void {
    event.preventDefault();
    if (!event.dataTransfer?.files) return;

    for (let i = 0; i < event.dataTransfer.files.length; i++) {
      const file = event.dataTransfer.files[i];
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        this.add.emit({
          id: crypto.randomUUID(),
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          data: base64,
        });
      };
      reader.readAsDataURL(file);
    }
  }
}
