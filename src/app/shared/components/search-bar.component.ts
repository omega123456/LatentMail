import { Component, effect, inject, signal, output, OnInit, OnDestroy, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AiStore } from '../../store/ai.store';
import { AccountsStore } from '../../store/accounts.store';
import { EmailsStore } from '../../store/emails.store';
import { FoldersStore } from '../../store/folders.store';

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
  readonly accountsStore = inject(AccountsStore);
  readonly emailsStore = inject(EmailsStore);
  readonly foldersStore = inject(FoldersStore);
  readonly searchExecuted = output<{ queries: string[]; originalQuery: string; streaming?: boolean }>();
  readonly searchCleared = output<void>();

  readonly query = signal('');
  readonly searchMode = signal<'keyword' | 'semantic'>('keyword');
  readonly focused = signal(false);

  private keydownHandler?: (e: KeyboardEvent) => void;

  constructor() {
    // Show semantic option only when Ollama is available and full search index is built; otherwise force keyword
    effect(() => {
      const available = this.aiStore.isAvailable();
      const indexReady = this.aiStore.indexStatus() === 'complete';
      this.searchMode.set(available && indexReady ? 'semantic' : 'keyword');
    });
  }

  ngOnInit(): void {
    this.aiStore.checkStatus();
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

  setSearchMode(mode: 'keyword' | 'semantic'): void {
    this.searchMode.set(mode);
  }

  async onSearch(): Promise<void> {
    const q = this.query().trim();
    if (!q) {
      return;
    }

    // Guard: do not start a new search while a streaming search is in progress
    if (this.aiStore.searchStreamStatus() === 'searching') {
      return;
    }

    const originalQuery = q;
    const accountId = this.accountsStore.activeAccountId();
    if (!accountId) {
      return;
    }

    const folderNames = Array.from(
      new Set(
        this.foldersStore
          .folders()
          .flatMap((folder) => [folder.gmailLabelId, folder.name])
          .map((folderName) => folderName.trim())
          .filter((folderName) => folderName.length > 0)
      )
    );

    // Activate search mode and clear thread list before starting the backend search.
    // This ensures the first batch (e.g. local-only results) is never applied before the
    // clear, which would then be wiped when onSearch runs after the IPC returns.
    this.foldersStore.activateSearch(originalQuery, originalQuery);
    this.emailsStore.clearThreadsForStreaming();
    this.emailsStore.clearSelection();

    const result = await this.aiStore.startStreamingSearch(String(accountId), q, folderNames, this.searchMode());
    if (result) {
      this.searchExecuted.emit({ queries: [q], originalQuery, streaming: true });
    }
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
