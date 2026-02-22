import { Component, inject, OnInit, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AiStore } from '../../store/ai.store';
import { AccountsStore } from '../../store/accounts.store';
import { ElectronService } from '../../core/services/electron.service';
import { Filter, FilterCondition, FilterAction } from '../../core/models/filter.model';

@Component({
  selector: 'app-filter-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './filter-settings.component.html',
  styleUrl: './filter-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FilterSettingsComponent implements OnInit {
  private readonly electronService = inject(ElectronService);
  readonly aiStore = inject(AiStore);
  readonly accountsStore = inject(AccountsStore);

  readonly filters = signal<Filter[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  // AI filter generation
  readonly aiDescription = signal('');
  readonly aiGenerating = signal(false);

  // Run Filters Now
  readonly runningFilters = signal(false);
  readonly filterResult = signal<string | null>(null);

  // Edit/create state
  readonly editingFilter = signal<Partial<Filter> | null>(null);
  readonly showEditor = signal(false);

  ngOnInit(): void {
    this.loadFilters();
  }

  async loadFilters(): Promise<void> {
    const account = this.accountsStore.activeAccount();
    if (!account) {
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    const response = await this.electronService.getFilters(account.id);
    if (response.success && response.data) {
      const data = response.data as { filters: Array<{
        id: number;
        accountId: number;
        name: string;
        conditions: string;
        actions: string;
        isEnabled: boolean;
        isAiGenerated: boolean;
        sortOrder: number;
      }> };
      this.filters.set(
        (data.filters || []).map(f => {
          let conditions: FilterCondition[] = [];
          let actions: FilterAction[] = [];
          try {
            conditions = JSON.parse(f.conditions || '[]') as FilterCondition[];
          } catch {
            conditions = [];
          }
          try {
            actions = JSON.parse(f.actions || '[]') as FilterAction[];
          } catch {
            actions = [];
          }
          return {
            ...f,
            conditions,
            actions,
            sortOrder: f.sortOrder,
          };
        })
      );
    } else {
      this.error.set(response.error?.message || 'Failed to load filters');
    }
    this.loading.set(false);
  }

  openNewFilter(): void {
    this.editingFilter.set({
      name: '',
      conditions: [],
      actions: [],
      isEnabled: true,
      isAiGenerated: false,
    });
    this.showEditor.set(true);
  }

  editFilter(filter: Filter): void {
    this.editingFilter.set({ ...filter });
    this.showEditor.set(true);
  }

  cancelEdit(): void {
    this.editingFilter.set(null);
    this.showEditor.set(false);
  }

  async saveEditingFilter(): Promise<void> {
    const filter = this.editingFilter();
    const account = this.accountsStore.activeAccount();
    if (!filter || !account) {
      return;
    }

    const payload = {
      ...filter,
      accountId: account.id,
      conditions: JSON.stringify(filter.conditions || []),
      actions: JSON.stringify(filter.actions || []),
    };

    let response;
    if (filter.id) {
      response = await this.electronService.updateFilter(payload);
    } else {
      response = await this.electronService.saveFilter({
        ...payload,
        isAiGenerated: filter.isAiGenerated || false,
      });
    }

    if (response.success) {
      this.cancelEdit();
      await this.loadFilters();
    } else {
      this.error.set(response.error?.message || 'Failed to save filter');
    }
  }

  async deleteFilter(id: number): Promise<void> {
    const response = await this.electronService.deleteFilter(id);
    if (response.success) {
      await this.loadFilters();
    } else {
      this.error.set(response.error?.message || 'Failed to delete filter');
    }
  }

  async toggleFilterEnabled(filter: Filter): Promise<void> {
    const response = await this.electronService.toggleFilter(filter.id, !filter.isEnabled);
    if (response.success) {
      this.filters.update(filters =>
        filters.map(f => f.id === filter.id ? { ...f, isEnabled: !f.isEnabled } : f)
      );
    }
  }

  /** Run all enabled filters on unfiltered INBOX emails */
  async runFiltersNow(): Promise<void> {
    const account = this.accountsStore.activeAccount();
    if (!account) {
      return;
    }

    this.runningFilters.set(true);
    this.filterResult.set(null);
    this.error.set(null);

    const response = await this.electronService.applyFilters(account.id);
    this.runningFilters.set(false);

    if (response.success && response.data) {
      const result = response.data as {
        emailsProcessed: number;
        emailsMatched: number;
        actionsDispatched: number;
        errors: number;
      };
      if (result.emailsProcessed === 0) {
        this.filterResult.set('No unfiltered emails to process');
      } else {
        this.filterResult.set(
          `Processed ${result.emailsProcessed} email${result.emailsProcessed !== 1 ? 's' : ''}, ` +
          `${result.emailsMatched} matched` +
          (result.errors > 0 ? `, ${result.errors} error${result.errors !== 1 ? 's' : ''}` : '')
        );
      }
    } else {
      this.error.set(response.error?.message || 'Failed to run filters');
    }
  }

  /** Use AI to generate a filter from natural language description */
  async generateWithAi(): Promise<void> {
    const description = this.aiDescription().trim();
    const account = this.accountsStore.activeAccount();
    if (!description || !account) {
      return;
    }

    this.aiGenerating.set(true);
    this.error.set(null);

    const result = await this.aiStore.generateFilter(description, account.id);
    this.aiGenerating.set(false);

    if (result) {
      this.editingFilter.set({
        name: result.name,
        conditions: result.conditions as FilterCondition[],
        actions: result.actions as FilterAction[],
        isEnabled: true,
        isAiGenerated: true,
      });
      this.showEditor.set(true);
      this.aiDescription.set('');
    }
  }

  // Helper to add a condition to the editing filter
  addCondition(): void {
    const filter = this.editingFilter();
    if (!filter) {
      return;
    }
    const conditions = [...(filter.conditions || []), { field: 'from' as const, operator: 'contains' as const, value: '' }];
    this.editingFilter.set({ ...filter, conditions });
  }

  removeCondition(index: number): void {
    const filter = this.editingFilter();
    if (!filter) {
      return;
    }
    const conditions = [...(filter.conditions || [])];
    conditions.splice(index, 1);
    this.editingFilter.set({ ...filter, conditions });
  }

  updateCondition(index: number, field: string, value: string): void {
    const filter = this.editingFilter();
    if (!filter) {
      return;
    }
    const conditions = [...(filter.conditions || [])] as FilterCondition[];
    conditions[index] = { ...conditions[index], [field]: value };
    this.editingFilter.set({ ...filter, conditions });
  }

  // Helper to add an action to the editing filter
  addAction(): void {
    const filter = this.editingFilter();
    if (!filter) {
      return;
    }
    const actions = [...(filter.actions || []), { type: 'mark-read' as const }];
    this.editingFilter.set({ ...filter, actions });
  }

  removeAction(index: number): void {
    const filter = this.editingFilter();
    if (!filter) {
      return;
    }
    const actions = [...(filter.actions || [])];
    actions.splice(index, 1);
    this.editingFilter.set({ ...filter, actions });
  }

  updateAction(index: number, field: string, value: string): void {
    const filter = this.editingFilter();
    if (!filter) {
      return;
    }
    const actions = [...(filter.actions || [])] as FilterAction[];
    actions[index] = { ...actions[index], [field]: value };
    this.editingFilter.set({ ...filter, actions });
  }

  updateFilterName(name: string): void {
    const filter = this.editingFilter();
    if (filter) {
      this.editingFilter.set({ ...filter, name });
    }
  }

  conditionFieldLabel(field: string): string {
    const labels: Record<string, string> = {
      from: 'From',
      to: 'To',
      subject: 'Subject',
      body: 'Body',
      'has-attachment': 'Has Attachment',
    };
    return labels[field] || field;
  }

  actionTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      archive: 'Archive',
      delete: 'Delete',
      star: 'Star',
      'mark-read': 'Mark Read',
      move: 'Move to',
    };
    return labels[type] || type;
  }

  /** Move a filter up in priority (lower sort_order = higher priority) */
  async moveFilterUp(filter: Filter): Promise<void> {
    const currentFilters = this.filters();
    const index = currentFilters.findIndex(f => f.id === filter.id);
    if (index <= 0) {
      return;
    }

    const above = currentFilters[index - 1];
    // Swap sort_order values
    const aboveOrder = above.sortOrder ?? index - 1;
    const currentOrder = filter.sortOrder ?? index;

    await Promise.all([
      this.electronService.updateFilter({
        id: filter.id,
        name: filter.name,
        conditions: JSON.stringify(filter.conditions),
        actions: JSON.stringify(filter.actions),
        isEnabled: filter.isEnabled,
        sortOrder: aboveOrder,
      }),
      this.electronService.updateFilter({
        id: above.id,
        name: above.name,
        conditions: JSON.stringify(above.conditions),
        actions: JSON.stringify(above.actions),
        isEnabled: above.isEnabled,
        sortOrder: currentOrder,
      }),
    ]);

    await this.loadFilters();
  }

  /** Move a filter down in priority (higher sort_order = lower priority) */
  async moveFilterDown(filter: Filter): Promise<void> {
    const currentFilters = this.filters();
    const index = currentFilters.findIndex(f => f.id === filter.id);
    if (index < 0 || index >= currentFilters.length - 1) {
      return;
    }

    const below = currentFilters[index + 1];
    // Swap sort_order values
    const belowOrder = below.sortOrder ?? index + 1;
    const currentOrder = filter.sortOrder ?? index;

    await Promise.all([
      this.electronService.updateFilter({
        id: filter.id,
        name: filter.name,
        conditions: JSON.stringify(filter.conditions),
        actions: JSON.stringify(filter.actions),
        isEnabled: filter.isEnabled,
        sortOrder: belowOrder,
      }),
      this.electronService.updateFilter({
        id: below.id,
        name: below.name,
        conditions: JSON.stringify(below.conditions),
        actions: JSON.stringify(below.actions),
        isEnabled: below.isEnabled,
        sortOrder: currentOrder,
      }),
    ]);

    await this.loadFilters();
  }
}
