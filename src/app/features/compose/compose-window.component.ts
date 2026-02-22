import {
  Component, inject, OnInit, OnDestroy, ElementRef, ViewChild, AfterViewInit,
  NgZone, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import Image from '@tiptap/extension-image';
import { ComposeStore } from '../../store/compose.store';
import { AccountsStore } from '../../store/accounts.store';
import { RecipientInputComponent } from './recipient-input.component';
import { ComposeToolbarComponent } from './compose-toolbar.component';
import { AttachmentUploadComponent } from './attachment-upload.component';
import { SignatureSelectorComponent } from './signature-selector.component';
import { DraftAttachment } from '../../core/models/email.model';

@Component({
  selector: 'app-compose-window',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    RecipientInputComponent, ComposeToolbarComponent,
    AttachmentUploadComponent, SignatureSelectorComponent,
  ],
  templateUrl: './compose-window.component.html',
  styleUrl: './compose-window.component.scss',
})
export class ComposeWindowComponent implements OnInit, AfterViewInit, OnDestroy {
  readonly composeStore = inject(ComposeStore);
  private readonly accountsStore = inject(AccountsStore);
  private readonly ngZone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly sanitizer = inject(DomSanitizer);

  /** Safe HTML for the quoted block (app-controlled email content). */
  get sanitizedQuotedHtml(): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(this.composeStore.quotedHtml());
  }

  @ViewChild('editorContainer') editorContainer!: ElementRef<HTMLElement>;
  @ViewChild('subjectInput') subjectInput?: ElementRef<HTMLInputElement>;
  @ViewChild('inlineImageInput') inlineImageInput?: ElementRef<HTMLInputElement>;

  editor: Editor | null = null;
  private openWatchTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.composeStore.loadSignatures();
  }

  ngAfterViewInit(): void {
    // Poll open-state transitions to initialize interactive controls after render.
    let wasOpen = false;
    this.openWatchTimer = setInterval(() => {
      const isOpen = this.composeStore.isOpen();
      if (isOpen && !wasOpen) {
        this.initEditor();
        this.focusSubjectInput();
      } else if (!isOpen && wasOpen) {
        this.destroyEditor();
      }
      wasOpen = isOpen;
    }, 100);
  }

  ngOnDestroy(): void {
    if (this.openWatchTimer) {
      clearInterval(this.openWatchTimer);
      this.openWatchTimer = null;
    }
    this.destroyEditor();
  }

  private initEditor(): void {
    if (this.editor) return;

    // Delayed/retried init — the container is created only when compose opens.
    let attempts = 0;
    const maxAttempts = 10;
    const tryInit = () => {
      if (!this.composeStore.isOpen() || this.editor) return;

      const container = this.editorContainer?.nativeElement;
      if (!container) {
        attempts += 1;
        if (attempts < maxAttempts) {
          setTimeout(tryInit, 50);
        }
        return;
      }

      const ed = new Editor({
        element: container,
        extensions: [
          StarterKit.configure({
            heading: { levels: [1, 2, 3] },
          }),
          Link.configure({
            openOnClick: false,
            HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
          }),
          Underline,
          Image,
          Placeholder.configure({
            placeholder: 'Write your message...',
          }),
        ],
        content: this.composeStore.htmlBody() || '',
        onUpdate: ({ editor }) => {
          this.composeStore.updateField('htmlBody', editor.getHTML());
          this.composeStore.updateField('textBody', editor.getText());
        },
        editorProps: {
          attributes: {
            class: 'tiptap',
          },
          handleDrop: (view, event) => {
            const files = event.dataTransfer?.files;
            if (!files?.length) {
              return false;
            }
            const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
            if (imageFiles.length === 0) {
              return false;
            }
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            if (pos == null) {
              return false;
            }
            event.preventDefault();
            event.stopPropagation();
            let insertPos = pos;
            const insertNext = (index: number): void => {
              if (index >= imageFiles.length) {
                return;
              }
              const file = imageFiles[index];
              const reader = new FileReader();
              reader.onload = () => {
                const dataUrl = reader.result as string;
                ed.chain().focus().insertContentAt(insertPos, { type: 'image', attrs: { src: dataUrl } }).run();
                insertPos += 1;
                insertNext(index + 1);
              };
              reader.readAsDataURL(file);
            };
            insertNext(0);
            return true;
          },
        },
      });
      // Assign outside Angular zone so CD doesn't see the change mid-cycle (avoids NG0100)
      this.ngZone.runOutsideAngular(() => {
        setTimeout(() => {
          if (this.composeStore.isOpen() && !this.editor) {
            this.editor = ed;
            this.ngZone.run(() => this.cdr.markForCheck());
          } else {
            ed.destroy();
          }
        }, 0);
      });
    };

    setTimeout(tryInit, 0);
  }

  private focusSubjectInput(): void {
    setTimeout(() => {
      this.subjectInput?.nativeElement?.focus();
    }, 0);
  }

  focusEditor(): void {
    this.editor?.commands.focus();
  }

  private destroyEditor(): void {
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
  }

  async close(): Promise<void> {
    this.destroyEditor();
    await this.composeStore.closeCompose();
  }

  async send(): Promise<void> {
    const success = await this.composeStore.send();
    if (success) {
      this.destroyEditor();
    }
  }

  async discard(): Promise<void> {
    this.destroyEditor();
    await this.composeStore.discardDraft();
  }

  openAttachPicker(): void {
    // Target the attachment upload file input, not the inline-image input
    const input = this.editorContainer?.nativeElement
      ?.closest('.compose-window')
      ?.querySelector('input[type="file"]:not(.inline-image-input)') as HTMLInputElement;
    input?.click();
  }

  /** Open the file picker for inserting an inline image (toolbar button). */
  openInlineImagePicker(): void {
    this.inlineImageInput?.nativeElement?.click();
  }

  /** Insert selected image file(s) into the editor at the current cursor. */
  onInlineImageSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files?.length || !this.editor) {
      input.value = '';
      return;
    }
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      input.value = '';
      return;
    }
    let inserted = 0;
    const insertNext = (index: number): void => {
      if (index >= imageFiles.length) {
        input.value = '';
        return;
      }
      const file = imageFiles[index];
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        this.editor?.chain().focus().setImage({ src: dataUrl }).run();
        inserted += 1;
        insertNext(index + 1);
      };
      reader.readAsDataURL(file);
    };
    insertNext(0);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'copy';
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    // When drop is on the editor, the editor's handleDrop inserts inline images; do not add as attachments.
    if (this.editorContainer?.nativeElement?.contains(event.target as Node)) {
      return;
    }
    // When drop is on the attachment zone, the attachment component handles it; avoid double-add.
    const win = this.editorContainer?.nativeElement?.closest('.compose-window');
    if (win?.querySelector('app-attachment-upload')?.contains(event.target as Node)) {
      return;
    }
    this.handleFileDrop(event);
  }

  private handleFileDrop(event: DragEvent): void {
    if (!event.dataTransfer?.files) return;
    for (let i = 0; i < event.dataTransfer.files.length; i++) {
      const file = event.dataTransfer.files[i];
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        this.composeStore.addAttachment({
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
