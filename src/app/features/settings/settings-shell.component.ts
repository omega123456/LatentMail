import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'app-settings-shell',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, RouterOutlet, MatButtonModule],
  template: `
    <div class="settings-shell">
      <div class="settings-header">
        <a routerLink="/mail" class="back-link">
          <span class="material-symbols-outlined">arrow_back</span>
          Back to Mail
        </a>
        <h1>Settings</h1>
      </div>
      <div class="settings-body">
        <nav class="settings-nav">
          <a class="nav-item" routerLink="general" routerLinkActive="active">
            <span class="material-symbols-outlined">settings</span>
            General
          </a>
          <a class="nav-item" routerLink="accounts" routerLinkActive="active">
            <span class="material-symbols-outlined">account_circle</span>
            Accounts
          </a>
          <a class="nav-item disabled">
            <span class="material-symbols-outlined">auto_awesome</span>
            AI
          </a>
          <a class="nav-item disabled">
            <span class="material-symbols-outlined">keyboard</span>
            Keyboard
          </a>
          <a class="nav-item disabled">
            <span class="material-symbols-outlined">notifications</span>
            Notifications
          </a>
          <a class="nav-item disabled">
            <span class="material-symbols-outlined">draw</span>
            Signatures
          </a>
          <a class="nav-item disabled">
            <span class="material-symbols-outlined">filter_list</span>
            Filters
          </a>
          <a class="nav-item" routerLink="queue" routerLinkActive="active">
            <span class="material-symbols-outlined">pending_actions</span>
            Queue
          </a>
        </nav>
        <div class="settings-content">
          <router-outlet />
        </div>
      </div>
    </div>
  `,
  styles: [`
    .settings-shell {
      height: 100%;
      display: flex;
      flex-direction: column;
      background-color: var(--color-background);
    }

    .settings-header {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 12px 24px;
      border-bottom: 1px solid var(--color-border);
      background-color: var(--color-surface);
    }

    .back-link {
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--color-primary);
      text-decoration: none;
      font-size: 14px;
    }

    h1 {
      font-size: 20px;
      font-weight: 600;
    }

    .settings-body {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    .settings-nav {
      width: 200px;
      padding: 16px 0;
      border-right: 1px solid var(--color-border);
      background-color: var(--color-surface);
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 24px;
      cursor: pointer;
      color: var(--color-text-primary);
      font-size: 14px;
      transition: background-color 120ms ease;
      text-decoration: none;

      &:hover:not(.disabled) {
        background-color: var(--color-surface-variant);
      }

      &.active {
        background-color: var(--color-primary-light);
        color: var(--color-primary);
        font-weight: 500;
      }

      &.disabled {
        color: var(--color-text-tertiary);
        cursor: default;
        pointer-events: none;
      }

      .material-symbols-outlined {
        font-size: 20px;
      }
    }

    .settings-content {
      flex: 1;
      padding: 24px 32px;
      overflow-y: auto;
    }
  `]
})
export class SettingsShellComponent {}
