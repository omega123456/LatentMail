import { Component, inject, OnInit, OnDestroy, AfterViewInit, ChangeDetectorRef } from '@angular/core';
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
import { Thread, ComposeMode, Draft } from '../../core/models/email.model';

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
  templateUrl: './mail-shell.component.html',
  styleUrl: './mail-shell.component.scss',
})
export class MailShellComponent implements OnInit, OnDestroy, AfterViewInit {
  readonly accountsStore = inject(AccountsStore);
  readonly foldersStore = inject(FoldersStore);
  readonly emailsStore = inject(EmailsStore);
  readonly composeStore = inject(ComposeStore);
  readonly uiStore = inject(UiStore);
  private readonly electronService = inject(ElectronService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly cdr = inject(ChangeDetectorRef);
  private routeSub?: Subscription;
  private syncSub?: Subscription;
  private lastLoadedAccountId: number | null = null;
  private lastLoadedFolderId: string | null = null;

  constructor() { }

  ngAfterViewInit(): void {
    // Defer one tick so RouterLink href is set before next CD (avoids NG0100)
    setTimeout(() => this.cdr.detectChanges(), 0);
  }

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
          // Background sync completion should not reset deep-list scroll position.
          this.emailsStore.refreshThreads();
        }
      }
    });
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
      case 'edit-draft':
        this.openDraftForEditing();
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

  private async initializeRouteDrivenState(): Promise<void> {
    await this.accountsStore.loadAccounts();
    await this.applyRouteParams();
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
      this.lastLoadedAccountId = null;
      this.lastLoadedFolderId = null;
      return;
    }

    await this.foldersStore.loadFolders(activeAccount.id);

    const resolvedFolderId = this.foldersStore.normalizeFolderId(
      folderIdParam || this.foldersStore.activeFolderId() || 'INBOX'
    );
    this.foldersStore.setActiveFolder(resolvedFolderId);

    const shouldReloadThreads =
      this.lastLoadedAccountId !== activeAccount.id ||
      this.lastLoadedFolderId !== resolvedFolderId ||
      this.emailsStore.threads().length === 0;

    if (shouldReloadThreads) {
      await this.emailsStore.loadThreads(activeAccount.id, resolvedFolderId);
      this.lastLoadedAccountId = activeAccount.id;
      this.lastLoadedFolderId = resolvedFolderId;
    }

    if (threadIdParam) {
      if (this.emailsStore.selectedThreadId() !== threadIdParam) {
        await this.emailsStore.loadThread(activeAccount.id, threadIdParam);
      }
    } else {
      this.emailsStore.clearSelection();
    }
  }

  onManualSync(): void {
    const activeAccount = this.accountsStore.activeAccount();
    if (activeAccount && !this.emailsStore.syncing()) {
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

  /**
   * Open a draft from the Drafts folder for editing in compose.
   * Maps the selected email message to a Draft shape and passes its gmailMessageId
   * so that on send/discard, the backend can resolve the UID and remove the old draft from Gmail.
   */
  private openDraftForEditing(): void {
    const activeAccount = this.accountsStore.activeAccount();
    const thread = this.emailsStore.selectedThread();
    if (!activeAccount || !thread) return;

    const messages = this.emailsStore.selectedMessages();
    // Use the most recent message (or only message) in the draft thread
    const msg = messages.length > 0 ? messages[messages.length - 1] : null;
    if (!msg) return;

    // Map Email to Draft shape
    const draft: Draft = {
      accountId: activeAccount.id,
      gmailThreadId: msg.gmailThreadId || '',
      subject: (msg.subject || '').replace(/^(Draft|Re:|Fwd:)\s*/i, '').trim() || msg.subject || '',
      to: msg.toAddresses || '',
      cc: msg.ccAddresses || '',
      bcc: msg.bccAddresses || '',
      htmlBody: msg.htmlBody || '',
      textBody: msg.textBody || '',
      attachments: [],
    };

    // Preserve original subject (keep Re:/Fwd: prefixes if present)
    draft.subject = msg.subject || '';

    // Pass the gmailMessageId so the backend can resolve the IMAP UID from email_folders
    const serverDraftGmailMessageId = msg.gmailMessageId;

    this.composeStore.openCompose({
      mode: 'new',
      accountId: activeAccount.id,
      accountEmail: activeAccount.email,
      accountDisplayName: activeAccount.displayName,
      draft,
      serverDraftGmailMessageId,
    });
  }
}
