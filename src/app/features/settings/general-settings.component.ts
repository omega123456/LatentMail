import { Component, inject, OnInit, signal, computed, effect, untracked, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatRadioModule } from '@angular/material/radio';
import { MatSlideToggleModule, MatSlideToggleChange } from '@angular/material/slide-toggle';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { ThemeService, ThemeMode } from '../../core/services/theme.service';
import { UiStore } from '../../store/ui.store';
import { SettingsStore } from '../../store/settings.store';
import { LayoutMode, DensityMode } from '../../core/services/layout.service';

@Component({
  selector: 'app-general-settings',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatRadioModule, MatSlideToggleModule,
    MatSelectModule, MatFormFieldModule,
    MatInputModule, MatButtonModule,
    MatPaginatorModule,
  ],
  templateUrl: './general-settings.component.html',
  styleUrl: './general-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeneralSettingsComponent implements OnInit {
  readonly themeService = inject(ThemeService);
  readonly uiStore = inject(UiStore);
  readonly settingsStore = inject(SettingsStore);

  readonly pageSizeOptions = [5, 10, 25];

  readonly filterText = signal('');
  readonly pageIndex = signal(0);
  readonly pageSize = signal(10);

  readonly alwaysAllowImages = computed(() => !this.settingsStore.blockRemoteImages());

  readonly filteredSenders = computed(() => {
    const allSenders = this.settingsStore.allowedImageSenders();
    const rawFilter = this.filterText();
    const normalizedFilter = rawFilter.toLowerCase().trim();
    if (!normalizedFilter) {
      return allSenders;
    }
    return allSenders.filter((sender) => sender.includes(normalizedFilter));
  });

  readonly paginatedSenders = computed(() => {
    const senders = this.filteredSenders();
    const start = this.pageIndex() * this.pageSize();
    return senders.slice(start, start + this.pageSize());
  });

  constructor() {
    effect(() => {
      const total = this.filteredSenders().length;
      untracked(() => {
        const currentIndex = this.pageIndex();
        const currentSize = this.pageSize();
        if (total > 0 && currentIndex * currentSize >= total) {
          this.pageIndex.set(0);
        }
      });
    });
  }

  ngOnInit(): void {
    this.settingsStore.loadSettings();
  }

  onThemeChange(mode: ThemeMode): void {
    this.themeService.setTheme(mode);
    this.settingsStore.setTheme(mode);
  }

  onLayoutChange(mode: LayoutMode): void {
    this.uiStore.setLayout(mode);
    this.settingsStore.setLayout(mode);
  }

  onDensityChange(mode: DensityMode): void {
    this.uiStore.setDensity(mode);
    this.settingsStore.setDensity(mode);
  }

  onAlwaysAllowToggle(event: MatSlideToggleChange): void {
    this.settingsStore.updateSetting('blockRemoteImages', String(!event.checked));
  }

  onFilterChange(value: string): void {
    this.filterText.set(value);
    this.pageIndex.set(0);
  }

  onPage(event: PageEvent): void {
    this.pageIndex.set(event.pageIndex);
    this.pageSize.set(event.pageSize);
  }
}
