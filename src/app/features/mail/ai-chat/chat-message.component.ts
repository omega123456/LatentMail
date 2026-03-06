import { Component, input, output, ChangeDetectionStrategy, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ChatMessage } from '../../../core/models/ai.model';
import { SourceCardComponent } from './source-card.component';

@Component({
  selector: 'app-chat-message',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chat-message.component.html',
  styleUrl: './chat-message.component.scss',
  imports: [SourceCardComponent],
})
export class ChatMessageComponent {
  readonly message = input.required<ChatMessage>();
  readonly sourceClicked = output<string>();  // emits xGmMsgId

  private readonly sanitizer = inject(DomSanitizer);

  onSourceClicked(xGmMsgId: string): void {
    this.sourceClicked.emit(xGmMsgId);
  }

  /**
   * Returns message content with citation markers [N] renumbered to sequential
   * 1, 2, 3, ... so that only cited sources appear as [1], [2], etc.
   */
  getDisplayContent(): string {
    const content = this.message().content;
    const sources = this.message().sources;
    if (!sources || sources.length === 0) {
      return content;
    }
    const originalToSequential = new Map<number, number>();
    sources.forEach((source, index) => {
      originalToSequential.set(source.citationIndex, index + 1);
    });
    return content.replace(/\[(\d+)\]/g, (_match: string, numStr: string) => {
      const original = parseInt(numStr, 10);
      const sequential = originalToSequential.get(original);
      return sequential !== undefined ? `[${sequential}]` : `[${original}]`;
    });
  }

  /**
   * Converts the LLM response text (which may contain markdown-like syntax)
   * into safe HTML for rendering via [innerHTML].
   *
   * Code blocks are extracted first (before HTML escaping) so their content
   * is never double-processed by the line-by-line pass. Placeholders are used
   * to hold their positions while the rest of the content is escaped and
   * formatted, then substituted back at the end.
   */
  formatContent(content: string): SafeHtml {
    if (!content) {
      return this.sanitizer.bypassSecurityTrustHtml('');
    }

    // Step 1: Extract code blocks first (before any HTML escaping) so their
    // content is not re-processed by bold/inline-code/list formatting.
    const codeBlocks: string[] = [];
    let html = content.replace(/```([\s\S]*?)```/g, (_match: string, codeContent: string) => {
      const index = codeBlocks.length;
      const escaped = codeContent.trim()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      codeBlocks.push(`<pre><code>${escaped}</code></pre>`);
      return `__CODEBLOCK_${index}__`;
    });

    // Step 2: HTML-escape remaining content to prevent XSS from LLM output
    html = html
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Step 3: Bold and inline code (applied only to non-placeholder content)
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Step 4: Process line by line for lists, paragraphs, and code block placeholders
    const lines = html.split('\n');
    const outputLines: string[] = [];
    let inBulletList = false;
    let inNumberedList = false;

    for (const line of lines) {
      // Code block placeholders must not be wrapped in span/br
      if (/^__CODEBLOCK_\d+__$/.test(line.trim())) {
        if (inBulletList) {
          outputLines.push('</ul>');
          inBulletList = false;
        }
        if (inNumberedList) {
          outputLines.push('</ol>');
          inNumberedList = false;
        }
        outputLines.push(line.trim());
      } else if (/^[-*]\s+/.test(line)) {
        if (inNumberedList) {
          outputLines.push('</ol>');
          inNumberedList = false;
        }
        if (!inBulletList) {
          outputLines.push('<ul>');
          inBulletList = true;
        }
        outputLines.push(`<li>${line.replace(/^[-*]\s+/, '')}</li>`);
      } else if (/^\d+\.\s+/.test(line)) {
        if (inBulletList) {
          outputLines.push('</ul>');
          inBulletList = false;
        }
        if (!inNumberedList) {
          outputLines.push('<ol>');
          inNumberedList = true;
        }
        outputLines.push(`<li>${line.replace(/^\d+\.\s+/, '')}</li>`);
      } else {
        if (inBulletList) {
          outputLines.push('</ul>');
          inBulletList = false;
        }
        if (inNumberedList) {
          outputLines.push('</ol>');
          inNumberedList = false;
        }
        // Empty lines become a break; non-empty lines wrap in a span with a trailing break
        if (line === '') {
          outputLines.push('<br>');
        } else {
          outputLines.push(`<span>${line}</span><br>`);
        }
      }
    }

    // Close any still-open list
    if (inBulletList) {
      outputLines.push('</ul>');
    }
    if (inNumberedList) {
      outputLines.push('</ol>');
    }

    // Step 5: Restore code blocks from placeholders
    let result = outputLines.join('\n');
    codeBlocks.forEach((codeBlock, index) => {
      result = result.replace(`__CODEBLOCK_${index}__`, codeBlock);
    });

    return this.sanitizer.bypassSecurityTrustHtml(result);
  }
}
