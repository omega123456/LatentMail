import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  signal,
  computed,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ElectronService } from '../../../core/services/electron.service';
import { ToastService } from '../../../core/services/toast.service';
import { PdfJsViewerModule } from 'ng2-pdfjs-viewer';
import DOMPurify from 'dompurify';
import * as mammoth from 'mammoth';
import { read as xlsxRead, utils as xlsxUtils } from 'xlsx';

export interface AttachmentPreviewDialogData {
  attachmentId: number;
  filename: string;
  mimeType?: string;
}

type PreviewType = 'image' | 'pdf' | 'text' | 'word' | 'csv' | 'fallback';

@Component({
  selector: 'app-attachment-preview-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    PdfJsViewerModule,
  ],
  templateUrl: './attachment-preview-dialog.component.html',
  styleUrl: './attachment-preview-dialog.component.scss',
})
export class AttachmentPreviewDialogComponent implements OnInit, OnDestroy {
  readonly data: AttachmentPreviewDialogData = inject(MAT_DIALOG_DATA);
  private readonly dialogRef = inject(MatDialogRef<AttachmentPreviewDialogComponent>);
  private readonly electronService = inject(ElectronService);
  private readonly toastService = inject(ToastService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly sanitizer = inject(DomSanitizer);

  readonly loading = signal<boolean>(true);
  readonly error = signal<string | null>(null);
  readonly contentUrl = signal<string | null>(null);
  readonly pdfSrc = signal<string | null>(null);
  readonly textContent = signal<string | null>(null);
  /** Sanitized HTML for .docx preview (rendered in div to avoid srcdoc script messages). */
  readonly wordHtml = signal<SafeHtml | null>(null);
  readonly previewType = signal<PreviewType>('fallback');
  /** Parsed CSV rows (array of row arrays) for table preview. */
  readonly csvTableData = signal<unknown[][] | null>(null);

  private objectUrl: string | null = null;

  readonly isImage = computed(() => this.previewType() === 'image');
  readonly isPdf = computed(() => this.previewType() === 'pdf');
  readonly isText = computed(() => this.previewType() === 'text');
  readonly isWord = computed(() => this.previewType() === 'word');
  readonly isCsv = computed(() => this.previewType() === 'csv');
  readonly isFallback = computed(() => this.previewType() === 'fallback');
  readonly hasError = computed(() => this.error() != null);

  ngOnInit(): void {
    this.loadContent();
  }

  ngOnDestroy(): void {
    this.revokeObjectUrl();
  }

  close(): void {
    this.dialogRef.close();
  }

  async download(): Promise<void> {
    const response = await this.electronService.downloadAttachment(this.data.attachmentId);
    if (!response.success) {
      this.toastService.error(
        response.error?.message ?? `Failed to download ${this.data.filename}`
      );
    } else {
      this.toastService.success(`Downloaded ${this.data.filename}`);
    }
  }

  private async loadContent(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const mimeType = (this.data.mimeType ?? '').toLowerCase();
    const filename = (this.data.filename ?? '').toLowerCase();
    const isCsvType =
      mimeType === 'text/csv' ||
      mimeType === 'application/csv' ||
      filename.endsWith('.csv');

    if (isCsvType) {
      try {
        const response = await this.electronService.getAttachmentContentAsText(
          this.data.attachmentId
        );
        if (!response.success || response.data?.text == null) {
          this.error.set(response.error?.message ?? 'Failed to load attachment');
          this.previewType.set('fallback');
          return;
        }
        const rows = this.csvTextToTableData(response.data.text);
        if (rows && rows.length > 0) {
          this.csvTableData.set(rows);
          this.previewType.set('csv');
        } else {
          this.previewType.set('fallback');
        }
      } catch (err) {
        this.error.set(err instanceof Error ? err.message : 'Failed to load attachment');
        this.previewType.set('fallback');
      } finally {
        this.loading.set(false);
        this.changeDetector.markForCheck();
      }
      return;
    }

    const isTextType =
      mimeType.startsWith('text/') ||
      mimeType === 'application/json' ||
      mimeType === 'application/javascript';

    if (isTextType) {
      try {
        const response = await this.electronService.getAttachmentContentAsText(
          this.data.attachmentId
        );
        if (!response.success || response.data?.text == null) {
          this.error.set(response.error?.message ?? 'Failed to load attachment');
          this.previewType.set('fallback');
          return;
        }
        this.textContent.set(response.data.text);
        this.previewType.set('text');
      } catch (err) {
        this.error.set(err instanceof Error ? err.message : 'Failed to load attachment');
        this.previewType.set('fallback');
      } finally {
        this.loading.set(false);
        this.changeDetector.markForCheck();
      }
      return;
    }

    try {
      const response = await this.electronService.getAttachmentContent(this.data.attachmentId);
      if (!response.success || !response.data?.content) {
        this.error.set(response.error?.message ?? 'Failed to load attachment');
        this.previewType.set('fallback');
        return;
      }

      const base64 = response.data.content;
      const resolvedMime = (response.data.mimeType ?? mimeType).toLowerCase();

      if (resolvedMime.startsWith('image/')) {
        const url = this.base64ToObjectUrl(base64, resolvedMime);
        if (url) {
          this.objectUrl = url;
          this.contentUrl.set(url);
          this.previewType.set('image');
        } else {
          this.previewType.set('fallback');
        }
      } else if (resolvedMime === 'application/pdf') {
        const url = this.base64ToObjectUrl(base64, 'application/pdf');
        if (url) {
          this.objectUrl = url;
          this.pdfSrc.set(url);
          this.previewType.set('pdf');
        } else {
          this.previewType.set('fallback');
        }
      } else if (
        resolvedMime ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ) {
        try {
          const html = await this.convertDocxToHtml(base64);
          if (html) {
            this.wordHtml.set(html);
            this.previewType.set('word');
          } else {
            this.previewType.set('fallback');
          }
        } catch {
          this.previewType.set('fallback');
        }
      } else {
        this.previewType.set('fallback');
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load attachment');
      this.previewType.set('fallback');
    } finally {
      this.loading.set(false);
      this.changeDetector.markForCheck();
    }
  }

  /** Parse CSV text with xlsx and return first sheet as 2D array (array of rows). */
  private csvTextToTableData(csvText: string): unknown[][] | null {
    try {
      const workbook = xlsxRead(csvText, { type: 'string' });
      if (!workbook.SheetNames.length) {
        return null;
      }
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      if (!worksheet) {
        return null;
      }
      const rows = xlsxUtils.sheet_to_json<unknown[]>(worksheet, { header: 1, defval: '' });
      return rows.length > 0 ? rows : null;
    } catch {
      return null;
    }
  }

  /** Convert .docx base64 to sanitized HTML for preview (no iframe/srcdoc). */
  private async convertDocxToHtml(base64: string): Promise<SafeHtml | null> {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const result = await mammoth.convertToHtml({ arrayBuffer });
    const raw = result.value;
    if (!raw?.trim()) {
      return null;
    }
    const sanitized =
      DOMPurify.sanitize(raw, {
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
      }) ?? '';
    const noScript = sanitized.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    return this.sanitizer.bypassSecurityTrustHtml(noScript);
  }

  private base64ToObjectUrl(base64: string, mimeType: string): string | null {
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
      }
      const blob = new Blob([bytes], { type: mimeType });
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  private revokeObjectUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
