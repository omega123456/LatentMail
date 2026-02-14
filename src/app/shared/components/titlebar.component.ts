import { Component, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ElectronService } from '../../core/services/electron.service';

@Component({
  selector: 'app-titlebar',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (isWindows()) {
      <div class="titlebar no-select">
        <div class="titlebar-drag">
          <span class="titlebar-title">MailClient</span>
        </div>
        <div class="titlebar-controls">
          <button class="titlebar-btn" (click)="onMinimize()" aria-label="Minimize">
            <span class="material-symbols-outlined">remove</span>
          </button>
          <button class="titlebar-btn" (click)="onMaximize()" aria-label="Maximize">
            <span class="material-symbols-outlined">{{ maximized() ? 'filter_none' : 'crop_square' }}</span>
          </button>
          <button class="titlebar-btn titlebar-btn-close" (click)="onClose()" aria-label="Close">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
      </div>
    }
  `,
  styles: [`
    .titlebar {
      display: flex;
      align-items: center;
      height: var(--titlebar-height, 32px);
      background-color: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
      font-size: 12px;
      color: var(--color-text-primary);
    }

    .titlebar-drag {
      flex: 1;
      display: flex;
      align-items: center;
      padding-left: 12px;
      -webkit-app-region: drag;
      height: 100%;
    }

    .titlebar-title {
      font-weight: 600;
      font-size: 13px;
    }

    .titlebar-controls {
      display: flex;
      height: 100%;
      -webkit-app-region: no-drag;
    }

    .titlebar-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 46px;
      height: 100%;
      border: none;
      background: transparent;
      color: var(--color-text-primary);
      cursor: pointer;
      transition: background-color 120ms ease;

      &:hover {
        background-color: var(--color-surface-variant);
      }

      .material-symbols-outlined {
        font-size: 16px;
      }
    }

    .titlebar-btn-close:hover {
      background-color: var(--color-error);
      color: white;
    }
  `]
})
export class TitlebarComponent implements OnInit {
  isWindows = signal(false);
  maximized = signal(false);

  constructor(private electronService: ElectronService) {}

  async ngOnInit(): Promise<void> {
    const platform = await this.electronService.getPlatform();
    this.isWindows.set(platform === 'win32');
  }

  async onMinimize(): Promise<void> {
    await this.electronService.minimize();
  }

  async onMaximize(): Promise<void> {
    await this.electronService.maximize();
    this.maximized.set(await this.electronService.isMaximized());
  }

  async onClose(): Promise<void> {
    await this.electronService.closeWindow();
  }
}
