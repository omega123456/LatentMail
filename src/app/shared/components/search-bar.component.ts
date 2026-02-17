import { Component, inject, signal, output, OnInit, OnDestroy, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AiStore } from '../../store/ai.store';

@Component({
  selector: 'app-search-bar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './search-bar.component.html',
  styleUrl: './search-bar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchBarComponent implements OnInit, OnDestroy {
  readonly aiStore = inject(AiStore);
  readonly searchExecuted = output<string>();
  readonly searchCleared = output<void>();

  readonly query = signal('');
  readonly aiMode = signal(false);
  readonly focused = signal(false);

  private keydownHandler?: (e: KeyboardEvent) => void;

  ngOnInit(): void {
    this.keydownHandler = (e: KeyboardEvent) => {
      // Ctrl+F or Cmd+F: focus search bar
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        const input = document.querySelector('.search-bar-input') as HTMLInputElement;
        if (input) {
          input.focus();
        }
      }
    };
    document.addEventListener('keydown', this.keydownHandler);
  }

  ngOnDestroy(): void {
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
    }
  }

  toggleAiMode(): void {
    this.aiMode.update(v => !v);
  }

  async onSearch(): Promise<void> {
    const q = this.query().trim();
    if (!q) {
      return;
    }

    if (this.aiMode() && this.aiStore.isAvailable()) {
      // Use AI to convert natural language to search params
      const result = await this.aiStore.aiSearch(q);
      if (result) {
        // If AI returned a gmraw query, use it directly;
        // otherwise convert structured params to Gmail-style query string
        if (result.gmraw) {
          this.searchExecuted.emit(result.gmraw);
        } else if (result.structured) {
          const searchQuery = this.structuredToGmraw(result.structured);
          this.searchExecuted.emit(searchQuery);
        } else {
          // Fallback: use original query
          this.searchExecuted.emit(q);
        }
      }
    } else {
      // Direct search
      this.searchExecuted.emit(q);
    }
  }

  /** Convert structured search params to a Gmail-style raw query string */
  private structuredToGmraw(params: Record<string, unknown>): string {
    const parts: string[] = [];
    if (params['from'] && typeof params['from'] === 'string') {
      parts.push(`from:${params['from']}`);
    }
    if (params['to'] && typeof params['to'] === 'string') {
      parts.push(`to:${params['to']}`);
    }
    if (params['subject'] && typeof params['subject'] === 'string') {
      parts.push(`subject:${params['subject']}`);
    }
    if (params['since'] && typeof params['since'] === 'string') {
      parts.push(`after:${params['since']}`);
    }
    if (params['before'] && typeof params['before'] === 'string') {
      parts.push(`before:${params['before']}`);
    }
    if (params['hasAttachment'] === true) {
      parts.push('has:attachment');
    }
    if (params['isRead'] === true) {
      parts.push('is:read');
    } else if (params['isRead'] === false) {
      parts.push('is:unread');
    }
    if (params['isStarred'] === true) {
      parts.push('is:starred');
    }
    return parts.length > 0 ? parts.join(' ') : '';
  }

  onClear(): void {
    this.query.set('');
    this.searchCleared.emit();
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      this.onSearch();
    } else if (event.key === 'Escape') {
      if (this.query()) {
        this.onClear();
      } else {
        (event.target as HTMLElement).blur();
      }
    }
  }
}
