import { Component, inject, output, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FoldersStore } from '../../../store/folders.store';
import { EmailsStore } from '../../../store/emails.store';
import { UiStore } from '../../../store/ui.store';
import { AiStore } from '../../../store/ai.store';
import { AiCategory } from '../../../core/models/ai.model';
import { LayoutMode, DensityMode } from '../../../core/services/layout.service';

@Component({
  selector: 'app-email-list-header',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './email-list-header.component.html',
  styleUrl: './email-list-header.component.scss',
})
export class EmailListHeaderComponent implements OnInit, OnDestroy {
  readonly foldersStore = inject(FoldersStore);
  readonly emailsStore = inject(EmailsStore);
  readonly uiStore = inject(UiStore);
  readonly aiStore = inject(AiStore);
  readonly syncClicked = output<void>();
  readonly categoryFilterChanged = output<AiCategory | null>();

  readonly activeFilter = signal<AiCategory | null>(null);

  /** Whether we have any cached categories to show the filter tabs */
  readonly hasCachedCategories = computed(() =>
    Object.keys(this.aiStore.categoryCache()).length > 0
  );

  /** Tick signal: increments every 1s so relative time is stable during change detection (computed only changes when tick or lastSyncTime changes). */
  private readonly tick = signal(0);
  private tickInterval?: ReturnType<typeof setInterval>;

  /** Computed relative time string. Depends only on signals, so same value for both CD passes → no NG0100. */
  readonly relativeTime = computed(() => {
    this.tick(); // dependency so we recalc when tick fires
    const iso = this.emailsStore.lastSyncTime();
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  });

  ngOnInit(): void {
    this.tickInterval = setInterval(() => {
      this.tick.update(v => v + 1);
    }, 1000);
  }

  ngOnDestroy(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
  }

  onSyncClick(): void {
    this.syncClicked.emit();
  }

  densityIcon(): string {
    switch (this.uiStore.density()) {
      case 'compact': return 'density_small';
      case 'comfortable': return 'density_medium';
      case 'spacious': return 'density_large';
    }
  }

  layoutIcon(): string {
    switch (this.uiStore.layout()) {
      case 'three-column': return 'view_sidebar';
      case 'bottom-preview': return 'view_agenda';
      case 'list-only': return 'view_list';
    }
  }

  cycleDensity(): void {
    const modes: DensityMode[] = ['compact', 'comfortable', 'spacious'];
    const current = modes.indexOf(this.uiStore.density());
    this.uiStore.setDensity(modes[(current + 1) % modes.length]);
  }

  cycleLayout(): void {
    const modes: LayoutMode[] = ['three-column', 'bottom-preview', 'list-only'];
    const current = modes.indexOf(this.uiStore.layout());
    this.uiStore.setLayout(modes[(current + 1) % modes.length]);
  }

  /** Categorize visible threads using AI */
  async categorizeVisible(): Promise<void> {
    const threads = this.emailsStore.threads();
    if (threads.length === 0) {
      return;
    }

    const threadData = threads.slice(0, 20).map(t => ({
      threadId: t.xGmThrid,
      content: `From: ${t.participants || 'Unknown'}\nSubject: ${t.subject || '(no subject)'}\n\n${t.snippet || ''}`,
    }));

    await this.aiStore.categorizeThreads(threadData);
  }

  /** Set the active category filter */
  setFilter(category: AiCategory | null): void {
    this.activeFilter.set(category);
    this.categoryFilterChanged.emit(category);
  }

  /** Get available categories from cached results */
  get categories(): AiCategory[] {
    return ['Primary', 'Updates', 'Promotions', 'Social', 'Newsletters'];
  }
}
