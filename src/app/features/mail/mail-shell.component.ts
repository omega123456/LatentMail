import { Component, inject, OnInit, OnDestroy, AfterViewInit, ChangeDetectorRef, signal, ViewChildren, QueryList } from '@angular/core';
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
import { SearchBarComponent } from '../../shared/components/search-bar.component';
import { AccountsStore } from '../../store/accounts.store';
import { FoldersStore } from '../../store/folders.store';
import { EmailsStore } from '../../store/emails.store';
import { ComposeStore } from '../../store/compose.store';
import { UiStore } from '../../store/ui.store';
import { ElectronService } from '../../core/services/electron.service';
import { CommandRegistryService } from '../../core/services/command-registry.service';
import { Thread, ComposeMode, Draft, Email } from '../../core/models/email.model';
import { AiStore } from '../../store/ai.store';
import { AiCategory } from '../../core/models/ai.model';
import { EmailActionEvent } from '../../shared/components/email-actions/email-action.model';

@Component({
  selector: 'app-mail-shell',
  standalone: true,
  imports: [
    CommonModule, RouterLink,
    AccountSwitcherComponent, FolderListComponent,
    EmailListComponent, EmailListHeaderComponent,
    ReadingPaneComponent, StatusBarComponent,
    ResizablePanelDirective, ComposeWindowComponent,
    SearchBarComponent,
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
  private readonly commandRegistry = inject(CommandRegistryService);
  private readonly aiStore = inject(AiStore);
  private readonly cdr = inject(ChangeDetectorRef);
  private syncSub?: Subscription;
  private commandSub?: Subscription;
  private lastLoadedAccountId: number | null = null;
  private lastLoadedFolderId: string | null = null;
  // Search active state is now managed by FoldersStore
  readonly activeCategoryFilter = signal<AiCategory | null>(null);

  @ViewChildren(EmailListComponent) emailLists!: QueryList<EmailListComponent>;

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

    // Subscribe to command registry events for shell-level actions.
    // Folder navigation (go-inbox/sent/drafts) is handled here when mail-shell
    // is already mounted; the CommandRegistry action also pre-sets the folder so
    // cross-route navigation from settings works even before mail-shell mounts.
    this.commandSub = this.commandRegistry.commandTriggered$.subscribe(commandId => {
      this.handleShellCommand(commandId);
    });
  }

  ngOnDestroy(): void {
    this.syncSub?.unsubscribe();
    this.commandSub?.unsubscribe();
  }

  onFolderSelected(folderId: string): void {
    const activeAccount = this.accountsStore.activeAccount();
    if (activeAccount) {
      const normalizedFolderId = this.foldersStore.normalizeFolderId(folderId);

      // Deactivate search if active
      if (this.foldersStore.searchActive()) {
        this.foldersStore.deactivateSearch();
        this.emailsStore.clearSearch();
      }

      this.emailsStore.clearSelection();
      this.foldersStore.setActiveFolder(normalizedFolderId);
      this.emailsStore.loadThreads(activeAccount.id, normalizedFolderId);
      this.lastLoadedAccountId = activeAccount.id;
      this.lastLoadedFolderId = normalizedFolderId;
      // Reset category filter and cache on folder switch
      this.activeCategoryFilter.set(null);
      this.aiStore.clearCategoryCache();
      this.emailLists?.forEach(list => list.setCategoryFilter(null));
    }
  }

  async onThreadSelected(thread: Thread): Promise<void> {
    const activeAccount = this.accountsStore.activeAccount();
    if (activeAccount) {
      await this.emailsStore.loadThread(activeAccount.id, thread.xGmThrid);

      if (!thread.isRead) {
        const messageIds = this.emailsStore.selectedMessages().map(m => m.xGmMsgId);
        this.emailsStore.flagEmails(
          activeAccount.id,
          messageIds.length > 0 ? messageIds : [thread.xGmThrid],
          'read',
          true,
          thread.xGmThrid
        );
      }
    }
  }

  onAction(event: EmailActionEvent): void {
    const thread = this.emailsStore.selectedThread();
    const activeAccount = this.accountsStore.activeAccount();
    if (!thread || !activeAccount) {
      return;
    }

    const currentFolder = this.foldersStore.activeFolderId() || 'INBOX';

    // Handle AI reply suggestions with prefix "reply-with:..."
    if (event.action.startsWith('reply-with:')) {
      const suggestionText = event.action.substring('reply-with:'.length);
      this.openComposeForAction('reply', undefined, suggestionText);
      return;
    }

    switch (event.action) {
      case 'delete': {
        // Per-message delete when event.message is set, otherwise whole thread via threadId.
        // For per-message: omit sourceFolder so backend uses each message's actual folder(s).
        const deleteIds = event.message
          ? [event.message.xGmMsgId]
          : [thread.xGmThrid];
        const deletePerMsg = event.message?.xGmMsgId;
        const deleteSourceFolder = deletePerMsg ? undefined : currentFolder;
        this.emailsStore.moveEmails(activeAccount.id, deleteIds, '[Gmail]/Trash', thread.xGmThrid, deleteSourceFolder, deletePerMsg);
        if (!deletePerMsg) {
          this.emailsStore.clearSelection();
        }
        break;
      }
      case 'move-to': {
        if (!event.targetFolder) {
          break;
        }
        // Per-message move when event.message is set, otherwise whole thread via threadId.
        // For per-message: omit sourceFolder so backend uses each message's actual folder(s).
        const moveIds = event.message
          ? [event.message.xGmMsgId]
          : [thread.xGmThrid];
        const movePerMsg = event.message?.xGmMsgId;
        const moveSourceFolder = movePerMsg ? undefined : currentFolder;
        this.emailsStore.moveEmails(activeAccount.id, moveIds, event.targetFolder, thread.xGmThrid, moveSourceFolder, movePerMsg);
        if (!movePerMsg) {
          this.emailsStore.clearSelection();
        }
        break;
      }
      case 'star': {
        // Always thread-level — use threadId to flag all messages in thread
        this.emailsStore.flagEmails(activeAccount.id, [thread.xGmThrid], 'starred', !thread.isStarred, thread.xGmThrid);
        break;
      }
      case 'mark-read-unread': {
        // Always thread-level — use threadId to flag all messages in thread
        this.emailsStore.flagEmails(activeAccount.id, [thread.xGmThrid], 'read', !thread.isRead, thread.xGmThrid);
        break;
      }
      case 'add-labels': {
        if (!event.targetLabels || event.targetLabels.length === 0) {
          break;
        }
        // Use the specific message if triggered per-message; otherwise use all thread messages.
        // Always use actual xGmMsgIds — never use xGmThrid as a message ID.
        let addXGmMsgIds: string[];
        if (event.message?.xGmMsgId) {
          addXGmMsgIds = [event.message.xGmMsgId];
        } else {
          const addMessages = this.emailsStore.selectedMessages();
          addXGmMsgIds = addMessages.length > 0
            ? addMessages.map(message => message.xGmMsgId)
            : (this.emailsStore.selectedThread()?.messages ?? []).map(message => message.xGmMsgId);
        }
        if (addXGmMsgIds.length > 0) {
          this.emailsStore.addLabels(activeAccount.id, addXGmMsgIds, event.targetLabels, thread.xGmThrid);
        }
        break;
      }
      case 'remove-labels': {
        if (!event.targetLabels || event.targetLabels.length === 0) {
          break;
        }
        // Use the specific message if triggered per-message; otherwise use all thread messages.
        let removeXGmMsgIds: string[];
        if (event.message?.xGmMsgId) {
          removeXGmMsgIds = [event.message.xGmMsgId];
        } else {
          const removeMessages = this.emailsStore.selectedMessages();
          removeXGmMsgIds = removeMessages.length > 0
            ? removeMessages.map(message => message.xGmMsgId)
            : (this.emailsStore.selectedThread()?.messages ?? []).map(message => message.xGmMsgId);
        }
        if (removeXGmMsgIds.length > 0) {
          this.emailsStore.removeLabels(activeAccount.id, removeXGmMsgIds, event.targetLabels, thread.xGmThrid);
        }
        break;
      }
      case 'edit-draft':
        this.openDraftForEditing(event.message);
        break;
      case 'reply':
      case 'reply-all':
      case 'forward':
        this.openComposeForAction(event.action as ComposeMode, event.message);
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

  // ---------------------------------------------------------------------------
  // Shell-level command handling
  // ---------------------------------------------------------------------------

  /**
   * Handle command registry events that require shell-level context:
   * folder navigation, compose actions, search focus, and selection management.
   *
   * Commands that operate on the email list items (nav-next, delete, etc.)
   * are handled by EmailListComponent via the same commandTriggered$ observable.
   */
  private handleShellCommand(commandId: string): void {
    switch (commandId) {
      case 'go-inbox':
        this.onFolderSelected('INBOX');
        break;
      case 'go-sent':
        this.onFolderSelected('[Gmail]/Sent Mail');
        break;
      case 'go-drafts':
        this.onFolderSelected('[Gmail]/Drafts');
        break;
      case 'reply':
        this.openComposeForAction('reply');
        break;
      case 'reply-all':
        this.openComposeForAction('reply-all');
        break;
      case 'forward':
        this.openComposeForAction('forward');
        break;
      case 'search-focus':
        // Focus the search bar input — works because KeyboardService skips
        // inputs, so `/` lands here and not in SearchBarComponent's own listener.
        // SearchBarComponent handles Ctrl+F itself, making this a secondary path.
        this.focusSearchBar();
        break;
      case 'select-all':
        // Multi-select is not yet implemented in EmailsStore (single-thread selection
        // only). This is intentionally a no-op stub; a future phase will add
        // selectedThreadIds[] to the store and hook it up here.
        break;
      case 'escape':
        // Clear the current thread selection. The command palette (if open) already
        // closes itself via its own host listener before this subscription fires.
        this.emailsStore.clearSelection();
        break;
      default:
        break;
    }
  }

  /**
   * Focus the search bar input element.
   * Uses a direct DOM query because SearchBarComponent manages its own focus
   * state and does not expose a public `focus()` method.
   */
  private focusSearchBar(): void {
    const searchInput = document.querySelector('.search-bar-input') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.focus();
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
    // Reset category filter and cache on account switch
    this.activeCategoryFilter.set(null);
    this.aiStore.clearCategoryCache();
    this.emailLists?.forEach(list => list.setCategoryFilter(null));
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

  onSearch(event: { queries: string[]; originalQuery: string }): void {
    const activeAccount = this.accountsStore.activeAccount();
    if (!activeAccount) {
      return;
    }

    const effectiveQuery = event.queries.join(' OR ');

    // Activate search mode in FoldersStore (saves previous folder, shows virtual folder)
    this.foldersStore.activateSearch(event.originalQuery, effectiveQuery);

    // Clear selection and start two-phase search
    this.emailsStore.clearSelection();
    this.emailsStore.searchEmails(activeAccount.id, event.queries);
  }

  onSearchCleared(): void {
    if (!this.foldersStore.searchActive()) {
      return;
    }

    // Deactivate search (restores previous folder)
    const previousFolderId = this.foldersStore.previousFolderId();
    this.foldersStore.deactivateSearch();
    this.emailsStore.clearSearch();

    // Reload threads for the restored folder
    const activeAccount = this.accountsStore.activeAccount();
    const folderId = previousFolderId || this.foldersStore.activeFolderId() || 'INBOX';
    if (activeAccount) {
      this.emailsStore.loadThreads(activeAccount.id, folderId);
    }
  }

  onSearchDismissed(): void {
    this.onSearchCleared();
  }

  onCategoryFilterChanged(category: AiCategory | null): void {
    this.activeCategoryFilter.set(category);
    // Update all email list instances
    this.emailLists?.forEach(list => list.setCategoryFilter(category));
  }

  private openComposeForAction(mode: ComposeMode, specificMessage?: Email, prefillBody?: string): void {
    const activeAccount = this.accountsStore.activeAccount();
    const thread = this.emailsStore.selectedThread();
    if (!activeAccount || !thread) {
      return;
    }

    // Use specificMessage if provided (per-message ribbon), otherwise last message in thread
    let originalMessage: Email | undefined = specificMessage;
    if (!originalMessage) {
      const messages = this.emailsStore.selectedMessages();
      originalMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
    }

    this.composeStore.openCompose({
      mode,
      accountId: activeAccount.id,
      accountEmail: activeAccount.email,
      accountDisplayName: activeAccount.displayName,
      originalThread: thread,
      originalMessage,
      prefillBody,
    });
  }

  /**
   * Open a draft from the Drafts folder for editing in compose.
   * Maps the selected email message to a Draft shape and passes its xGmMsgId
   * so that on send/discard, the backend can resolve the UID and remove the old draft from Gmail.
   */
  private openDraftForEditing(specificMessage?: Email): void {
    const activeAccount = this.accountsStore.activeAccount();
    const thread = this.emailsStore.selectedThread();
    if (!activeAccount || !thread) {
      return;
    }

    // Use specificMessage if provided (per-message ribbon), otherwise find a draft message in thread
    let msg: Email | null = specificMessage ?? null;
    if (!msg) {
      const messages = this.emailsStore.selectedMessages();
      // Find the last draft message (prefer actual draft over arbitrary last message)
      msg = [...messages].reverse().find(m => m.isDraft) ?? null;
      // Fallback to last message if no draft found (legacy behavior)
      if (!msg && messages.length > 0) {
        msg = messages[messages.length - 1];
      }
    }
    if (!msg) {
      return;
    }

    // Map Email to Draft shape
    const draft: Draft = {
      accountId: activeAccount.id,
      xGmThrid: msg.xGmThrid || '',
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

    // Pass the xGmMsgId so the backend can resolve the IMAP UID from email_folders
    const serverDraftXGmMsgId = msg.xGmMsgId;

    this.composeStore.openCompose({
      mode: 'new',
      accountId: activeAccount.id,
      accountEmail: activeAccount.email,
      accountDisplayName: activeAccount.displayName,
      draft,
      serverDraftXGmMsgId,
    });
  }
}
