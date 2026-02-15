import {
  Component, inject, OnInit, OnDestroy, ElementRef, ViewChild, AfterViewInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
  template: `
    @if (composeStore.isOpen()) {
      <div class="compose-backdrop">
        <div
          class="compose-window"
          (click)="$event.stopPropagation()"
          (dragover)="onDragOver($event)"
          (drop)="onDrop($event)"
        >
          <!-- Header -->
          <div class="compose-header">
            <span class="compose-title">
              @switch (composeStore.mode()) {
                @case ('reply') { Reply }
                @case ('reply-all') { Reply All }
                @case ('forward') { Forward }
                @default { New Message }
              }
            </span>
            <div class="header-actions">
              <button class="header-btn" (click)="close()" title="Close">
                <span class="material-symbols-outlined">close</span>
              </button>
            </div>
          </div>

          <!-- From -->
          <div class="field-row from-row">
            <label class="field-label">From</label>
            <span class="from-value">{{ composeStore.accountDisplayName() }} &lt;{{ composeStore.accountEmail() }}&gt;</span>
          </div>

          <!-- To -->
          <app-recipient-input
            label="To"
            [value]="composeStore.to()"
            (valueChange)="composeStore.updateField('to', $event)"
          />

          <!-- Cc / Bcc toggles -->
          @if (!composeStore.showCc() || !composeStore.showBcc()) {
            <div class="cc-toggles">
              @if (!composeStore.showCc()) {
                <button class="toggle-btn" (click)="composeStore.toggleCc()">Cc</button>
              }
              @if (!composeStore.showBcc()) {
                <button class="toggle-btn" (click)="composeStore.toggleBcc()">Bcc</button>
              }
            </div>
          }

          @if (composeStore.showCc()) {
            <app-recipient-input
              label="Cc"
              [value]="composeStore.cc()"
              (valueChange)="composeStore.updateField('cc', $event)"
            />
          }

          @if (composeStore.showBcc()) {
            <app-recipient-input
              label="Bcc"
              [value]="composeStore.bcc()"
              (valueChange)="composeStore.updateField('bcc', $event)"
            />
          }

          <!-- Subject -->
          <div class="field-row">
            <label class="field-label">Subject</label>
            <input
              #subjectInput
              class="subject-input"
              [ngModel]="composeStore.subject()"
              (ngModelChange)="composeStore.updateField('subject', $event)"
              placeholder="Subject"
            />
          </div>

          <!-- Toolbar -->
          <app-compose-toolbar [editor]="editor" />

          <!-- Editor -->
          <div class="editor-container" #editorContainer (click)="focusEditor()"></div>

          <!-- Attachments -->
          <app-attachment-upload
            [attachments]="composeStore.attachments()"
            (add)="composeStore.addAttachment($event)"
            (remove)="composeStore.removeAttachment($event)"
          />

          <!-- Footer -->
          <div class="compose-footer">
            <div class="footer-left">
              <button class="attach-btn" (click)="openAttachPicker()">
                <span class="material-symbols-outlined">attach_file</span>
                <span>Attach</span>
              </button>
              <app-signature-selector />
            </div>
            <div class="footer-right">
              @if (composeStore.saving()) {
                <span class="save-status">Saving...</span>
              } @else if (composeStore.lastSavedAt()) {
                <span class="save-status">Draft saved</span>
              }
              <button class="discard-btn" (click)="discard()">
                <span class="material-symbols-outlined">delete</span>
                <span>Discard</span>
              </button>
              <button
                class="send-btn"
                [disabled]="!composeStore.canSend() || composeStore.sending()"
                (click)="send()"
              >
                @if (composeStore.sending()) {
                  <span class="material-symbols-outlined spinning">sync</span>
                  <span>Sending...</span>
                } @else {
                  <span class="material-symbols-outlined">send</span>
                  <span>Send</span>
                }
              </button>
            </div>
          </div>

          @if (composeStore.error()) {
            <div class="compose-error">
              <span class="material-symbols-outlined">error</span>
              {{ composeStore.error() }}
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    .compose-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: flex-end;
      justify-content: flex-end;
      padding: 24px;
      background: rgba(0, 0, 0, 0.2);
      -webkit-app-region: no-drag;
    }

    .compose-window {
      width: 640px;
      max-width: 90vw;
      max-height: 85vh;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: compose-open 200ms cubic-bezier(0.4, 0, 0.2, 1);
      -webkit-app-region: no-drag;
    }

    @keyframes compose-open {
      from {
        opacity: 0;
        transform: scale(0.96) translateY(8px);
      }
      to {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
    }

    .compose-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--color-surface-variant);
      border-bottom: 1px solid var(--color-border);
    }

    .compose-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--color-text-primary);
    }

    .header-actions {
      display: flex;
      gap: 4px;
    }

    .header-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      background: none;
      border-radius: 4px;
      cursor: pointer;
      color: var(--color-text-secondary);

      &:hover {
        background-color: var(--color-border);
        color: var(--color-text-primary);
      }

      .material-symbols-outlined { font-size: 18px; }
    }

    .field-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-bottom: 1px solid var(--color-border);

      &:last-of-type {
        border-bottom: none;
      }
    }

    .from-row {
      border-bottom: 1px solid var(--color-border);
    }

    .field-label {
      font-size: 13px;
      color: var(--color-text-tertiary);
      min-width: 52px;
    }

    .from-value {
      font-size: 13px;
      color: var(--color-text-secondary);
    }

    .cc-toggles {
      display: flex;
      gap: 4px;
      padding: 2px 12px 2px 64px;
    }

    .toggle-btn {
      font-size: 12px;
      padding: 2px 8px;
      border: 1px solid var(--color-border);
      background: none;
      border-radius: 4px;
      cursor: pointer;
      color: var(--color-text-tertiary);

      &:hover {
        background-color: var(--color-surface-variant);
        color: var(--color-text-primary);
      }
    }

    .subject-input {
      flex: 1;
      border: none;
      outline: none;
      font-size: 14px;
      font-family: inherit;
      background: transparent;
      color: var(--color-text-primary);
      padding: 4px 0;
    }

    .editor-container {
      flex: 1;
      min-height: 200px;
      max-height: 400px;
      overflow-y: auto;
      padding: 12px 16px;
      cursor: text;
      :host ::ng-deep .tiptap {
        outline: none;
        min-height: 100%;
        font-size: 14px;
        line-height: 1.6;
        color: var(--color-text-primary);

        p { margin: 0 0 8px; }

        p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: var(--color-text-tertiary);
          pointer-events: none;
          height: 0;
        }

        blockquote {
          border-left: 3px solid var(--color-border);
          margin: 8px 0;
          padding: 4px 12px;
          color: var(--color-text-secondary);
        }

        code {
          background-color: var(--color-surface-variant);
          padding: 2px 4px;
          border-radius: 3px;
          font-size: 13px;
        }

        pre {
          background-color: var(--color-surface-variant);
          padding: 12px;
          border-radius: 6px;
          overflow-x: auto;

          code {
            background: none;
            padding: 0;
          }
        }

        a {
          color: var(--color-primary);
          cursor: pointer;
        }

        ul, ol {
          padding-left: 24px;
        }

        hr {
          border: none;
          border-top: 1px solid var(--color-border);
          margin: 12px 0;
        }
      }
    }

    /* Chrome/Electron UA focus ring on contenteditable (not from app CSS) */
    :host ::ng-deep .editor-container .ProseMirror[contenteditable='true']:focus,
    :host ::ng-deep .editor-container .ProseMirror[contenteditable='true']:focus-visible,
    :host ::ng-deep .editor-container .ProseMirror.ProseMirror-focused {
      outline: none !important;
      box-shadow: none !important;
      border: 0 !important;
    }

    .compose-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-top: 1px solid var(--color-border);
    }

    .footer-left, .footer-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .attach-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      border: none;
      background: none;
      border-radius: 6px;
      cursor: pointer;
      color: var(--color-text-secondary);
      font-size: 13px;
      font-family: inherit;

      &:hover {
        background-color: var(--color-surface-variant);
      }

      .material-symbols-outlined { font-size: 16px; }
    }

    .save-status {
      font-size: 11px;
      color: var(--color-text-tertiary);
    }

    .discard-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      border: none;
      background: none;
      border-radius: 6px;
      cursor: pointer;
      color: var(--color-text-secondary);
      font-size: 13px;
      font-family: inherit;

      &:hover {
        background-color: var(--color-surface-variant);
        color: var(--color-error);
      }

      .material-symbols-outlined { font-size: 16px; }
    }

    .send-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 20px;
      border: none;
      background-color: var(--color-primary);
      color: white;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      font-family: inherit;
      transition: background-color 150ms ease;

      &:hover:not(:disabled) {
        filter: brightness(1.1);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .material-symbols-outlined { font-size: 18px; }
    }

    .spinning {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .compose-error {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: #FDE8E8;
      color: var(--color-error);
      font-size: 13px;

      .material-symbols-outlined { font-size: 16px; }
    }
  `]
})
export class ComposeWindowComponent implements OnInit, AfterViewInit, OnDestroy {
  readonly composeStore = inject(ComposeStore);
  private readonly accountsStore = inject(AccountsStore);

  @ViewChild('editorContainer') editorContainer!: ElementRef<HTMLElement>;
  @ViewChild('subjectInput') subjectInput?: ElementRef<HTMLInputElement>;

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

      this.editor = new Editor({
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
        },
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
    const input = this.editorContainer?.nativeElement
      ?.closest('.compose-window')
      ?.querySelector('input[type="file"]') as HTMLInputElement;
    input?.click();
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'copy';
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    // Delegate to attachment upload component
    const uploadComponent = this.editorContainer?.nativeElement
      ?.closest('.compose-window')
      ?.querySelector('app-attachment-upload');
    if (uploadComponent) {
      // Use the component instance via a workaround — or handle directly
      this.handleFileDrop(event);
    }
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
