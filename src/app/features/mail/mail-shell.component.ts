import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AccountSwitcherComponent } from './sidebar/account-switcher.component';
import { AccountsStore } from '../../store/accounts.store';

@Component({
  selector: 'app-mail-shell',
  standalone: true,
  imports: [CommonModule, RouterLink, AccountSwitcherComponent],
  template: `
    <div class="mail-shell">
      <aside class="sidebar">
        <app-account-switcher />
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
        <div class="sidebar-footer">
          <a class="folder-item" routerLink="/settings">
            <span class="material-symbols-outlined">settings</span>
            <span>Settings</span>
          </a>
        </div>
      </aside>
      <div class="email-list">
        <div class="email-list-header">
          <span>Inbox</span>
        </div>

        @if (accountsStore.accountsNeedingReauth().length > 0) {
          <div class="reauth-banner">
            <span class="material-symbols-outlined">warning</span>
            <span>Some accounts need re-authentication.</span>
            <a routerLink="/settings/accounts">Fix</a>
          </div>
        }

        <div class="email-list-empty">
          <span class="material-symbols-outlined">inbox</span>
          <p>No emails yet</p>
          <p class="hint">Email sync will begin after connecting a Gmail account</p>
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
      text-decoration: none;

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

    .sidebar-footer {
      border-top: 1px solid var(--color-border);
      padding: 4px 0;
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

    .reauth-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background-color: #FFF3E0;
      font-size: 12px;
      color: #E65100;
      border-bottom: 1px solid #FFE0B2;

      .material-symbols-outlined {
        font-size: 16px;
      }

      a {
        color: var(--color-primary);
        font-weight: 500;
        text-decoration: none;
        margin-left: auto;
      }
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
export class MailShellComponent implements OnInit {
  readonly accountsStore = inject(AccountsStore);

  ngOnInit(): void {
    this.accountsStore.loadAccounts();
  }
}
