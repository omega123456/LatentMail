import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-mail-shell',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="mail-shell">
      <aside class="sidebar">
        <div class="sidebar-header">
          <span class="material-symbols-outlined">account_circle</span>
          <span>Accounts</span>
        </div>
        <nav class="folder-list">
          <div class="folder-item active">
            <span class="material-symbols-outlined">inbox</span>
            <span>Inbox</span>
          </div>
          <div class="folder-item">
            <span class="material-symbols-outlined">edit_note</span>
            <span>Drafts</span>
          </div>
          <div class="folder-item">
            <span class="material-symbols-outlined">send</span>
            <span>Sent</span>
          </div>
          <div class="folder-item">
            <span class="material-symbols-outlined">archive</span>
            <span>Archive</span>
          </div>
          <div class="folder-item">
            <span class="material-symbols-outlined">report</span>
            <span>Spam</span>
          </div>
          <div class="folder-item">
            <span class="material-symbols-outlined">delete</span>
            <span>Trash</span>
          </div>
        </nav>
      </aside>
      <div class="email-list">
        <div class="email-list-header">
          <span>Inbox</span>
        </div>
        <div class="email-list-empty">
          <span class="material-symbols-outlined">inbox</span>
          <p>No emails yet</p>
          <p class="hint">Connect a Gmail account to get started</p>
        </div>
      </div>
      <div class="reading-pane">
        <div class="reading-pane-empty">
          <span class="material-symbols-outlined">mail</span>
          <p>Select an email to read</p>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .mail-shell {
      display: flex;
      height: 100%;
      overflow: hidden;
    }

    .sidebar {
      width: var(--sidebar-width, 240px);
      background-color: var(--color-surface-variant);
      border-right: 1px solid var(--color-border);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }

    .sidebar-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 16px;
      font-weight: 500;
    }

    .folder-list {
      flex: 1;
    }

    .folder-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      cursor: pointer;
      color: var(--color-text-primary);
      transition: background-color 120ms ease;

      &:hover {
        background-color: var(--color-primary-light);
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

    .email-list {
      width: var(--email-list-width, 320px);
      border-right: 1px solid var(--color-border);
      display: flex;
      flex-direction: column;
      background-color: var(--color-surface);
    }

    .email-list-header {
      padding: 12px 16px;
      font-weight: 600;
      font-size: 16px;
      border-bottom: 1px solid var(--color-border);
    }

    .email-list-empty, .reading-pane-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--color-text-tertiary);
      gap: 8px;

      .material-symbols-outlined {
        font-size: 48px;
        opacity: 0.5;
      }

      p {
        font-size: 14px;
      }

      .hint {
        font-size: 12px;
      }
    }

    .reading-pane {
      flex: 1;
      background-color: var(--color-surface);
      display: flex;
    }
  `]
})
export class MailShellComponent {}
