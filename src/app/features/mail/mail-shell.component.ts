import { Component, inject, OnInit, OnDestroy } from '@angular/core';
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
import { ComposeWindowComponent } from '../compose/compose-window.component';
import { AccountsStore } from '../../store/accounts.store';
import { FoldersStore } from '../../store/folders.store';
import { EmailsStore } from '../../store/emails.store';
import { ComposeStore } from '../../store/compose.store';
import { UiStore } from '../../store/ui.store';
import { ElectronService } from '../../core/services/electron.service';
import { Thread, ComposeMode } from '../../core/models/email.model';

@Component({
  selector: 'app-mail-shell',
  standalone: true,
  imports: [
    CommonModule, RouterLink,
    AccountSwitcherComponent, FolderListComponent,
    EmailListComponent, EmailListHeaderComponent,
    ReadingPaneComponent, StatusBarComponent,
    ResizablePanelDirective, ComposeWindowComponent,
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

        <!-- Compose button -->
        <button class="compose-btn" [class.collapsed]="uiStore.sidebarCollapsed()" (click)="openNewCompose()">
          <span class="material-symbols-outlined">edit</span>
          @if (!uiStore.sidebarCollapsed()) {
            <span>Compose</span>
          }
        </button>

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

    <!-- Compose Window (overlay) -->
    <app-compose-window />
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

    .compose-btn {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 12px 12px 8px;
      padding: 10px 20px;
      background-color: var(--color-primary);
      color: white;
      border: none;
      border-radius: 24px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      font-family: inherit;
      transition: filter 150ms ease, padding 200ms ease;

      &:hover { filter: brightness(1.1); }

      &.collapsed {
        padding: 10px;
        justify-content: center;
        margin: 12px 8px 8px;
      }

      .material-symbols-outlined { font-size: 20px; }
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
  readonly composeStore = inject(ComposeStore);
  readonly uiStore = inject(UiStore);
  private readonly electronService = inject(ElectronService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private routeSub?: Subscription;
  private syncSub?: Subscription;

  constructor() { }

  ngOnInit(): void {
    this.initializeRouteDrivenState().catch(() => {
      // Initialization failures are reflected in individual stores.
    });

    this.routeSub = this.route.params.subscribe(() => {
      this.applyRouteParams().catch(() => {
        // Route handling failures are reflected in individual stores.
      });
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

    this.triggerSyncForActiveAccount();
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.syncSub?.unsubscribe();
  }

  onFolderSelected(folderId: string): void {
    const activeAccount = this.accountsStore.activeAccount();
    if (activeAccount) {
      const normalizedFolderId = this.foldersStore.normalizeFolderId(folderId);
      this.emailsStore.clearSelection();
      this.emailsStore.loadThreads(activeAccount.id, normalizedFolderId);
      this.router.navigate(['/mail', activeAccount.id, normalizedFolderId]);
    }
  }

  async onThreadSelected(thread: Thread): Promise<void> {
    const activeAccount = this.accountsStore.activeAccount();
    if (activeAccount) {
      await this.emailsStore.loadThread(activeAccount.id, thread.gmailThreadId);

      if (!thread.isRead) {
        const messageIds = this.emailsStore.selectedMessages().map(m => m.gmailMessageId);
        this.emailsStore.flagEmails(
          activeAccount.id,
          messageIds.length > 0 ? messageIds : [thread.gmailThreadId],
          'read',
          true,
          thread.gmailThreadId
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
    const messageIds = this.emailsStore.selectedMessages().map(m => m.gmailMessageId);
    const targetIds = messageIds.length > 0 ? messageIds : [thread.gmailThreadId];

    const currentFolder = this.foldersStore.activeFolderId() || 'INBOX';

    switch (action) {
      case 'archive':
        this.emailsStore.moveEmails(activeAccount.id, targetIds, '[Gmail]/All Mail', thread.gmailThreadId, currentFolder);
        this.emailsStore.clearSelection();
        break;
      case 'delete':
        this.emailsStore.moveEmails(activeAccount.id, targetIds, '[Gmail]/Trash', thread.gmailThreadId, currentFolder);
        this.emailsStore.clearSelection();
        break;
      case 'reply':
      case 'reply-all':
      case 'forward':
        this.openComposeForAction(action as ComposeMode);
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

  private async initializeRouteDrivenState(): Promise<void> {
    await this.accountsStore.loadAccounts();
    await this.applyRouteParams();
    this.triggerSyncForActiveAccount();
  }

  private async applyRouteParams(): Promise<void> {
    const params = this.route.snapshot.params;
    const accountIdParam = params['accountId'];
    const folderIdParam = params['folderId'];
    const threadIdParam = params['threadId'];

    if (accountIdParam) {
      this.accountsStore.setActiveAccount(Number(accountIdParam));
    }

    const activeAccount = this.accountsStore.activeAccount();
    if (!activeAccount) {
      return;
    }

    await this.foldersStore.loadFolders(activeAccount.id);

    const resolvedFolderId = this.foldersStore.normalizeFolderId(
      folderIdParam || this.foldersStore.activeFolderId() || 'INBOX'
    );
    this.foldersStore.setActiveFolder(resolvedFolderId);
    await this.emailsStore.loadThreads(activeAccount.id, resolvedFolderId);

    if (threadIdParam) {
      await this.emailsStore.loadThread(activeAccount.id, threadIdParam);
    } else {
      this.emailsStore.clearSelection();
    }
  }

  private triggerSyncForActiveAccount(): void {
    const activeAccount = this.accountsStore.activeAccount();
    if (activeAccount) {
      this.emailsStore.syncAccount(activeAccount.id);
    }
  }

  openNewCompose(): void {
    const activeAccount = this.accountsStore.activeAccount();
    if (!activeAccount) return;
    this.composeStore.openCompose({
      mode: 'new',
      accountId: activeAccount.id,
      accountEmail: activeAccount.email,
      accountDisplayName: activeAccount.displayName,
    });
  }

  private openComposeForAction(mode: ComposeMode): void {
    const activeAccount = this.accountsStore.activeAccount();
    const thread = this.emailsStore.selectedThread();
    if (!activeAccount || !thread) return;

    // Use the last message in the thread for reply/forward context
    const messages = this.emailsStore.selectedMessages();
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

    this.composeStore.openCompose({
      mode,
      accountId: activeAccount.id,
      accountEmail: activeAccount.email,
      accountDisplayName: activeAccount.displayName,
      originalThread: thread,
      originalMessage: lastMessage || undefined,
    });
  }
}
