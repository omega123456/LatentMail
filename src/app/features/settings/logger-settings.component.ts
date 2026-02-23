import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { SettingsStore } from '../../store/settings.store';
import { ElectronService } from '../../core/services/electron.service';

export interface LogEntry {
  date: string;
  level: string;
  message: string;
}

@Component({
  selector: 'app-logger-settings',
  standalone: true,
  imports: [
    CommonModule,
    MatSelectModule,
    MatFormFieldModule,
    MatButtonModule,
    MatInputModule,
  ],
  templateUrl: './logger-settings.component.html',
  styleUrl: './logger-settings.component.scss',
})
export class LoggerSettingsComponent implements OnInit {
  readonly settingsStore = inject(SettingsStore);
  readonly electronService = inject(ElectronService);

  readonly logEntries = signal<LogEntry[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly searchQuery = signal('');

  readonly filteredLogEntries = computed(() => {
    const entries = this.logEntries();
    const query = this.searchQuery().trim().toLowerCase();
    if (query === '') {
      return entries;
    }
    return entries.filter(
      (entry) =>
        entry.message.toLowerCase().includes(query) ||
        entry.level.toLowerCase().includes(query)
    );
  });

  ngOnInit(): void {
    this.settingsStore.loadSettings();
    this.loadLogEntries();
  }

  async loadLogEntries(): Promise<void> {
    if (!this.electronService.isElectron) {
      this.error.set('Log viewer is only available in the desktop app.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    const res = await this.electronService.getRecentLogEntries();
    this.loading.set(false);
    if (res.success && res.data && typeof res.data === 'object' && 'entries' in res.data) {
      const entries = (res.data as { entries: LogEntry[] }).entries;
      this.logEntries.set(Array.isArray(entries) ? entries : []);
    } else {
      this.logEntries.set([]);
      if (!res.success && res.error) {
        this.error.set(res.error.message ?? 'Failed to load log entries');
      }
    }
  }
}
