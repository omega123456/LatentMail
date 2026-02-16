import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DraftAttachment } from '../../core/models/email.model';
import { FileSizePipe } from '../../shared/pipes/file-size.pipe';

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
