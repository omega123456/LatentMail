import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AiStore } from '../../store/ai.store';

@Component({
  selector: 'app-ai-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ai-settings.component.html',
  styleUrl: './ai-settings.component.scss',
})
export class AiSettingsComponent implements OnInit {
  readonly aiStore = inject(AiStore);
  readonly urlInput = signal('');
  readonly testingConnection = signal(false);

  ngOnInit(): void {
    this.urlInput.set(this.aiStore.url());
    this.aiStore.checkStatus();
    this.aiStore.loadModels();
  }

  async saveUrl(): Promise<void> {
    const url = this.urlInput().trim();
    if (!url) {
      return;
    }
    this.testingConnection.set(true);
    await this.aiStore.setUrl(url);
    await this.aiStore.loadModels();
    this.testingConnection.set(false);
  }

  async testConnection(): Promise<void> {
    this.testingConnection.set(true);
    await this.aiStore.checkStatus();
    await this.aiStore.loadModels();
    this.testingConnection.set(false);
  }

  async selectModel(modelName: string): Promise<void> {
    await this.aiStore.setModel(modelName);
  }

  formatSize(bytes?: number): string {
    if (!bytes) {
      return '';
    }
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) {
      return `${gb.toFixed(1)} GB`;
    }
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
  }
}
