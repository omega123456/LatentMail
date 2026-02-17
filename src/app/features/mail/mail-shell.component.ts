import { Component, inject, OnInit, OnDestroy, AfterViewInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
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
  private readonly cdr = inject(ChangeDetectorRef);
  private syncSub?: Subscription;
  private lastLoadedAccountId: number | null = null;
  private lastLoadedFolderId: string | null = null;

  constructor() { }

  ngAfterViewInit(): void {
    // Defer one tick so RouterLink href is set before next CD (avoids NG0100)
    setTimeout(() => this.cdr.detectChanges(), 0);
  }

  ngOnInit(): void {
    this.initializeStoreState().catch(() => {
      // Initialization failures are reflected in individual stores.
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
    this.syncSub?.unsubscribe();
  }

  onFolderSelected(folderId: string): void {
    const activeAccount = this.accountsStore.activeAccount();
    if (activeAccount) {
      const normalizedFolderId = this.foldersStore.normalizeFolderId(folderId);
      this.emailsStore.clearSelection();
      this.foldersStore.setActiveFolder(normalizedFolderId);
      this.emailsStore.loadThreads(activeAccount.id, normalizedFolderId);
      this.lastLoadedAccountId = activeAccount.id;
      this.lastLoadedFolderId = normalizedFolderId;
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

  /**
   * Store-driven initialization (replaces route-driven init).
   * Honors pre-populated store state (e.g. from notification click
   * or returning from settings) to avoid redundant loads.
   */
  private async initializeStoreState(): Promise<void> {
    await this.accountsStore.loadAccounts();

    // Use pre-set active account (e.g. from notification handler) or pick first
    let activeAccount = this.accountsStore.activeAccount();
    if (!activeAccount) {
      const accounts = this.accountsStore.accounts();
      if (accounts.length === 0) {
        this.lastLoadedAccountId = null;
        this.lastLoadedFolderId = null;
        return;
      }
      this.accountsStore.setActiveAccount(accounts[0].id);
      activeAccount = this.accountsStore.activeAccount();
    }

    if (!activeAccount) {
      this.lastLoadedAccountId = null;
      this.lastLoadedFolderId = null;
      return;
    }

    await this.foldersStore.loadFolders(activeAccount.id);

    // Use pre-set active folder or default to INBOX, then normalize
    const resolvedFolderId = this.foldersStore.normalizeFolderId(
      this.foldersStore.activeFolderId() || 'INBOX'
    );
    this.foldersStore.setActiveFolder(resolvedFolderId);

    // Skip loadThreads if threads are already populated for this exact context.
    // This handles two cases:
    // 1. Notification handler pre-loaded threads (lastLoaded* are null, component is new)
    // 2. Returning from settings (stores persist, threads still match active account/folder)
    // We check the store's activeAccountId + activeFolderId to ensure the existing
    // threads correspond to the current selection, not stale data from a different context.
    const storeAccountId = this.accountsStore.activeAccountId();
    const storeFolderId = this.foldersStore.activeFolderId();
    const threadsAlreadyValid =
      this.emailsStore.threads().length > 0 &&
      storeAccountId === activeAccount.id &&
      storeFolderId === resolvedFolderId;

    const shouldLoadThreads =
      !threadsAlreadyValid ||
      (this.lastLoadedAccountId !== null &&
        (this.lastLoadedAccountId !== activeAccount.id ||
          this.lastLoadedFolderId !== resolvedFolderId));

    if (shouldLoadThreads) {
      await this.emailsStore.loadThreads(activeAccount.id, resolvedFolderId);
    }

    this.lastLoadedAccountId = activeAccount.id;
    this.lastLoadedFolderId = resolvedFolderId;

    // Don't clear selection if already set (e.g. from notification handler)
    // Selection is only cleared explicitly on folder switch
  }

  /**
   * Handle account switch from the account switcher component.
   * Loads folders and threads for the newly selected account.
   */
  async onAccountSwitch(accountId: number): Promise<void> {
    this.accountsStore.setActiveAccount(accountId);
    await this.foldersStore.loadFolders(accountId);
    this.foldersStore.setActiveFolder('INBOX');
    this.emailsStore.clearSelection();
    await this.emailsStore.loadThreads(accountId, 'INBOX');
    this.lastLoadedAccountId = accountId;
    this.lastLoadedFolderId = 'INBOX';
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
