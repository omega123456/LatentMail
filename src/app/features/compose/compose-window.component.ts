import {
  Component, inject, OnInit, OnDestroy, ElementRef, ViewChild, AfterViewInit,
  NgZone, ChangeDetectorRef, signal, HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import Image from '@tiptap/extension-image';
import { ComposeStore } from '../../store/compose.store';
import { AccountsStore } from '../../store/accounts.store';
import { ElectronService, OsFileDropPayload } from '../../core/services/electron.service';
import { RecipientInputComponent } from './recipient-input.component';
import { ComposeToolbarComponent } from './compose-toolbar.component';
import { AttachmentUploadComponent } from './attachment-upload.component';
import { SignatureSelectorComponent } from './signature-selector.component';
import { DraftAttachment } from '../../core/models/email.model';

const MIN_COMPOSE_WIDTH = 400;
const MAX_COMPOSE_WIDTH = 1200;
const MIN_COMPOSE_HEIGHT = 320;
const DEFAULT_COMPOSE_WIDTH = 865;
const DEFAULT_COMPOSE_HEIGHT = 700;

type ResizeEdge = 'north' | 'west' | 'northwest';

interface ResizeState {
  edge: ResizeEdge;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

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
  private readonly electronService = inject(ElectronService);
  private readonly ngZone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly sanitizer = inject(DomSanitizer);

  /** Width in pixels; default 865. */
  readonly composeWidth = signal(DEFAULT_COMPOSE_WIDTH);
  /** Height in pixels; null = auto (content height). */
  readonly composeHeight = signal<number | null>(DEFAULT_COMPOSE_HEIGHT);

  /** Safe HTML for the quoted block (app-controlled email content). */
  get sanitizedQuotedHtml(): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(this.composeStore.quotedHtml());
  }

  @ViewChild('editorContainer') editorContainer!: ElementRef<HTMLElement>;
  @ViewChild('composeWindowEl') composeWindowEl?: ElementRef<HTMLElement>;
  @ViewChild('subjectInput') subjectInput?: ElementRef<HTMLInputElement>;
  @ViewChild('inlineImageInput') inlineImageInput?: ElementRef<HTMLInputElement>;
  @ViewChild('linkUrlInputRef') linkUrlInputRef?: ElementRef<HTMLInputElement>;

  editor: Editor | null = null;
  private openWatchTimer: ReturnType<typeof setInterval> | null = null;
  private resizeState: ResizeState | null = null;
  private readonly osDropSubscriptions = new Subscription();

  /** Whether an OS file drag is currently active over the window. */
  readonly osDragActive = signal(false);
  /** Whether the current OS drag contains ONLY image files (for overlay state). */
  readonly osDragOnlyImages = signal(false);

  /** Right-click context menu on the editor */
  readonly showEditorContextMenu = signal(false);
  readonly contextMenuX = signal(0);
  readonly contextMenuY = signal(0);
  readonly savedContextMenuSelection = signal<{ from: number; to: number } | null>(null);
  /** Snapshot of active formatting when the context menu was opened */
  readonly contextMenuActiveFormats = signal<{
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strike: boolean;
    link: boolean;
  }>({ bold: false, italic: false, underline: false, strike: false, link: false });

  /** Link URL dialog (prompt() not supported in Electron) */
  readonly showLinkUrlDialog = signal(false);
  readonly linkUrlInput = signal('');
  /** Selection to apply link to when dialog is confirmed (from context menu). */
  readonly pendingLinkSelection = signal<{ from: number; to: number } | null>(null);

  ngOnInit(): void {
    this.composeStore.loadSignatures();
    this.subscribeToOsDropEvents();
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
    this.osDropSubscriptions.unsubscribe();
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

      const editorInstance = new Editor({
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
            const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
            if (imageFiles.length === 0) {
              return false;
            }
            const dropPosition = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            if (dropPosition == null) {
              return false;
            }
            event.preventDefault();
            event.stopPropagation();
            let insertPosition = dropPosition;
            const insertNext = (index: number): void => {
              if (index >= imageFiles.length) {
                return;
              }
              const file = imageFiles[index];
              const reader = new FileReader();
              reader.onload = () => {
                const dataUrl = reader.result as string;
                editorInstance.chain().focus().insertContentAt(insertPosition, { type: 'image', attrs: { src: dataUrl } }).run();
                insertPosition += 1;
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
            this.editor = editorInstance;
            this.ngZone.run(() => this.cdr.markForCheck());
          } else {
            editorInstance.destroy();
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

  focusEditor(clickEvent?: MouseEvent): void {
    const editor = this.editor;
    if (!editor) {
      return;
    }
    // When click was on the container (e.g. padding), put caret at end; otherwise do nothing so content click selection is kept
    const targetIsContainer = clickEvent?.target === this.editorContainer?.nativeElement;
    if (targetIsContainer) {
      editor.chain().focus('end').run();
    } else {
      editor.commands.focus();
    }
  }

  private destroyEditor(): void {
    this.closeEditorContextMenu();
    this.closeLinkUrlDialog();
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
  }

  /** Close the editor context menu and clear stored selection. */
  closeEditorContextMenu(): void {
    this.showEditorContextMenu.set(false);
    this.savedContextMenuSelection.set(null);
  }

  /**
   * Call from compose-window (click): close context menu when clicking outside it.
   * Clicks inside the compose window don't reach document due to stopPropagation.
   */
  onComposeWindowClick(event: MouseEvent): void {
    if (this.showEditorContextMenu()) {
      const target = event.target as Element | null;
      if (!target?.closest?.('.editor-context-menu')) {
        this.closeEditorContextMenu();
      }
    }
    event.stopPropagation();
  }

  onEditorContextMenu(event: MouseEvent): void {
    const editor = this.editor;
    if (!editor) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const selection = editor.state.selection;
    this.contextMenuX.set(event.clientX);
    this.contextMenuY.set(event.clientY);
    this.savedContextMenuSelection.set({ from: selection.from, to: selection.to });
    this.contextMenuActiveFormats.set({
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      underline: editor.isActive('underline'),
      strike: editor.isActive('strike'),
      link: editor.isActive('link'),
    });
    this.showEditorContextMenu.set(true);
  }

  /** True when the stored selection is non-empty (for Cut/Copy). */
  hasContextMenuSelection(): boolean {
    const sel = this.savedContextMenuSelection();
    return sel != null && sel.from !== sel.to;
  }

  contextMenuCut(): void {
    const editor = this.editor;
    const sel = this.savedContextMenuSelection();
    if (!editor || !sel) {
      this.closeEditorContextMenu();
      return;
    }
    editor.chain().focus().setTextSelection({ from: sel.from, to: sel.to }).run();
    document.execCommand('cut');
    this.closeEditorContextMenu();
  }

  contextMenuCopy(): void {
    const editor = this.editor;
    const sel = this.savedContextMenuSelection();
    if (!editor || !sel) {
      this.closeEditorContextMenu();
      return;
    }
    editor.chain().focus().setTextSelection({ from: sel.from, to: sel.to }).run();
    document.execCommand('copy');
    this.closeEditorContextMenu();
  }

  contextMenuPaste(): void {
    const editor = this.editor;
    const sel = this.savedContextMenuSelection();
    if (!editor) {
      this.closeEditorContextMenu();
      return;
    }
    editor.chain().focus().run();
    if (sel) {
      editor.commands.setTextSelection({ from: sel.to, to: sel.to });
    }
    document.execCommand('paste');
    this.closeEditorContextMenu();
  }

  contextMenuFormat(command: string): void {
    const editor = this.editor;
    const sel = this.savedContextMenuSelection();
    if (!editor) {
      this.closeEditorContextMenu();
      return;
    }
    let chain = editor.chain().focus();
    if (sel && sel.from !== sel.to) {
      chain = chain.setTextSelection({ from: sel.from, to: sel.to });
    }
    const chainAny = chain as Record<string, unknown>;
    if (typeof chainAny[command] === 'function') {
      (chainAny[command] as () => { run: () => void })().run();
    }
    this.closeEditorContextMenu();
  }

  contextMenuLink(): void {
    const savedSelection = this.savedContextMenuSelection();
    this.closeEditorContextMenu();
    this.handleLinkRequest(savedSelection ?? undefined);
  }

  /**
   * Single entry point for link action: toolbar or context menu.
   * If cursor is on a link, unsets it; otherwise opens the link URL dialog.
   * @param selection Optional selection to apply the link to (e.g. from context menu); uses current selection if omitted.
   */
  handleLinkRequest(selection?: { from: number; to: number } | null): void {
    const editor = this.editor;
    if (!editor) {
      return;
    }
    if (editor.isActive('link')) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    this.openLinkUrlDialog(selection);
  }

  /** Close the link URL dialog and clear pending selection. */
  closeLinkUrlDialog(): void {
    this.showLinkUrlDialog.set(false);
    this.linkUrlInput.set('');
    this.pendingLinkSelection.set(null);
  }

  /** Open the link URL dialog (from toolbar or context menu). Uses current editor selection unless one is passed. */
  openLinkUrlDialog(selection?: { from: number; to: number } | null): void {
    const editor = this.editor;
    if (!editor) {
      return;
    }
    const sel = editor.state.selection;
    this.pendingLinkSelection.set(selection ?? { from: sel.from, to: sel.to });
    this.linkUrlInput.set('');
    this.showLinkUrlDialog.set(true);
    setTimeout(() => this.linkUrlInputRef?.nativeElement?.focus(), 50);
  }

  /** Apply the URL from the link dialog and close it. */
  confirmLinkUrl(): void {
    const editor = this.editor;
    const url = this.linkUrlInput().trim();
    if (!editor || !url) {
      this.closeLinkUrlDialog();
      return;
    }
    const pending = this.pendingLinkSelection();
    editor.chain().focus();
    if (pending) {
      editor.commands.setTextSelection({ from: pending.from, to: pending.to });
    }
    editor.chain().focus().setLink({ href: url }).run();
    this.closeLinkUrlDialog();
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

  startResize(edge: ResizeEdge, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const element = this.composeWindowEl?.nativeElement;
    if (!element) {
      return;
    }
    const bounds = element.getBoundingClientRect();
    const currentHeight = this.composeHeight() ?? bounds.height;
    this.resizeState = {
      edge,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: this.composeWidth(),
      startHeight: currentHeight,
    };
  }

  @HostListener('document:mousemove', ['$event'])
  onDocumentMouseMove(event: MouseEvent): void {
    const state = this.resizeState;
    if (!state) {
      return;
    }
    // Window is anchored bottom-right: top/left handles grow upward and left
    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;
    let width = state.startWidth;
    let height = state.startHeight;
    if (state.edge === 'west' || state.edge === 'northwest') {
      width = Math.min(MAX_COMPOSE_WIDTH, Math.max(MIN_COMPOSE_WIDTH, state.startWidth - deltaX));
    }
    if (state.edge === 'north' || state.edge === 'northwest') {
      const maxHeight = typeof window !== 'undefined' ? window.innerHeight * 0.95 : 2000;
      height = Math.min(maxHeight, Math.max(MIN_COMPOSE_HEIGHT, state.startHeight - deltaY));
    }
    this.composeWidth.set(width);
    this.composeHeight.set(height);
  }

  @HostListener('document:mouseup')
  onDocumentMouseUp(): void {
    if (this.resizeState) {
      this.resizeState = null;
    }
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.showEditorContextMenu()) {
      this.closeEditorContextMenu();
    }
  }

  @HostListener('document:keydown.escape')
  onDocumentEscape(): void {
    if (this.showLinkUrlDialog()) {
      this.closeLinkUrlDialog();
    } else if (this.showEditorContextMenu()) {
      this.closeEditorContextMenu();
    }
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
    if (!event.dataTransfer?.files) {
      return;
    }
    for (let index = 0; index < event.dataTransfer.files.length; index++) {
      const file = event.dataTransfer.files[index];
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

  // --- OS file drag-and-drop (Win32 native addon) ---

  /**
   * Subscribe to OS-level file drag/drop IPC events from the native Win32 addon.
   * These events are window-level (not compose-specific), so we check composeStore.isOpen()
   * before acting. Subscriptions live for the component's lifetime.
   */
  private subscribeToOsDropEvents(): void {
    this.osDropSubscriptions.add(
      this.electronService.onOsFileDragEnter().subscribe((meta) => {
        if (this.composeStore.isOpen()) {
          this.osDragActive.set(true);
          this.osDragOnlyImages.set(meta.onlyImages);
        }
      })
    );

    this.osDropSubscriptions.add(
      this.electronService.onOsFileDragLeave().subscribe(() => {
        this.osDragActive.set(false);
      })
    );

    this.osDropSubscriptions.add(
      this.electronService.onOsFileDrop().subscribe((payload) => {
        this.handleOsFileDrop(payload);
      })
    );
  }

  /**
   * Handle files dropped from the OS (Windows Explorer) via the native addon.
   * Images are inserted inline into the TipTap editor; non-images become attachments.
   */
  private handleOsFileDrop(payload: OsFileDropPayload): void {
    // Always clear overlay
    this.osDragActive.set(false);
    this.osDragOnlyImages.set(false);

    // Guard: compose must be open and editor available
    if (!this.composeStore.isOpen() || !this.editor) {
      return;
    }

    // Insert images inline into the TipTap editor
    for (const image of payload.images) {
      if (this.editor.isFocused) {
        // Insert at current cursor position
        this.editor.chain().focus().setImage({ src: image.dataUrl }).run();
      } else {
        // Insert at end of document
        this.editor.chain().focus('end').setImage({ src: image.dataUrl }).run();
      }
    }

    // Add non-image files as attachments
    for (const attachment of payload.attachments) {
      this.composeStore.addAttachment({
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        data: attachment.data,
      });
    }
  }
}
