import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'app-settings-shell',
  standalone: true,
  imports: [CommonModule, RouterLink, MatButtonModule],
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
          <div class="nav-item active">
            <span class="material-symbols-outlined">settings</span>
            General
          </div>
          <div class="nav-item">
            <span class="material-symbols-outlined">account_circle</span>
            Accounts
          </div>
          <div class="nav-item">
            <span class="material-symbols-outlined">auto_awesome</span>
            AI
          </div>
          <div class="nav-item">
            <span class="material-symbols-outlined">keyboard</span>
            Keyboard
          </div>
          <div class="nav-item">
            <span class="material-symbols-outlined">notifications</span>
            Notifications
          </div>
          <div class="nav-item">
            <span class="material-symbols-outlined">draw</span>
            Signatures
          </div>
          <div class="nav-item">
            <span class="material-symbols-outlined">filter_list</span>
            Filters
          </div>
        </nav>
        <div class="settings-content">
          <h2>General Settings</h2>
          <p class="placeholder">Settings content will be implemented in Phase 4.</p>
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

      &:hover {
        background-color: var(--color-surface-variant);
      }

      &.active {
        background-color: var(--color-primary-light);
        color: var(--color-primary);
        font-weight: 500;
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

    h2 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 16px;
    }

    .placeholder {
      color: var(--color-text-tertiary);
    }
  `]
})
export class SettingsShellComponent {}
