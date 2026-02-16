import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { Editor } from '@tiptap/core';

@Component({
  selector: 'app-compose-toolbar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './compose-toolbar.component.html',
  styleUrl: './compose-toolbar.component.scss',
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
