import { Component, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { Editor } from '@tiptap/core';
import { AiStore } from '../../store/ai.store';

@Component({
  selector: 'app-compose-toolbar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './compose-toolbar.component.html',
  styleUrl: './compose-toolbar.component.scss',
})
export class ComposeToolbarComponent {
  readonly editor = input<Editor | null>(null);
  readonly aiStore = inject(AiStore);

  /** Emitted when the user requests to insert an inline image (parent opens file picker). */
  readonly insertImageRequest = output<void>();

  /** AI compose prompt dialog state */
  readonly showAiPrompt = signal(false);
  readonly aiPromptText = signal('');
  readonly showAiMenu = signal(false);

  isActive(name: string): boolean {
    return this.editor()?.isActive(name) ?? false;
  }

  exec(command: string): void {
    const ed = this.editor();
    if (!ed) {
      return;
    }
    const chain = ed.chain().focus();
    // Use indexing since TipTap commands are dynamic
    if (typeof (chain as Record<string, unknown>)[command] === 'function') {
      ((chain as Record<string, unknown>)[command] as () => { run: () => void })().run();
    }
  }

  insertLink(): void {
    const ed = this.editor();
    if (!ed) {
      return;
    }

    if (ed.isActive('link')) {
      ed.chain().focus().unsetLink().run();
      return;
    }

    const url = prompt('Enter URL:');
    if (url) {
      ed.chain().focus().setLink({ href: url }).run();
    }
  }

  /** Request to open the inline image picker (handled by parent). */
  requestInsertImage(): void {
    this.insertImageRequest.emit();
  }

  toggleAiMenu(): void {
    this.showAiMenu.set(!this.showAiMenu());
  }

  closeAiMenu(): void {
    this.showAiMenu.set(false);
  }

  /** Open AI compose prompt */
  openAiCompose(): void {
    this.showAiMenu.set(false);
    this.showAiPrompt.set(true);
    this.aiPromptText.set('');
  }

  /** Close AI compose prompt */
  closeAiPrompt(): void {
    this.showAiPrompt.set(false);
    this.aiPromptText.set('');
  }

  /** Submit AI compose request */
  async submitAiCompose(): Promise<void> {
    const prompt = this.aiPromptText().trim();
    if (!prompt) {
      return;
    }

    const ed = this.editor();
    const currentContent = ed?.getText() || '';

    this.showAiPrompt.set(false);
    const result = await this.aiStore.aiCompose(prompt, currentContent || undefined);
    if (result && ed) {
      // Insert AI output as plain text to prevent XSS
      this.setEditorPlainText(ed, result);
    }
  }

  /** Transform selected text with AI */
  async transformText(transformation: string): Promise<void> {
    this.showAiMenu.set(false);
    const ed = this.editor();
    if (!ed) {
      return;
    }

    // Get selected text, or all text if nothing selected
    const { from, to } = ed.state.selection;
    const selectedText = ed.state.doc.textBetween(from, to, ' ');
    const textToTransform = selectedText || ed.getText();

    if (!textToTransform.trim()) {
      return;
    }

    const result = await this.aiStore.transform(textToTransform, transformation);
    if (result && ed) {
      if (selectedText) {
        // Replace only the selection with plain text
        ed.chain().focus().deleteSelection().insertContent({
          type: 'text',
          text: result,
        }).run();
      } else {
        // Replace all content with plain text
        this.setEditorPlainText(ed, result);
      }
    }
  }

  /**
   * Set editor content as plain text (paragraph nodes with text nodes).
   * Prevents XSS from AI-generated output by never inserting raw HTML.
   */
  private setEditorPlainText(ed: Editor, text: string): void {
    const paragraphs = text.split('\n\n');
    const content = paragraphs.map(p => ({
      type: 'paragraph' as const,
      content: p.trim() ? [{ type: 'text' as const, text: p }] : [],
    }));
    ed.commands.setContent({ type: 'doc', content });
  }
}
