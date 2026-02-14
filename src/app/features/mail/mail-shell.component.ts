import { Component, inject, OnInit, OnDestroy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AccountSwitcherComponent } from './sidebar/account-switcher.component';
import { FolderListComponent } from './sidebar/folder-list.component';
import { EmailListComponent } from './email-list/email-list.component';
import { EmailListHeaderComponent } from './email-list/email-list-header.component';
import { ReadingPaneComponent } from './reading-pane/reading-pane.component';
import { StatusBarComponent } from './status-bar/status-bar.component';
import { ResizablePanelDirective } from './resizable-panel.directive';
import { AccountsStore } from '../../store/accounts.store';
import { FoldersStore } from '../../store/folders.store';
import { EmailsStore } from '../../store/emails.store';
import { UiStore } from '../../store/ui.store';
import { ElectronService } from '../../core/services/electron.service';
import { Thread } from '../../core/models/email.model';

@Component({
  selector: 'app-mail-shell',
  standalone: true,
  imports: [
    CommonModule, RouterLink,
    AccountSwitcherComponent, FolderListComponent,
    EmailListComponent, EmailListHeaderComponent,
    ReadingPaneComponent, StatusBarComponent,
    ResizablePanelDirective,
  ],
  template: `
    <div class="mail-shell" [class.layout-bottom]="uiStore.isBottomPreview()" [class.layout-list-only]="uiStore.isListOnly()">
      <!-- Sidebar -->
      <aside
        class="sidebar"
        [class.collapsed]="uiStore.sidebarCollapsed()"
        [style.width.px]="uiStore.effectiveSidebarWidth()"
        appResizablePanel
        [minSize]="180"
        [maxSize]="400"
        (resized)="onSidebarResized($event)"
      >
        <app-account-switcher [collapsed]="uiStore.sidebarCollapsed()" />
        <app-folder-list
          [collapsed]="uiStore.sidebarCollapsed()"
          (folderSelected)="onFolderSelected($event)"
        />
        <div class="sidebar-footer">
          <button class="footer-item" (click)="uiStore.toggleSidebar()">
            <span class="material-symbols-outlined">
              {{ uiStore.sidebarCollapsed() ? 'chevron_right' : 'chevron_left' }}
            </span>
            @if (!uiStore.sidebarCollapsed()) {
              <span>Collapse</span>
            }
          </button>
          <a class="footer-item" routerLink="/settings">
            <span class="material-symbols-outlined">settings</span>
            @if (!uiStore.sidebarCollapsed()) {
              <span>Settings</span>
            }
          </a>
        </div>
      </aside>

      <!-- Main content area -->
      @if (uiStore.isThreeColumn()) {
        <!-- Three-column layout -->
        <div
          class="email-list-panel"
          [style.width.px]="uiStore.emailListWidth()"
          appResizablePanel
          [minSize]="240"
          [maxSize]="600"
          (resized)="onEmailListResized($event)"
        >
          @if (accountsStore.accountsNeedingReauth().length > 0) {
            <div class="reauth-banner">
              <span class="material-symbols-outlined">warning</span>
              <span>Some accounts need re-authentication.</span>
              <a routerLink="/settings/accounts">Fix</a>
            </div>
          }
          <app-email-list-header />
          <app-email-list (threadSelected)="onThreadSelected($event)" />
        </div>

        <div class="reading-pane-panel">
          <app-reading-pane (actionClicked)="onAction($event)" />
        </div>
      } @else if (uiStore.isBottomPreview()) {
        <!-- Bottom preview layout -->
        <div class="bottom-layout-container">
          @if (accountsStore.accountsNeedingReauth().length > 0) {
            <div class="reauth-banner">
              <span class="material-symbols-outlined">warning</span>
              <span>Some accounts need re-authentication.</span>
              <a routerLink="/settings/accounts">Fix</a>
            </div>
          }
          <div class="email-list-panel-full">
            <app-email-list-header />
            <app-email-list (threadSelected)="onThreadSelected($event)" />
          </div>

          @if (emailsStore.selectedThread()) {
            <div
              class="reading-pane-bottom"
              [style.height.%]="uiStore.readingPaneHeight()"
              appResizablePanel
              direction="vertical"
              [minSize]="150"
              [maxSize]="600"
              (resized)="onReadingPaneResized($event)"
            >
              <app-reading-pane (actionClicked)="onAction($event)" />
            </div>
          }
        </div>
      } @else {
        <!-- List only layout -->
        <div class="bottom-layout-container">
          @if (accountsStore.accountsNeedingReauth().length > 0) {
            <div class="reauth-banner">
              <span class="material-symbols-outlined">warning</span>
              <span>Some accounts need re-authentication.</span>
              <a routerLink="/settings/accounts">Fix</a>
            </div>
          }
          <div class="email-list-panel-full">
            <app-email-list-header />
            <app-email-list (threadSelected)="onThreadSelected($event)" />
          </div>
        </div>
      }

      <!-- Status Bar -->
      <app-status-bar />
    </div>
  `,
  styles: [`
    .mail-shell {
      display: flex;
      height: 100%;
      overflow: hidden;
      flex-wrap: wrap;
    }

    /* --- Sidebar --- */
    .sidebar {
      background-color: var(--color-surface-variant);
      border-right: 1px solid var(--color-border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: width 200ms cubic-bezier(0.4, 0, 0.2, 1);
      flex-shrink: 0;
    }

    .sidebar.collapsed {
      overflow: hidden;
    }

    .sidebar-footer {
      border-top: 1px solid var(--color-border);
      padding: 4px 0;
      margin-top: auto;
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
      border: none;
      background: none;
      width: 100%;
      font-size: 14px;
      font-family: inherit;

      &:hover {
        background-color: var(--color-primary-light);
      }

      .material-symbols-outlined {
        font-size: 20px;
      }
    }

    /* --- Three-column layout --- */
    .email-list-panel {
      border-right: 1px solid var(--color-border);
      display: flex;
      flex-direction: column;
      background-color: var(--color-surface);
      overflow: hidden;
      flex-shrink: 0;
    }

    .reading-pane-panel {
      flex: 1;
      background-color: var(--color-surface);
      display: flex;
      overflow: hidden;
      min-width: 300px;
    }

    /* --- Bottom preview / list-only --- */
    .bottom-layout-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background-color: var(--color-surface);
    }

    .email-list-panel-full {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 100px;
    }

    .reading-pane-bottom {
      border-top: 1px solid var(--color-border);
      display: flex;
      overflow: hidden;
      flex-shrink: 0;
    }

    /* --- Reauth banner --- */
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

    /* --- Status bar occupies full width at bottom --- */
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    app-status-bar {
      flex-shrink: 0;
    }
  `]
})
export class MailShellComponent implements OnInit, OnDestroy {
  readonly accountsStore = inject(AccountsStore);
  readonly foldersStore = inject(FoldersStore);
  readonly emailsStore = inject(EmailsStore);
  readonly uiStore = inject(UiStore);
  private readonly electronService = inject(ElectronService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private routeSub?: Subscription;
  private syncSub?: Subscription;

  constructor() {
    effect(() => {
      const activeAccount = this.accountsStore.activeAccount();
      if (activeAccount) {
        this.foldersStore.loadFolders(activeAccount.id);
        this.loadEmailsForActiveFolder(activeAccount.id);
      }
    });
  }

  ngOnInit(): void {
    this.accountsStore.loadAccounts();

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

    this.syncSub = this.electronService.onEvent<{
      accountId: string;
      progress: number;
      status: string;
    }>('mail:sync').subscribe(event => {
      this.emailsStore.updateSyncProgress(event.progress);

      if (event.status === 'done') {
        const activeAccount = this.accountsStore.activeAccount();
        if (activeAccount && String(activeAccount.id) === event.accountId) {
          this.foldersStore.loadFolders(activeAccount.id);
          this.loadEmailsForActiveFolder(activeAccount.id);
        }
      }
    });

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

  onSidebarResized(width: number): void {
    if (!this.uiStore.sidebarCollapsed()) {
      this.uiStore.setSidebarWidth(width);
    }
  }

  onEmailListResized(width: number): void {
    this.uiStore.setEmailListWidth(width);
  }

  onReadingPaneResized(height: number): void {
    // Convert pixel height to percentage of parent container
    const container = document.querySelector('.bottom-layout-container');
    if (container) {
      const percent = (height / container.clientHeight) * 100;
      this.uiStore.setReadingPaneHeight(percent);
    }
  }

  private loadEmailsForActiveFolder(accountId: number): void {
    const folderId = this.foldersStore.activeFolderId() || 'INBOX';
    this.emailsStore.loadThreads(accountId, folderId);
  }
}
