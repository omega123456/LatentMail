import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { Editor } from '@tiptap/core';

@Component({
  selector: 'app-compose-toolbar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './compose-toolbar.component.html',
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
