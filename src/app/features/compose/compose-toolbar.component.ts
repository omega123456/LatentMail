import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { Editor } from '@tiptap/core';

@Component({
  selector: 'app-compose-toolbar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="compose-toolbar">
      <button class="tb-btn" [class.active]="isActive('bold')" (click)="exec('toggleBold')" title="Bold (Ctrl+B)">
        <span class="material-symbols-outlined">format_bold</span>
      </button>
      <button class="tb-btn" [class.active]="isActive('italic')" (click)="exec('toggleItalic')" title="Italic (Ctrl+I)">
        <span class="material-symbols-outlined">format_italic</span>
      </button>
      <button class="tb-btn" [class.active]="isActive('underline')" (click)="exec('toggleUnderline')" title="Underline (Ctrl+U)">
        <span class="material-symbols-outlined">format_underlined</span>
      </button>
      <button class="tb-btn" [class.active]="isActive('strike')" (click)="exec('toggleStrike')" title="Strikethrough">
        <span class="material-symbols-outlined">format_strikethrough</span>
      </button>

      <div class="tb-divider"></div>

      <button class="tb-btn" [class.active]="isActive('bulletList')" (click)="exec('toggleBulletList')" title="Bullet List">
        <span class="material-symbols-outlined">format_list_bulleted</span>
      </button>
      <button class="tb-btn" [class.active]="isActive('orderedList')" (click)="exec('toggleOrderedList')" title="Numbered List">
        <span class="material-symbols-outlined">format_list_numbered</span>
      </button>

      <div class="tb-divider"></div>

      <button class="tb-btn" [class.active]="isActive('blockquote')" (click)="exec('toggleBlockquote')" title="Quote">
        <span class="material-symbols-outlined">format_quote</span>
      </button>
      <button class="tb-btn" [class.active]="isActive('codeBlock')" (click)="exec('toggleCodeBlock')" title="Code Block">
        <span class="material-symbols-outlined">code</span>
      </button>
      <button class="tb-btn" (click)="exec('setHorizontalRule')" title="Horizontal Rule">
        <span class="material-symbols-outlined">horizontal_rule</span>
      </button>

      <div class="tb-divider"></div>

      <button class="tb-btn" [class.active]="isActive('link')" (click)="insertLink()" title="Insert Link">
        <span class="material-symbols-outlined">link</span>
      </button>
      <button class="tb-btn" (click)="exec('undo')" title="Undo (Ctrl+Z)">
        <span class="material-symbols-outlined">undo</span>
      </button>
      <button class="tb-btn" (click)="exec('redo')" title="Redo (Ctrl+Y)">
        <span class="material-symbols-outlined">redo</span>
      </button>
    </div>
  `,
  styles: [`
    .compose-toolbar {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 4px 8px;
      border-bottom: 1px solid var(--color-border);
      flex-wrap: wrap;
    }

    .tb-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border: none;
      background: none;
      border-radius: 4px;
      cursor: pointer;
      color: var(--color-text-secondary);
      transition: background-color 120ms ease;

      &:hover {
        background-color: var(--color-surface-variant);
        color: var(--color-text-primary);
      }

      &.active {
        background-color: var(--color-primary-light);
        color: var(--color-primary);
      }

      .material-symbols-outlined {
        font-size: 18px;
      }
    }

    .tb-divider {
      width: 1px;
      height: 20px;
      background-color: var(--color-border);
      margin: 0 4px;
    }
  `]
})
export class ComposeToolbarComponent {
  readonly editor = input<Editor | null>(null);

  isActive(name: string): boolean {
    return this.editor()?.isActive(name) ?? false;
  }

  exec(command: string): void {
    const ed = this.editor();
    if (!ed) return;
    const chain = ed.chain().focus();
    // Use indexing since TipTap commands are dynamic
    if (typeof (chain as Record<string, unknown>)[command] === 'function') {
      ((chain as Record<string, unknown>)[command] as () => { run: () => void })().run();
    }
  }

  insertLink(): void {
    const ed = this.editor();
    if (!ed) return;

    if (ed.isActive('link')) {
      ed.chain().focus().unsetLink().run();
      return;
    }

    const url = prompt('Enter URL:');
    if (url) {
      ed.chain().focus().setLink({ href: url }).run();
    }
  }
}
