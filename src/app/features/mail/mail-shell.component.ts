import { Component, inject, OnInit, OnDestroy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AccountSwitcherComponent } from './sidebar/account-switcher.component';
import { FolderListComponent } from './sidebar/folder-list.component';
import { EmailListComponent } from './email-list/email-list.component';
import { ReadingPaneComponent } from './reading-pane/reading-pane.component';
import { AccountsStore } from '../../store/accounts.store';
import { FoldersStore } from '../../store/folders.store';
import { EmailsStore } from '../../store/emails.store';
import { ElectronService } from '../../core/services/electron.service';
import { Thread } from '../../core/models/email.model';

@Component({
  selector: 'app-mail-shell',
  standalone: true,
  imports: [
    CommonModule, RouterLink,
    AccountSwitcherComponent, FolderListComponent,
    EmailListComponent, ReadingPaneComponent,
  ],
  template: `
    <div class="mail-shell">
      <aside class="sidebar">
        <app-account-switcher />
        <app-folder-list (folderSelected)="onFolderSelected($event)" />
        <div class="sidebar-footer">
          <a class="footer-item" routerLink="/settings">
            <span class="material-symbols-outlined">settings</span>
            <span>Settings</span>
          </a>
        </div>
      </aside>

      <div class="email-list-panel">
        @if (accountsStore.accountsNeedingReauth().length > 0) {
          <div class="reauth-banner">
            <span class="material-symbols-outlined">warning</span>
            <span>Some accounts need re-authentication.</span>
            <a routerLink="/settings/accounts">Fix</a>
          </div>
        }
        <app-email-list (threadSelected)="onThreadSelected($event)" />
      </div>

      <div class="reading-pane-panel">
        <app-reading-pane (actionClicked)="onAction($event)" />
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

    .sidebar-footer {
      border-top: 1px solid var(--color-border);
      padding: 4px 0;
    }

    .footer-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      cursor: pointer;
      color: var(--color-text-primary);
      text-decoration: none;
      transition: background-color 120ms ease;

      &:hover {
        background-color: var(--color-primary-light);
      }

      .material-symbols-outlined {
        font-size: 20px;
      }
    }

    .email-list-panel {
      width: var(--email-list-width, 320px);
      border-right: 1px solid var(--color-border);
      display: flex;
      flex-direction: column;
      background-color: var(--color-surface);
      overflow: hidden;
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

    .reading-pane-panel {
      flex: 1;
      background-color: var(--color-surface);
      display: flex;
      overflow: hidden;
    }
  `]
})
export class MailShellComponent implements OnInit, OnDestroy {
  readonly accountsStore = inject(AccountsStore);
  readonly foldersStore = inject(FoldersStore);
  readonly emailsStore = inject(EmailsStore);
  private readonly electronService = inject(ElectronService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private routeSub?: Subscription;
  private syncSub?: Subscription;

  constructor() {
    // When active account changes, load folders and emails
    effect(() => {
      const activeAccount = this.accountsStore.activeAccount();
      if (activeAccount) {
        this.foldersStore.loadFolders(activeAccount.id);
        this.loadEmailsForActiveFolder(activeAccount.id);
      }
    });
  }

  ngOnInit(): void {
    // Load accounts
    this.accountsStore.loadAccounts();

    // Subscribe to route params
    this.routeSub = this.route.params.subscribe(params => {
      const accountId = params['accountId'];
      const folderId = params['folderId'];
      const threadId = params['threadId'];

      if (accountId) {
        this.accountsStore.setActiveAccount(Number(accountId));
      }
      if (folderId) {
        this.foldersStore.setActiveFolder(folderId);
      }
      if (threadId) {
        const activeAccount = this.accountsStore.activeAccount();
        if (activeAccount) {
          this.emailsStore.loadThread(activeAccount.id, threadId);
        }
      }
    });

    // Listen for sync progress events
    this.syncSub = this.electronService.onEvent<{
      accountId: string;
      progress: number;
      status: string;
    }>('mail:sync').subscribe(event => {
      this.emailsStore.updateSyncProgress(event.progress);

      // Reload data when sync completes
      if (event.status === 'done') {
        const activeAccount = this.accountsStore.activeAccount();
        if (activeAccount && String(activeAccount.id) === event.accountId) {
          this.foldersStore.loadFolders(activeAccount.id);
          this.loadEmailsForActiveFolder(activeAccount.id);
        }
      }
    });

    // Trigger sync for active account
    const activeAccount = this.accountsStore.activeAccount();
    if (activeAccount) {
      this.emailsStore.syncAccount(activeAccount.id);
    }
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.syncSub?.unsubscribe();
  }

  onFolderSelected(folderId: string): void {
    const activeAccount = this.accountsStore.activeAccount();
    if (activeAccount) {
      this.emailsStore.clearSelection();
      this.emailsStore.loadThreads(activeAccount.id, folderId);
      this.router.navigate(['/mail', activeAccount.id, folderId]);
    }
  }

  onThreadSelected(thread: Thread): void {
    const activeAccount = this.accountsStore.activeAccount();
    if (activeAccount) {
      this.emailsStore.loadThread(activeAccount.id, thread.gmailThreadId);

      // Mark as read
      if (!thread.isRead) {
        this.emailsStore.flagEmails(
          activeAccount.id,
          [thread.gmailThreadId],
          'read',
          true
        );
      }

      this.router.navigate([
        '/mail', activeAccount.id,
        this.foldersStore.activeFolderId() || 'INBOX',
        thread.gmailThreadId
      ]);
    }
  }

  onAction(action: string): void {
    const thread = this.emailsStore.selectedThread();
    const activeAccount = this.accountsStore.activeAccount();
    if (!thread || !activeAccount) return;

    switch (action) {
      case 'archive':
        this.emailsStore.moveEmails(activeAccount.id, [thread.gmailThreadId], '[Gmail]/All Mail');
        this.emailsStore.clearSelection();
        break;
      case 'delete':
        this.emailsStore.moveEmails(activeAccount.id, [thread.gmailThreadId], '[Gmail]/Trash');
        this.emailsStore.clearSelection();
        break;
      case 'reply':
      case 'reply-all':
      case 'forward':
        // Compose functionality — Phase 5
        break;
    }
  }

  private loadEmailsForActiveFolder(accountId: number): void {
    const folderId = this.foldersStore.activeFolderId() || 'INBOX';
    this.emailsStore.loadThreads(accountId, folderId);
  }
}
