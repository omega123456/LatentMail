import { Component, effect, inject, signal, output, OnInit, OnDestroy, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AiStore } from '../../store/ai.store';
import { AccountsStore } from '../../store/accounts.store';
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
  readonly foldersStore = inject(FoldersStore);
  readonly searchExecuted = output<{ queries: string[]; originalQuery: string; semanticResults?: string[]; streaming?: boolean }>();
  readonly searchCleared = output<void>();

  readonly query = signal('');
  readonly aiMode = signal(false);
  readonly focused = signal(false);

  private keydownHandler?: (e: KeyboardEvent) => void;

  constructor() {
    // Default to AI search when Ollama is available; turn off when connection is down
    effect(() => {
      const available = this.aiStore.isAvailable();
      this.aiMode.set(available);
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

  toggleAiMode(): void {
    this.aiMode.update(v => !v);
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

    if (this.aiMode() && this.aiStore.isAvailable()) {
      // Use AI streaming semantic search
      const accountId = this.accountsStore.activeAccountId();
      if (!accountId) {
        // Fallback: use original query if no active account
        this.searchExecuted.emit({ queries: [q], originalQuery });
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

      const result = await this.aiStore.startStreamingSearch(String(accountId), q, folderNames);
      if (result) {
        // Streaming search started — emit event with streaming flag so mail-shell
        // activates search mode immediately without waiting for results
        this.searchExecuted.emit({
          queries: [q],
          originalQuery,
          streaming: true,
        });
      } else {
        // startStreamingSearch returned null (locked or IPC failed) — fallback to keyword search
        this.searchExecuted.emit({ queries: [q], originalQuery });
      }
    } else {
      // Direct keyword search — query and originalQuery are the same
      this.searchExecuted.emit({ queries: [q], originalQuery });
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
