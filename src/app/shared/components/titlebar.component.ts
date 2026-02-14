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
            <svg class="titlebar-icon" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M6 11h12v2H6z"/>
            </svg>
          </button>
          <button class="titlebar-btn" (click)="onMaximize()" aria-label="Maximize">
            @if (maximized()) {
              <svg class="titlebar-icon" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M4 8h4V4h12v12h-4v4H4V8zm12 0v8h2V6h-8v2h6zM6 12v6h8v-6H6z"/>
              </svg>
            } @else {
              <svg class="titlebar-icon" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M4 4h16v16H4V4zm2 2v12h12V6H6z"/>
              </svg>
            }
          </button>
          <button class="titlebar-btn titlebar-btn-close" (click)="onClose()" aria-label="Close">
            <svg class="titlebar-icon" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 0 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4z"/>
            </svg>
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

      .titlebar-icon {
        flex-shrink: 0;
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
