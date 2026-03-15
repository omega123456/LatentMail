import { Component, inject, OnInit, OnDestroy, AfterViewInit, ChangeDetectorRef, signal, computed, WritableSignal, HostListener, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
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
import { EmailContextMenuComponent } from '../../shared/components/email-context-menu/email-context-menu.component';
import { AccountsStore } from '../../store/accounts.store';
import { FoldersStore } from '../../store/folders.store';
import { EmailsStore } from '../../store/emails.store';
import { ComposeStore } from '../../store/compose.store';
import { UiStore } from '../../store/ui.store';
import { ElectronService } from '../../core/services/electron.service';
import { CommandRegistryService } from '../../core/services/command-registry.service';
import { Thread, ComposeMode, Draft, Email } from '../../core/models/email.model';
import { AiStore } from '../../store/ai.store';
import { ChatStore } from '../../store/chat.store';
import { EmailActionEvent } from '../../shared/components/email-actions/email-action.model';
import { AiChatPanelComponent } from './ai-chat/ai-chat-panel.component';

@Component({
  selector: 'app-mail-shell',
  standalone: true,
  imports: [
    CommonModule, RouterLink,
    AccountSwitcherComponent, FolderListComponent,
    EmailListComponent, EmailListHeaderComponent,
    ReadingPaneComponent, StatusBarComponent,
    ResizablePanelDirective, ComposeWindowComponent,
    SearchBarComponent, EmailContextMenuComponent,
    AiChatPanelComponent,
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
  private readonly chatStore = inject(ChatStore);
  private readonly router = inject(Router);
  private readonly cdr = inject(ChangeDetectorRef);
  private syncSub?: Subscription;
  private commandSub?: Subscription;
  private syncSafeguardTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLoadedAccountId: number | null = null;
  private lastLoadedFolderId: string | null = null;
  // Search active state is now managed by FoldersStore

  // Context menu state — store only thread ID so the menu always shows current store state (isStarred/isRead).
  readonly contextMenuThreadId: WritableSignal<string | null> = signal(null);
  readonly contextMenuThread = computed(() => {
    const id = this.contextMenuThreadId();
    if (!id) {
      return null;
    }
    return this.emailsStore.threads().find((thread) => thread.xGmThrid === id) ?? null;
  });
  readonly contextMenuPosition: WritableSignal<{ x: number; y: number } | null> = signal(null);
  readonly contextMenuOpen: WritableSignal<boolean> = signal(false);

  constructor() {
    /**
     * Auto-select the first thread when a navigation search (from a chat source card) completes.
     * Fires whenever searchStreamStatus transitions to 'complete' AND the search was a navigation
     * search (isNavigationSearch flag), which prevents regular streaming searches from triggering
     * unwanted auto-selection.
     *
     * The flag is cleared BEFORE calling loadThread() so that any subsequent signal change caused
     * by loadThread() (e.g. threads list updating) does not re-trigger the effect.
     */
    effect(() => {
      const status = this.aiStore.searchStreamStatus();
      const isNavigation = this.aiStore.isNavigationSearch();
      const threads = this.emailsStore.threads();
      const searchToken = this.aiStore.searchToken();

      if (status === 'complete' && isNavigation && threads.length >= 1 && searchToken) {
        const firstThread = threads[0];
        const accountId = this.accountsStore.activeAccountId();
        if (accountId && firstThread) {
          // Clear the navigation flag FIRST to prevent the effect from re-entering
          // when loadThread() causes the threads signal to update.
          this.aiStore.clearNavigationFlag();
          void this.emailsStore.loadThread(accountId, firstThread.xGmThrid);
        }
      }
    });

    /**
     * Hydrate last sync time from the active account's persisted lastSyncAt (from DB)
     * so the status bar shows "Last synced: X" after restart instead of "Never".
     */
    effect(() => {
      const activeAccount = this.accountsStore.activeAccount();
      if (activeAccount?.lastSyncAt != null) {
        this.emailsStore.setLastSyncTime(activeAccount.lastSyncAt);
      }
    });
  }

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
      status: 'syncing' | 'done' | 'error';
      error?: string;
    }>('mail:sync').subscribe(event => {
      const status = event.status as 'syncing' | 'done' | 'error';
      this.emailsStore.updateSyncProgress(event.progress, status, event.error);

      if (status === 'done' || status === 'error') {
        this.clearSyncSafeguardTimer();
      } else if (event.progress < 100) {
        this.startOrResetSyncSafeguardTimer();
      }

      if (status === 'done') {
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
    this.clearSyncSafeguardTimer();
    this.syncSub?.unsubscribe();
    this.commandSub?.unsubscribe();
  }

  /* c8 ignore start -- sync safeguard timer requires 30s timeout during active IMAP sync */
  private startOrResetSyncSafeguardTimer(): void {
    this.clearSyncSafeguardTimer();
    this.syncSafeguardTimer = setTimeout(() => {
      this.syncSafeguardTimer = null;
      this.emailsStore.updateSyncProgress(0, 'error', 'Sync timed out');
    }, 30_000);
  }

  private clearSyncSafeguardTimer(): void {
    if (this.syncSafeguardTimer != null) {
      clearTimeout(this.syncSafeguardTimer);
      this.syncSafeguardTimer = null;
    }
  }
  /* c8 ignore stop */

  onFolderSelected(folderId: string): void {
    const activeAccount = this.accountsStore.activeAccount();
    if (activeAccount) {
      const normalizedFolderId = this.foldersStore.normalizeFolderId(folderId);

      // Deactivate search if active
      if (this.foldersStore.searchActive()) {
        this.foldersStore.deactivateSearch();
        this.emailsStore.clearSearch();
      }
      // Always clear streaming search state when loading a folder so "X results" header is hidden
      // (covers both folder-list and label-manager paths; label-manager may have already deactivated search)
      this.aiStore.clearStreamingSearch();

      this.emailsStore.clearSelection();
      this.foldersStore.setActiveFolder(normalizedFolderId);
      this.emailsStore.loadThreads(activeAccount.id, normalizedFolderId);
      this.lastLoadedAccountId = activeAccount.id;
      this.lastLoadedFolderId = normalizedFolderId;

      // Fire-and-forget on-demand sync for Trash and Spam folders.
      // The thread list loads immediately from local DB; the renderer refreshes
      // automatically when the background sync emits MAIL_FOLDER_UPDATED.
      const isTrashOrSpam =
        normalizedFolderId === this.foldersStore.trashFolderId() ||
        normalizedFolderId === this.foldersStore.spamFolderId();
      if (isTrashOrSpam) {
        this.electronService.syncFolder(String(activeAccount.id), normalizedFolderId).catch(() => {
          // Fire-and-forget: errors are logged server-side; UI degrades gracefully
        });
      }
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
        // Silently no-op when viewing Trash — deleting from Trash is not supported.
        if (currentFolder === this.foldersStore.trashFolderId()) {
          break;
        }
        // Per-message delete when event.message is set, otherwise whole thread via threadId.
        // For per-message: omit sourceFolder so backend uses each message's actual folder(s).
        const deleteIds = event.message
          ? [event.message.xGmMsgId]
          : [thread.xGmThrid];
        const deletePerMsg = event.message?.xGmMsgId;
        const deleteSourceFolder = deletePerMsg ? undefined : currentFolder;
        this.emailsStore.moveEmails(activeAccount.id, deleteIds, this.foldersStore.trashFolderId(), thread.xGmThrid, deleteSourceFolder, deletePerMsg);
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
      case 'mark-spam': {
        if (currentFolder === '[Gmail]/Spam') {
          break;
        }
        const spamIds = event.message
          ? [event.message.xGmMsgId]
          : [thread.xGmThrid];
        const spamPerMsg = event.message?.xGmMsgId;
        const spamSourceFolder = spamPerMsg ? undefined : currentFolder;
        this.emailsStore.moveEmails(activeAccount.id, spamIds, '[Gmail]/Spam', thread.xGmThrid, spamSourceFolder, spamPerMsg);
        if (!spamPerMsg) {
          this.emailsStore.clearSelection();
        }
        break;
      }
      case 'mark-not-spam': {
        if (currentFolder !== '[Gmail]/Spam') {
          break;
        }
        const notSpamIds = event.message
          ? [event.message.xGmMsgId]
          : [thread.xGmThrid];
        const notSpamPerMsg = event.message?.xGmMsgId;
        const notSpamSourceFolder = notSpamPerMsg ? undefined : currentFolder;
        this.emailsStore.moveEmails(activeAccount.id, notSpamIds, 'INBOX', thread.xGmThrid, notSpamSourceFolder, notSpamPerMsg);
        if (!notSpamPerMsg) {
          this.emailsStore.clearSelection();
        }
        break;
      }
      case 'star': {
        if (currentFolder === this.foldersStore.trashFolderId()) {
          break;
        }
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
      case 'escape':
        // When multi-select is active, clear just the multi-selection.
        // Otherwise clear the current single-thread selection.
        if (this.emailsStore.multiSelectActive()) {
          this.emailsStore.clearMultiSelection();
        } else {
          this.emailsStore.clearSelection();
        }
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
        void this.router.navigate(['/auth']);
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
    if (this.foldersStore.searchActive()) {
      this.foldersStore.deactivateSearch();
      this.emailsStore.clearSearch();
    }
    this.aiStore.clearStreamingSearch();
    await this.emailsStore.loadThreads(accountId, 'INBOX');
    this.lastLoadedAccountId = accountId;
    this.lastLoadedFolderId = 'INBOX';
  }

  /**
   * Called when the user clicks a source email card in the AI chat panel.
   * Activates search mode and triggers a navigation search for the referenced email.
   * When the search completes (single result), the auto-select effect in the constructor
   * will load the thread into the reading pane.
   */
  onChatSourceClicked(xGmMsgId: string): void {
    const accountId = this.accountsStore.activeAccountId();
    if (!accountId) {
      return;
    }
    this.foldersStore.activateSearch('Source email');
    this.emailsStore.clearThreadsForStreaming();
    void this.aiStore.startNavigationSearch(accountId, xGmMsgId);
  }

  openNewCompose(): void {
    const activeAccount = this.accountsStore.activeAccount();
    if (!activeAccount) { return; }
    this.composeStore.openCompose({
      mode: 'new',
      accountId: activeAccount.id,
      accountEmail: activeAccount.email,
      accountDisplayName: activeAccount.displayName,
    });
  }

  onSearch(event: { queries: string[]; originalQuery: string; streaming?: boolean }): void {
    const activeAccount = this.accountsStore.activeAccount();
    if (!activeAccount) {
      return;
    }

    if (event.streaming === true) {
      // Streaming semantic search path — results arrive via push events (ai:search:batch / ai:search:complete)
      // Search bar already activated search and cleared the thread list before invoking the backend,
      // so the first batch (e.g. local-only) is never wiped. Do NOT clear here or we would race
      // with onSearchBatch and wipe results that just arrived.
      this.foldersStore.activateSearch(event.originalQuery, event.originalQuery);
      // Do NOT call clearThreadsForStreaming() or clearSelection() — search bar did that before startStreamingSearch
      return;
    }
  }

  onSearchCleared(): void {
    if (!this.foldersStore.searchActive()) {
      return;
    }

    // Deactivate search (restores previous folder)
    const previousFolderId = this.foldersStore.previousFolderId();
    this.foldersStore.deactivateSearch();
    this.emailsStore.clearSearch();
    this.aiStore.clearStreamingSearch();

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

  /**
   * Called when any email list item receives a right-click.
   * Stores the thread and position for the context menu overlay and
   * simultaneously selects the thread in the reading pane.
   */
  onThreadContextMenu(data: { thread: Thread; x: number; y: number }): void {
    this.contextMenuThreadId.set(data.thread.xGmThrid);
    this.contextMenuPosition.set({ x: data.x, y: data.y });
    this.contextMenuOpen.set(true);
    // Thread selection is handled by EmailListComponent.onItemContextMenu() which calls
    // onThreadClick() → emits threadSelected → onThreadSelected(). No need to call it again here.
  }

  /** Called when the context menu closes (action, Escape, or outside click). */
  onContextMenuClosed(): void {
    this.contextMenuOpen.set(false);
    this.contextMenuThreadId.set(null);
  }

  /**
   * When the context menu is open, a right-click hits the overlay backdrop instead of the list.
   * Close the menu and re-dispatch contextmenu at the same coordinates so the element under
   * the cursor (e.g. another list item) receives it and opens the menu for that thread.
   */
  @HostListener('document:contextmenu', ['$event'])
  onDocumentContextMenu(event: MouseEvent): void {
    if (!this.contextMenuOpen()) {
      return;
    }
    const panel = document.querySelector('.email-context-menu-panel');
    if (panel?.contains(event.target as Node)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.onContextMenuClosed();
    setTimeout(() => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (target) {
        target.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
            button: event.button,
            buttons: event.buttons,
          })
        );
      }
    }, 0);
  }

  /**
   * Dispatches an action chosen from the context menu.
   * Uses contextMenuThread() as the primary thread reference — NOT selectedThread(),
   * which may still be loading at the moment a fast action (delete, star, etc.) fires.
   */
  onContextMenuAction(event: EmailActionEvent): void {
    // Dismiss the overlay immediately so the UI responds without waiting for the action.
    this.contextMenuOpen.set(false);

    const activeAccount = this.accountsStore.activeAccount();
    if (!activeAccount) {
      return;
    }

    const currentFolder = this.foldersStore.activeFolderId() || 'INBOX';

    // ── Multi-select bulk dispatch (2+ threads selected) ─────────────────────
    if (this.emailsStore.multiSelectCount() > 1) {
      const selectedIds = this.emailsStore.multiSelectedThreadIds().slice();
      const allThreads = this.emailsStore.threads();

      switch (event.action) {
        case 'delete': {
          if (currentFolder === this.foldersStore.trashFolderId()) {
            break;
          }
          for (const threadId of selectedIds) {
            const thread = allThreads.find(t => t.xGmThrid === threadId);
            if (thread) {
              this.emailsStore.moveEmails(activeAccount.id, [thread.xGmThrid], this.foldersStore.trashFolderId(), thread.xGmThrid, currentFolder);
            }
          }
          break;
        }
        case 'move-to': {
          if (!event.targetFolder) {
            break;
          }
          for (const threadId of selectedIds) {
            const thread = allThreads.find(t => t.xGmThrid === threadId);
            if (thread) {
              this.emailsStore.moveEmails(activeAccount.id, [thread.xGmThrid], event.targetFolder, thread.xGmThrid, currentFolder);
            }
          }
          break;
        }
        case 'mark-spam': {
          if (currentFolder === '[Gmail]/Spam') {
            break;
          }
          for (const threadId of selectedIds) {
            const thread = allThreads.find(t => t.xGmThrid === threadId);
            if (thread) {
              this.emailsStore.moveEmails(activeAccount.id, [thread.xGmThrid], '[Gmail]/Spam', thread.xGmThrid, currentFolder);
            }
          }
          break;
        }
        case 'mark-not-spam': {
          if (currentFolder !== '[Gmail]/Spam') {
            break;
          }
          for (const threadId of selectedIds) {
            const thread = allThreads.find(t => t.xGmThrid === threadId);
            if (thread) {
              this.emailsStore.moveEmails(activeAccount.id, [thread.xGmThrid], 'INBOX', thread.xGmThrid, currentFolder);
            }
          }
          break;
        }
        case 'star': {
          if (currentFolder === this.foldersStore.trashFolderId()) {
            break;
          }
          // OR rule: any unstarred → star all; all starred → unstar all
          const starValue = selectedIds.some(id => {
            const thread = allThreads.find(t => t.xGmThrid === id);
            return thread ? !thread.isStarred : false;
          });
          for (const threadId of selectedIds) {
            const thread = allThreads.find(t => t.xGmThrid === threadId);
            if (thread) {
              this.emailsStore.flagEmails(activeAccount.id, [thread.xGmThrid], 'starred', starValue, thread.xGmThrid);
            }
          }
          break;
        }
        case 'mark-read-unread': {
          // OR rule: any unread → mark all read; all read → mark all unread
          const readValue = selectedIds.some(id => {
            const thread = allThreads.find(t => t.xGmThrid === id);
            return thread ? !thread.isRead : false;
          });
          for (const threadId of selectedIds) {
            const thread = allThreads.find(t => t.xGmThrid === threadId);
            if (thread) {
              this.emailsStore.flagEmails(activeAccount.id, [thread.xGmThrid], 'read', readValue, thread.xGmThrid);
            }
          }
          break;
        }
        case 'add-labels':
        case 'remove-labels':
          // Disabled in the UI during multi-select — no-op here
          break;
        default:
          break;
      }

      this.emailsStore.clearMultiSelection();
      this.emailsStore.clearSelection();
      return;
    }

    // ── Single-thread dispatch ────────────────────────────────────────────────
    const thread = this.contextMenuThread();
    if (!thread) {
      return;
    }

    switch (event.action) {
      case 'delete': {
        // Silently no-op when viewing Trash — deleting from Trash is not supported.
        if (currentFolder === this.foldersStore.trashFolderId()) {
          break;
        }
        this.emailsStore.moveEmails(
          activeAccount.id,
          [thread.xGmThrid],
          this.foldersStore.trashFolderId(),
          thread.xGmThrid,
          currentFolder,
        );
        this.emailsStore.clearSelection();
        break;
      }
      case 'move-to': {
        if (!event.targetFolder) {
          break;
        }
        this.emailsStore.moveEmails(
          activeAccount.id,
          [thread.xGmThrid],
          event.targetFolder,
          thread.xGmThrid,
          currentFolder,
        );
        this.emailsStore.clearSelection();
        break;
      }
      case 'star': {
        if (currentFolder === this.foldersStore.trashFolderId()) {
          break;
        }
        this.emailsStore.flagEmails(
          activeAccount.id,
          [thread.xGmThrid],
          'starred',
          !thread.isStarred,
          thread.xGmThrid,
        );
        break;
      }
      case 'mark-read-unread': {
        this.emailsStore.flagEmails(
          activeAccount.id,
          [thread.xGmThrid],
          'read',
          !thread.isRead,
          thread.xGmThrid,
        );
        break;
      }
      case 'mark-spam': {
        if (currentFolder === '[Gmail]/Spam') {
          break;
        }
        this.emailsStore.moveEmails(
          activeAccount.id,
          [thread.xGmThrid],
          '[Gmail]/Spam',
          thread.xGmThrid,
          currentFolder,
        );
        this.emailsStore.clearSelection();
        break;
      }
      case 'mark-not-spam': {
        if (currentFolder !== '[Gmail]/Spam') {
          break;
        }
        this.emailsStore.moveEmails(
          activeAccount.id,
          [thread.xGmThrid],
          'INBOX',
          thread.xGmThrid,
          currentFolder,
        );
        this.emailsStore.clearSelection();
        break;
      }
      case 'add-labels': {
        if (!event.targetLabels || event.targetLabels.length === 0) {
          break;
        }
        // Use actual xGmMsgIds from the loaded thread messages.
        // No-op if messages are not yet loaded — label operations require real message IDs;
        // using xGmThrid as a message ID is incorrect and must be avoided.
        const addMessages = this.emailsStore.selectedMessages();
        const addXGmMsgIds = addMessages.map(message => message.xGmMsgId);
        if (addXGmMsgIds.length > 0) {
          this.emailsStore.addLabels(activeAccount.id, addXGmMsgIds, event.targetLabels, thread.xGmThrid);
        }
        break;
      }
      case 'remove-labels': {
        if (!event.targetLabels || event.targetLabels.length === 0) {
          break;
        }
        const removeMessages = this.emailsStore.selectedMessages();
        const removeXGmMsgIds = removeMessages.map(message => message.xGmMsgId);
        if (removeXGmMsgIds.length > 0) {
          this.emailsStore.removeLabels(activeAccount.id, removeXGmMsgIds, event.targetLabels, thread.xGmThrid);
        }
        break;
      }
      case 'reply':
      case 'reply-all':
      case 'forward': {
        // By the time the user reads and clicks a compose action, selectedThread() will
        // have loaded (SQLite is near-instantaneous). openComposeForAction() has its own
        // null guard and silently no-ops if the thread is still null for any reason.
        this.openComposeForAction(event.action as ComposeMode);
        break;
      }
      case 'edit-draft': {
        this.openDraftForEditing();
        break;
      }
      default:
        break;
    }
  }

  private openComposeForAction(mode: ComposeMode, specificMessage?: Email, prefillBody?: string): void {
    const activeAccount = this.accountsStore.activeAccount();
    const thread = this.emailsStore.selectedThread();
    /* c8 ignore next -- defensive guard, account and thread always present in E2E */
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
    /* c8 ignore next -- defensive guard, account and thread always present in E2E */
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
      /* c8 ignore next -- fallback for thread with no draft message */
      if (!msg && messages.length > 0) {
        msg = messages[messages.length - 1];
      }
    }
    /* c8 ignore next -- unreachable after sync */
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
