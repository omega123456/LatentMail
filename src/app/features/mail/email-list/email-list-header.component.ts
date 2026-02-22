import { Component, inject, output, signal, computed } from '@angular/core';
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
export class EmailListHeaderComponent {
  readonly foldersStore = inject(FoldersStore);
  readonly emailsStore = inject(EmailsStore);
  readonly uiStore = inject(UiStore);
  readonly aiStore = inject(AiStore);
  readonly categoryFilterChanged = output<AiCategory | null>();

  readonly activeFilter = signal<AiCategory | null>(null);

  /** Whether we have any cached categories to show the filter tabs */
  readonly hasCachedCategories = computed(() =>
    Object.keys(this.aiStore.categoryCache()).length > 0
  );

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
