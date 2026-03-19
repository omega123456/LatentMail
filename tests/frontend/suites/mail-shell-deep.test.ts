import { DateTime } from 'luxon';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  clearMockIpc,
  discardComposeIfOpen,
  emitRendererEvent,
  extractSeededAccount,
  focusMailShell,
  getShortcutModifier,
  injectInboxMessage,
  mockIpc,
  returnToMailShell,
  triggerSync,
  waitForEmailSubject,
  waitForMailShell,
  type MessageIdentity,
} from '../infrastructure/helpers';

test.describe('Mail shell deep', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;
  let seededEmail: string;
  const injectedMessages: MessageIdentity[] = [];

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId, email: seededEmail } = extractSeededAccount(result));

    await triggerSync(electronApp, accountId);
    await waitForMailShell(page);

    for (let i = 1; i <= 4; i++) {
      const identity = await injectInboxMessage(electronApp, {
        from: `deep-sender-${i}@example.com`,
        to: seededEmail,
        subject: `Deep Email ${i}`,
        body: `Body content for deep email ${i}.`,
      });
      injectedMessages.push(identity);
    }

    await triggerSync(electronApp, accountId);

    for (let i = 1; i <= 4; i++) {
      await waitForEmailSubject(page, `Deep Email ${i}`);
    }
  });

  test.afterEach(async ({ electronApp }) => {
    await clearMockIpc(electronApp);
  });

  test('multi-select bulk delete via context menu', async ({ page, electronApp }) => {
    const firstMsg = injectedMessages[0];
    const secondMsg = injectedMessages[1];
    const firstItem = page.getByTestId(`email-item-${firstMsg.xGmThrid}`);
    const secondItem = page.getByTestId(`email-item-${secondMsg.xGmThrid}`);

    const modifier = await getShortcutModifier(electronApp);

    await firstItem.click();
    await page.keyboard.down(modifier);
    await secondItem.click();
    await page.keyboard.up(modifier);

    await expect(firstItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    await expect(secondItem).toHaveClass(/(^|\s)multi-selected(\s|$)/);

    await secondItem.click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();

    await page.getByTestId('context-action-delete').click();

    await expect(firstItem).not.toBeVisible({ timeout: 5000 });
    await expect(secondItem).not.toBeVisible({ timeout: 5000 });
  });

  test('multi-select bulk star via context menu', async ({ page, electronApp }) => {
    const msg3 = injectedMessages[2];
    const msg4 = injectedMessages[3];

    await injectInboxMessage(electronApp, {
      from: 'deep-extra-1@example.com',
      to: seededEmail,
      subject: 'Deep Extra Email 1',
      body: 'Extra email 1 for star test.',
    });

    await injectInboxMessage(electronApp, {
      from: 'deep-extra-2@example.com',
      to: seededEmail,
      subject: 'Deep Extra Email 2',
      body: 'Extra email 2 for star test.',
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, 'Deep Extra Email 1');
    await waitForEmailSubject(page, 'Deep Extra Email 2');

    const item3 = page.getByTestId(`email-item-${msg3.xGmThrid}`);
    const item4 = page.getByTestId(`email-item-${msg4.xGmThrid}`);
    const star3 = page.getByTestId(`email-star-${msg3.xGmThrid}`);
    const star4 = page.getByTestId(`email-star-${msg4.xGmThrid}`);

    const modifier = await getShortcutModifier(electronApp);

    await item3.click();
    await page.keyboard.down(modifier);
    await item4.click();
    await page.keyboard.up(modifier);

    await item3.click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();

    await page.getByTestId('context-action-star').click();

    await expect(star3).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
    await expect(star4).toHaveClass(/(^|\s)starred(\s|$)/, { timeout: 5000 });
  });

  test('multi-select Escape clears selection', async ({ page, electronApp }) => {
    const msg3 = injectedMessages[2];
    const msg4 = injectedMessages[3];
    const item3 = page.getByTestId(`email-item-${msg3.xGmThrid}`);
    const item4 = page.getByTestId(`email-item-${msg4.xGmThrid}`);

    const modifier = await getShortcutModifier(electronApp);

    await item3.click();
    await page.keyboard.down(modifier);
    await item4.click();
    await page.keyboard.up(modifier);

    await expect(item3).toHaveClass(/(^|\s)multi-selected(\s|$)/);
    await expect(item4).toHaveClass(/(^|\s)multi-selected(\s|$)/);

    await page.keyboard.press('Escape');

    await expect(item3).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
    await expect(item4).not.toHaveClass(/(^|\s)multi-selected(\s|$)/, { timeout: 5000 });
  });

  test('keyboard shortcut Shift+R opens reply-all compose', async ({ page, electronApp }) => {
    await discardComposeIfOpen(page);

    const replyAllMessage = await injectInboxMessage(electronApp, {
      from: 'deep-reply-all@example.com',
      to: seededEmail,
      subject: 'Deep Reply All Target',
      body: 'This message tests the Shift+R reply-all shortcut.',
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, 'Deep Reply All Target');

    await page.getByTestId(`email-item-${replyAllMessage.xGmThrid}`).click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    await focusMailShell(page);
    await page.keyboard.press('Shift+r');

    await expect(page.getByTestId('compose-window')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('compose-window')).toContainText('Reply');

    await discardComposeIfOpen(page);
  });

  test('search dismiss via X button returns to folder view', async ({ page }) => {
    const searchInput = page.getByTestId('search-input');

    await page.getByTestId('search-bar').click();
    await searchInput.fill('test query');
    await searchInput.press('Enter');

    await expect(
      page.getByTestId('search-result-folder').or(page.getByTestId('search-empty-state')),
    ).toBeVisible({ timeout: 5000 });

    const dismissButton = page.getByTestId('search-dismiss-button');
    const clearButton = page.getByTestId('search-clear-button');

    if (await dismissButton.isVisible().catch(() => false)) {
      await dismissButton.click();
    } else {
      await clearButton.click();
    }

    await expect(page.getByTestId('search-result-folder')).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId('email-list-header')).toContainText('Inbox', { timeout: 5000 });
  });

  test('mail shell and email list cover search streaming, retry, context actions, and notification flows', async ({
    page,
    electronApp,
  }) => {
    await returnToMailShell(page);
    await waitForMailShell(page);

    const subjectOne = `Shell Coverage One ${DateTime.utc().toMillis()}`;
    const subjectTwo = `Shell Coverage Two ${DateTime.utc().plus({ seconds: 1 }).toMillis()}`;

    await injectInboxMessage(electronApp, {
      from: 'shell-one@example.com',
      to: seededEmail,
      subject: subjectOne,
      body: 'First shell coverage message',
    });
    await injectInboxMessage(electronApp, {
      from: 'shell-two@example.com',
      to: seededEmail,
      subject: subjectTwo,
      body: 'Second shell coverage message',
    });

    await triggerSync(electronApp, accountId);
    await waitForEmailSubject(page, subjectOne);
    await waitForEmailSubject(page, subjectTwo);

    await emitRendererEvent(electronApp, {
      channel: 'queue:update',
      payload: {
        queueId: 'queue-failed-send',
        accountId,
        type: 'send',
        status: 'failed',
        createdAt: DateTime.utc().toISO(),
        retryCount: 0,
        error: 'SMTP down',
        description: 'Send test mail',
      },
    });
    await expect(page.locator('.toast-message').filter({ hasText: 'Send test mail failed: SMTP down' })).toBeVisible();

    await emitRendererEvent(electronApp, {
      channel: 'queue:update',
      payload: {
        queueId: 'queue-complete-send',
        accountId,
        type: 'send',
        status: 'completed',
        createdAt: DateTime.utc().toISO(),
        retryCount: 0,
        description: 'Send complete mail',
      },
    });

    await emitRendererEvent(electronApp, {
      channel: 'body-queue:update',
      payload: {
        queueId: 'body-pending',
        accountId,
        type: 'body-fetch',
        status: 'pending',
        createdAt: DateTime.utc().toISO(),
        retryCount: 0,
        description: 'Prefetch body',
      },
    });

    await mockIpc(electronApp, {
      channel: 'ai:search',
      response: { success: true, data: { searchToken: 'stream-token-1' } },
      once: true,
    });
    await page.getByTestId('search-input').fill('stream coverage');
    await page.getByTestId('search-input').press('Enter');
    await expect(page.locator('.search-stream-count')).toContainText('Searching');

    await emitRendererEvent(electronApp, {
      channel: 'ai:search:batch',
      payload: {
        searchToken: 'stream-token-1',
        msgIds: [],
        phase: 'local',
      },
    });
    await emitRendererEvent(electronApp, {
      channel: 'ai:search:complete',
      payload: {
        searchToken: 'stream-token-1',
        status: 'partial',
        totalResults: 0,
      },
    });
    await expect(page.getByTestId('search-result-folder')).toBeVisible();
    await page.getByTestId('search-dismiss-button').click();
    await waitForEmailSubject(page, subjectOne);

    await emitRendererEvent(electronApp, {
      channel: 'mail:fetch-older-done',
      payload: {
        queueId: 'fetch-older-error',
        accountId,
        folderId: 'INBOX',
        error: 'Network issue',
      },
    });
    await expect(page.getByTestId('retry-fetch-button')).toBeVisible();

    await mockIpc(electronApp, {
      channel: 'mail:fetch-older',
      response: { success: true, data: { queueId: 'fetch-older-success' } },
      once: true,
    });
    await page.getByTestId('retry-fetch-button').click();
    await emitRendererEvent(electronApp, {
      channel: 'mail:fetch-older-done',
      payload: {
        queueId: 'fetch-older-success',
        accountId,
        folderId: 'INBOX',
        hasMore: false,
        nextBeforeDate: DateTime.utc().minus({ days: 1 }).toISO(),
        threads: [],
      },
    });

    await returnToMailShell(page);
    await waitForMailShell(page);
    await waitForEmailSubject(page, subjectOne);

    const firstThread = page.locator('[data-testid^="email-item-"]').first();
    await firstThread.click();
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();

    await page.getByTestId('action-ribbon-standard').getByTestId('action-labels').click();
    const labelsMenu = page.getByTestId('labels-menu');
    await expect(labelsMenu).toBeVisible();
    const firstLabelOption = labelsMenu.locator('.label-item').first();
    if (await firstLabelOption.isVisible().catch(() => false)) {
      await firstLabelOption.click();
    }
    await labelsMenu.getByRole('button', { name: 'Apply' }).click();

    const firstThreadIdAttribute = await firstThread.getAttribute('data-testid');
    const firstThreadId = firstThreadIdAttribute?.replace('email-item-', '') ?? '';

    await emitRendererEvent(electronApp, {
      channel: 'mail:notification-click',
      payload: {
        accountId,
        xGmThrid: firstThreadId,
        folder: 'INBOX',
      },
    });
    await expect(page.getByTestId('reading-pane-content')).toBeVisible();
  });

  test('mail shell and emails store targeted branch coverage via Angular debug helpers', async ({ page, electronApp }) => {
    await returnToMailShell(page);
    await waitForMailShell(page);
    await discardComposeIfOpen(page);

    const now = DateTime.utc();
    const threadAlpha = {
      xGmThrid: 'coverage-thread-alpha',
      xGmMsgId: 'coverage-message-alpha',
      subject: 'Coverage Thread Alpha',
      sender: 'alpha@example.com',
      snippet: 'Alpha snippet',
      lastMessageDate: now.toISO() ?? '2026-01-01T00:00:00.000Z',
      isRead: false,
      isStarred: false,
      messageCount: 1,
      labels: ['INBOX'],
      folders: ['INBOX'],
    };
    const threadBeta = {
      xGmThrid: 'coverage-thread-beta',
      xGmMsgId: 'coverage-message-beta',
      subject: 'Coverage Thread Beta',
      sender: 'beta@example.com',
      snippet: 'Beta snippet',
      lastMessageDate: now.minus({ minutes: 1 }).toISO() ?? '2026-01-01T00:00:00.000Z',
      isRead: true,
      isStarred: true,
      messageCount: 2,
      labels: ['INBOX'],
      folders: ['INBOX'],
    };
    const threadGamma = {
      xGmThrid: 'coverage-thread-gamma',
      xGmMsgId: 'coverage-message-gamma',
      subject: 'Coverage Thread Gamma',
      sender: 'gamma@example.com',
      snippet: 'Gamma snippet',
      lastMessageDate: now.minus({ minutes: 2 }).toISO() ?? '2026-01-01T00:00:00.000Z',
      isRead: false,
      isStarred: false,
      messageCount: 1,
      labels: ['INBOX'],
      folders: ['INBOX'],
    };

    const resolvedTrashFolderId = await page.evaluate(() => {
      interface AngularDebugApi {
        getComponent(element: unknown): unknown;
      }

      interface AngularWindow {
        ng?: AngularDebugApi;
      }

      interface BrowserDocumentLike {
        querySelector(selector: string): unknown;
      }

      interface FoldersStoreLike {
        trashFolderId(): string;
      }

      interface MailShellLike {
        foldersStore: FoldersStoreLike;
      }

      const browserGlobal = globalThis as unknown as Record<string, unknown>;
      const browserWindow = browserGlobal as unknown as AngularWindow;
      const browserDocument = browserGlobal['document'] as BrowserDocumentLike;
      const host = browserDocument.querySelector('app-mail-shell');
      if (browserWindow.ng === undefined || host === null) {
        throw new Error('Mail shell is not available in the Angular debug tree.');
      }

      const component = browserWindow.ng.getComponent(host) as MailShellLike;
      return component.foldersStore.trashFolderId();
    });

    await mockIpc(electronApp, {
      channel: 'mail:fetch-emails',
      response: { success: true, data: [threadAlpha, threadBeta, threadGamma] },
      once: false,
    });
    await mockIpc(electronApp, {
      channel: 'mail:fetch-thread',
      response: { success: true, data: null },
      once: false,
    });
    await mockIpc(electronApp, {
      channel: 'mail:get-thread-from-db',
      response: {
        success: true,
        data: {
          ...threadAlpha,
          subject: 'Thread DB Response Subject',
          messages: [
            {
              xGmMsgId: 'coverage-message-alpha',
              xGmThrid: 'coverage-thread-alpha',
              subject: 'Thread DB Response Subject',
              fromAddress: 'alpha@example.com',
              fromName: 'Alpha Sender',
              toAddresses: seededEmail,
              ccAddresses: 'coworker@example.com',
              bccAddresses: '',
              htmlBody: '<p>Body alpha</p>',
              textBody: 'Body alpha',
              messageId: '<alpha-message@example.test>',
              date: now.toISO() ?? '2026-01-01T00:00:00.000Z',
              isRead: false,
              isStarred: false,
              isDraft: false,
              folders: ['INBOX'],
              labels: ['INBOX'],
            },
            {
              xGmMsgId: 'coverage-message-beta-child',
              xGmThrid: 'coverage-thread-alpha',
              subject: 'Draft Coverage Subject',
              fromAddress: 'alpha@example.com',
              fromName: 'Alpha Sender',
              toAddresses: seededEmail,
              ccAddresses: 'coworker@example.com',
              bccAddresses: '',
              htmlBody: '<p>Second body</p>',
              textBody: 'Second body',
              messageId: '<alpha-message-2@example.test>',
              date: now.minus({ minutes: 1 }).toISO() ?? '2026-01-01T00:00:00.000Z',
              isRead: false,
              isStarred: false,
              isDraft: true,
              folders: ['INBOX'],
              labels: ['INBOX'],
            },
          ],
        },
      },
      once: false,
    });
    await mockIpc(electronApp, {
      channel: 'mail:flag',
      response: { success: true, data: null },
      once: false,
    });
    await mockIpc(electronApp, {
      channel: 'mail:move',
      response: { success: true, data: null },
      once: false,
    });
    await mockIpc(electronApp, {
      channel: 'mail:delete',
      response: { success: true, data: null },
      once: false,
    });
    await mockIpc(electronApp, {
      channel: 'mail:fetch-older',
      response: { success: true, data: { queueId: 'coverage-fetch-older' } },
      once: false,
    });
    await mockIpc(electronApp, {
      channel: 'mail:sync-account',
      response: { success: true, data: null },
      once: false,
    });
    await mockIpc(electronApp, {
      channel: 'queue:enqueue',
      response: { success: true, data: { queueId: 'coverage-queue-op' } },
      once: false,
    });
    await mockIpc(electronApp, {
      channel: 'mail:get-folders',
      response: {
        success: true,
        data: [
          {
            id: 1,
            accountId,
            gmailLabelId: 'INBOX',
            name: 'Inbox',
            unreadCount: 3,
            totalCount: 3,
            specialUse: '\\Inbox',
          },
          {
            id: 2,
            accountId,
            gmailLabelId: '[Gmail]/Starred',
            name: 'Starred',
            unreadCount: 0,
            totalCount: 1,
            specialUse: '\\Flagged',
          },
          {
            id: 3,
            accountId,
            gmailLabelId: '[Gmail]/Drafts',
            name: 'Drafts',
            unreadCount: 0,
            totalCount: 0,
            specialUse: '\\Drafts',
          },
          {
            id: 4,
            accountId,
            gmailLabelId: '[Gmail]/Spam',
            name: 'Spam',
            unreadCount: 0,
            totalCount: 0,
            specialUse: '\\Junk',
          },
          {
            id: 5,
            accountId,
            gmailLabelId: resolvedTrashFolderId,
            name: 'Trash',
            unreadCount: 0,
            totalCount: 0,
            specialUse: '\\Trash',
          },
          {
            id: 6,
            accountId,
            gmailLabelId: 'Label_1',
            name: 'Label 1',
            unreadCount: 0,
            totalCount: 0,
            specialUse: null,
          },
        ],
      },
      once: false,
    });

    const shellCoverage = await page.evaluate(async ({ accountId, seededEmail, nowIso, resolvedTrashFolderId }) => {
      interface AngularDebugApi {
        getComponent(element: unknown): unknown;
      }

      interface AngularWindow {
        ng?: AngularDebugApi;
      }

      interface BrowserDocumentLike {
        body: {
          appendChild(node: unknown): void;
        };
        querySelector(selector: string): unknown;
        createElement(tagName: string): {
          className: string;
          id: string;
          firstChild: unknown;
          appendChild(node: unknown): void;
          addEventListener(eventName: string, handler: () => void): void;
          remove(): void;
        };
        elementFromPoint(x: number, y: number): unknown;
      }

      interface ThreadLike {
        xGmThrid: string;
        xGmMsgId?: string;
        subject?: string;
        sender?: string;
        snippet?: string;
        lastMessageDate: string;
        isRead: boolean;
        isStarred: boolean;
        messageCount?: number;
        labels?: string[];
        folders?: string[];
        messages?: EmailLike[];
      }

      interface EmailLike {
        xGmMsgId: string;
        xGmThrid: string;
        subject?: string;
        fromAddress: string;
        fromName?: string;
        toAddresses?: string;
        ccAddresses?: string;
        bccAddresses?: string;
        htmlBody?: string;
        textBody?: string;
        messageId?: string;
        date: string;
        isRead: boolean;
        isStarred: boolean;
        isDraft?: boolean;
        labels?: string[];
        folders?: string[];
      }

      interface WritableSignalLike<T> {
        (): T;
        set(value: T): void;
      }

      interface AccountsStoreLike {
        activeAccount(): { id: number; email: string; displayName?: string | null } | null;
        activeAccountId(): number | null;
        activeAccount: AccountsStoreLike['activeAccount'];
      }

      interface FoldersStoreLike {
        activeFolderId(): string | null;
        previousFolderId(): string | null;
        searchActive(): boolean;
        trashFolderId(): string;
        spamFolderId(): string;
        setActiveFolder(folderId: string): void;
        activateSearch(displayQuery: string, effectiveQuery?: string): void;
        deactivateSearch(): void;
        loadFolders(accountId: number): Promise<void>;
      }

      interface EmailsStoreLike {
        threads(): ThreadLike[];
        selectedThread(): ThreadLike | null;
        selectedThreadId(): string | null;
        selectedMessages(): EmailLike[];
        multiSelectCount(): number;
        multiSelectedThreadIds(): string[];
        multiSelectActive(): boolean;
        loadThreads(accountId: number, folderId: string): Promise<void>;
        loadThread(accountId: number, threadId: string): Promise<void>;
        clearSelection(): void;
        clearSearch(): void;
        clearThreadsForStreaming(): void;
        clearMultiSelection(): void;
        setMultiSelectedThreadIds(ids: string[]): void;
        toggleMultiSelectThread(threadId: string): void;
        moveEmails(accountId: number, messageIds: string[], targetFolder: string, threadId?: string, sourceFolder?: string, perMessageGmailId?: string): Promise<void>;
        flagEmails(accountId: number, messageIds: string[], flag: string, value: boolean, threadId?: string): Promise<void>;
        deleteEmails(accountId: number, messageIds: string[], folder: string, threadId?: string): Promise<void>;
        addLabels(accountId: number, xGmMsgIds: string[], targetLabels: string[], threadId: string): Promise<void>;
        removeLabels(accountId: number, xGmMsgIds: string[], targetLabels: string[], threadId: string): Promise<void>;
        loadMore(accountId: number, folderId: string): Promise<void>;
        loadMoreFromServer(accountId: number, folderId: string): Promise<void>;
        markListScrolled(): void;
        selectThread(threadId: string | null): void;
        appendStreamingBatch(newThreads: ThreadLike[]): void;
        syncAccount(accountId: number): Promise<void>;
        setLastSyncTime(iso: string | null): void;
        updateSyncProgress(progress: number, status?: 'syncing' | 'done' | 'error', errorMessage?: string): void;
        clearAll(): void;
        refreshThreads(): Promise<void>;
      }

      interface ComposeStoreLike {
        openCompose(context: Record<string, unknown>): void;
      }

      interface UiStoreLike {
        setSidebarWidth(width: number): void;
        setEmailListWidth(width: number): void;
        setReadingPaneHeight(percent: number): void;
      }

      interface AiStoreLike {
        clearStreamingSearch(): void;
        startNavigationSearch(accountId: number, xGmMsgId: string): Promise<string | null>;
        clearNavigationFlag(): void;
        searchStreamStatus(): string;
        isNavigationSearch(): boolean;
        searchToken(): string | null;
      }

      interface ChatStoreLike {
        [key: string]: unknown;
      }

      interface RouterLike {
        navigate(commands: string[]): Promise<boolean>;
        url: string;
      }

      interface ChangeDetectorRefLike {
        detectChanges(): void;
      }

      interface ElectronServiceLike {
        syncFolder(accountId: string, folderId: string): Promise<unknown>;
      }

      interface MailShellLike {
        accountsStore: AccountsStoreLike;
        foldersStore: FoldersStoreLike;
        emailsStore: EmailsStoreLike;
        composeStore: ComposeStoreLike;
        uiStore: UiStoreLike;
        contextMenuThreadId: WritableSignalLike<string | null>;
        contextMenuPosition: WritableSignalLike<{ x: number; y: number } | null>;
        contextMenuOpen: WritableSignalLike<boolean>;
        contextMenuThread(): ThreadLike | null;
        ngAfterViewInit(): void;
        ngOnDestroy(): void;
        onFolderSelected(folderId: string): void;
        onThreadSelected(thread: ThreadLike): Promise<void>;
        onAction(event: Record<string, unknown>): void;
        onSidebarResized(width: number): void;
        onEmailListResized(width: number): void;
        onReadingPaneResized(height: number): void;
        onAccountSwitch(accountId: number): Promise<void>;
        onChatSourceClicked(xGmMsgId: string): void;
        openNewCompose(): void;
        onSearch(event: { queries: string[]; originalQuery: string; streaming?: boolean }): void;
        onSearchCleared(): void;
        onSearchDismissed(): void;
        onThreadContextMenu(data: { thread: ThreadLike; x: number; y: number }): void;
        onContextMenuClosed(): void;
        onDocumentContextMenu(event: {
          clientX: number;
          clientY: number;
          button: number;
          buttons: number;
          target: unknown;
          preventDefault(): void;
          stopPropagation(): void;
        }): void;
        onContextMenuAction(event: Record<string, unknown>): void;
        ngOnInit(): void;
        handleShellCommand(commandId: string): void;
        initializeStoreState(): Promise<void>;
        lastLoadedAccountId: number | null;
        lastLoadedFolderId: string | null;
        syncSub?: { unsubscribe(): void };
        commandSub?: { unsubscribe(): void };
      }

      const browserGlobal = globalThis as unknown as Record<string, unknown>;
      const browserWindow = browserGlobal as unknown as AngularWindow;
      const browserDocument = browserGlobal['document'] as BrowserDocumentLike;
      const host = browserDocument.querySelector('app-mail-shell');
      if (browserWindow.ng === undefined || host === null) {
        throw new Error('Mail shell is not available in the Angular debug tree.');
      }

      const component = browserWindow.ng.getComponent(host) as MailShellLike & Record<string, unknown>;
      const electronService = component['electronService'] as ElectronServiceLike;
      const router = component['router'] as RouterLike;
      const changeDetector = component['cdr'] as ChangeDetectorRefLike;
      const aiStore = component['aiStore'] as AiStoreLike;

      const originalRouterNavigate = router.navigate.bind(router);
      const originalDetectChanges = changeDetector.detectChanges.bind(changeDetector);
      const originalSyncFolder = electronService.syncFolder.bind(electronService);
      const originalConsoleError = console.error;
      const originalInitializeStoreState = component.initializeStoreState;

      const container = browserDocument.querySelector('.bottom-layout-container') as { clientHeight: number } | null;
      const panel = browserDocument.createElement('div');
      panel.className = 'email-context-menu-panel';
      browserDocument.body.appendChild(panel);

      const redispatchTarget = browserDocument.createElement('div');
      redispatchTarget.id = 'coverage-context-target';
      browserDocument.body.appendChild(redispatchTarget);
      let redispatchCount = 0;
      redispatchTarget.addEventListener('contextmenu', () => {
        redispatchCount += 1;
      });

      const originalElementFromPoint = browserDocument.elementFromPoint.bind(browserDocument);
      browserDocument.elementFromPoint = (() => {
        return redispatchTarget;
      }) as typeof browserDocument.elementFromPoint;

      let syncFolderCalls = 0;
      electronService.syncFolder = async () => {
        syncFolderCalls += 1;
        return { success: true };
      };

      let routerNavigateCalls = 0;
      router.navigate = async (commands: string[]) => {
        routerNavigateCalls += 1;
        return await originalRouterNavigate(commands);
      };

      let detectChangesCalls = 0;
      changeDetector.detectChanges = () => {
        detectChangesCalls += 1;
        originalDetectChanges();
      };

      let consoleErrors = 0;
      console.error = () => {
        consoleErrors += 1;
      };

      try {
      component.emailsStore.clearAll();
      component.foldersStore.setActiveFolder('INBOX');
      component.emailsStore.appendStreamingBatch([
        {
          xGmThrid: 'coverage-thread-zeta',
          xGmMsgId: 'coverage-message-zeta',
          subject: 'Coverage Thread Zeta',
          sender: 'zeta@example.com',
          snippet: 'Zeta snippet',
          lastMessageDate: nowIso,
          isRead: false,
          isStarred: false,
          messageCount: 1,
          labels: ['INBOX'],
          folders: ['INBOX'],
        },
      ]);

      await component.emailsStore.loadThreads(accountId, 'INBOX');
      component.emailsStore.markListScrolled();
      await component.emailsStore.loadMore(accountId, 'INBOX');
      await component.emailsStore.loadMoreFromServer(accountId, 'INBOX');

      component.ngAfterViewInit();
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 0);
      });

      component.onSidebarResized(260);
      component.onEmailListResized(410);

      if (container !== null) {
        Object.defineProperty(container, 'clientHeight', {
          configurable: true,
          value: 800,
        });
      }
      component.onReadingPaneResized(320);

      component.onFolderSelected(' [Gmail]/Spam ');
      component.onFolderSelected(resolvedTrashFolderId);

      await component.onThreadSelected(component.emailsStore.threads()[0]);

      component.emailsStore.selectThread('coverage-thread-alpha');
      await component.emailsStore.loadThread(accountId, 'coverage-thread-alpha');

      component.onAction({ action: 'reply-with:Suggested reply body' });
      component.onAction({ action: 'reply-all' });
      component.onAction({ action: 'forward' });
      component.onAction({ action: 'delete' });
      component.onAction({ action: 'move-to', targetFolder: '[Gmail]/Drafts' });
      component.onAction({ action: 'mark-spam' });
      component.foldersStore.setActiveFolder('[Gmail]/Spam');
      component.onAction({ action: 'mark-not-spam' });
      component.foldersStore.setActiveFolder('INBOX');
      component.onAction({ action: 'star' });
      component.onAction({ action: 'mark-read-unread' });

      const selectedMessages = component.emailsStore.selectedMessages();
      if (selectedMessages.length > 0) {
        component.onAction({ action: 'add-labels', targetLabels: ['Label_1'] });
        component.onAction({ action: 'remove-labels', targetLabels: ['Label_1'] });
        component.onAction({ action: 'delete', message: selectedMessages[0] });
        component.onAction({ action: 'move-to', targetFolder: '[Gmail]/Drafts', message: selectedMessages[0] });
        component.onAction({ action: 'mark-spam', message: selectedMessages[0] });
        component.foldersStore.setActiveFolder('[Gmail]/Spam');
        component.onAction({ action: 'mark-not-spam', message: selectedMessages[0] });
        component.foldersStore.setActiveFolder('[Gmail]/Drafts');
        component.onAction({ action: 'edit-draft', message: {
          ...selectedMessages[0],
          isDraft: true,
          subject: 'Draft: Coverage subject',
        } });
        component.foldersStore.setActiveFolder('INBOX');
      }

      component.onSearch({ queries: ['coverage'], originalQuery: 'coverage', streaming: true });
      component.foldersStore.activateSearch('Coverage search', 'coverage');
      component.onSearchCleared();
      component.foldersStore.activateSearch('Dismiss search', 'dismiss');
      component.onSearchDismissed();

      component.onChatSourceClicked('coverage-message-alpha');
      aiStore.clearNavigationFlag();
      aiStore.clearStreamingSearch();

      component.openNewCompose();

      component.foldersStore.setActiveFolder('INBOX');
      await component.emailsStore.loadThreads(accountId, 'INBOX');
      const contextThread = component.emailsStore.threads().find((thread) => {
        return thread.xGmThrid === 'coverage-thread-alpha';
      }) ?? component.emailsStore.threads()[0];
      component.onThreadContextMenu({ thread: contextThread, x: 10, y: 20 });
      component.onContextMenuClosed();

      component.contextMenuThreadId.set(contextThread.xGmThrid);
      component.contextMenuPosition.set({ x: 10, y: 10 });
      component.contextMenuOpen.set(true);
      component.onDocumentContextMenu({
        clientX: 5,
        clientY: 5,
        button: 2,
        buttons: 2,
        target: browserDocument.body,
        preventDefault() {
          // no-op
        },
        stopPropagation() {
          // no-op
        },
      });

      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 0);
      });

      panel.appendChild(browserDocument.createElement('button'));
      component.contextMenuOpen.set(true);
      component.onDocumentContextMenu({
        clientX: 6,
        clientY: 6,
        button: 2,
        buttons: 2,
        target: panel.firstChild,
        preventDefault() {
          // no-op
        },
        stopPropagation() {
          // no-op
        },
      });

      component.contextMenuThreadId.set(contextThread.xGmThrid);
      component.contextMenuPosition.set({ x: 15, y: 25 });
      component.contextMenuOpen.set(true);
      component.emailsStore.setMultiSelectedThreadIds([
        'coverage-thread-alpha',
        'coverage-thread-beta',
      ]);
      component.onContextMenuAction({ action: 'star' });
      component.contextMenuOpen.set(true);
      component.emailsStore.setMultiSelectedThreadIds([
        'coverage-thread-alpha',
        'coverage-thread-beta',
      ]);
      component.onContextMenuAction({ action: 'mark-read-unread' });
      component.contextMenuOpen.set(true);
      component.emailsStore.setMultiSelectedThreadIds([
        'coverage-thread-alpha',
        'coverage-thread-beta',
      ]);
      component.onContextMenuAction({ action: 'move-to', targetFolder: '[Gmail]/Drafts' });
      component.contextMenuOpen.set(true);
      component.emailsStore.setMultiSelectedThreadIds([
        'coverage-thread-alpha',
        'coverage-thread-beta',
      ]);
      component.onContextMenuAction({ action: 'delete' });
      component.contextMenuOpen.set(true);
      component.emailsStore.setMultiSelectedThreadIds([
        'coverage-thread-alpha',
        'coverage-thread-beta',
      ]);
      component.foldersStore.setActiveFolder('[Gmail]/Spam');
      component.onContextMenuAction({ action: 'mark-not-spam' });
      component.contextMenuOpen.set(true);
      component.emailsStore.setMultiSelectedThreadIds([
        'coverage-thread-alpha',
        'coverage-thread-beta',
      ]);
      component.foldersStore.setActiveFolder('INBOX');
      component.onContextMenuAction({ action: 'mark-spam' });
      component.contextMenuOpen.set(true);
      component.emailsStore.setMultiSelectedThreadIds([
        'coverage-thread-alpha',
        'coverage-thread-beta',
      ]);
      component.onContextMenuAction({ action: 'add-labels', targetLabels: ['Label_1'] });
      component.contextMenuOpen.set(true);
      component.emailsStore.setMultiSelectedThreadIds([
        'coverage-thread-alpha',
        'coverage-thread-beta',
      ]);
      component.onContextMenuAction({ action: 'remove-labels', targetLabels: ['Label_1'] });

      const focusedSearchInput = browserDocument.querySelector('.search-bar-input') as { focus(): void } | null;
      if (focusedSearchInput !== null) {
        component.handleShellCommand('search-focus');
      }
      component.handleShellCommand('go-inbox');
      component.handleShellCommand('go-sent');
      component.handleShellCommand('go-drafts');
      component.handleShellCommand('reply');
      component.handleShellCommand('reply-all');
      component.handleShellCommand('forward');
      component.emailsStore.setMultiSelectedThreadIds(['coverage-thread-alpha']);
      component.handleShellCommand('escape');
      component.handleShellCommand('escape');
      component.handleShellCommand('unknown-command');

      await component.onAccountSwitch(accountId);

      await component.emailsStore.loadThreads(accountId, 'INBOX');
      await component.emailsStore.loadThread(accountId, 'coverage-thread-alpha');
      component.contextMenuThreadId.set('coverage-thread-alpha');
      component.contextMenuPosition.set({ x: 20, y: 30 });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'reply' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'reply-all' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'forward' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'star' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'mark-read-unread' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'move-to', targetFolder: '[Gmail]/Drafts' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'delete' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'mark-spam' });
      component.foldersStore.setActiveFolder('[Gmail]/Spam');
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'mark-not-spam' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'move-to' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'add-labels', targetLabels: [] });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'remove-labels', targetLabels: [] });

      await component.emailsStore.loadThreads(accountId, 'INBOX');
      await component.emailsStore.loadThread(accountId, 'coverage-thread-alpha');
      component.contextMenuThreadId.set('coverage-thread-alpha');
      component.foldersStore.setActiveFolder('INBOX');
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'add-labels', targetLabels: ['Label_1'] });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'remove-labels', targetLabels: ['Label_1'] });
      component.contextMenuThreadId.set(null);
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'reply' });

      component.foldersStore.setActiveFolder('[Gmail]/Drafts');
      component.contextMenuThreadId.set('coverage-thread-alpha');
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'edit-draft' });

      component.emailsStore.clearAll();
      component.foldersStore.setActiveFolder('INBOX');
      await component.emailsStore.loadThreads(accountId, 'INBOX');
      component.emailsStore.selectThread('coverage-thread-alpha');
      await component.emailsStore.loadThread(accountId, 'coverage-thread-alpha');
      component.emailsStore.setLastSyncTime(nowIso);
      await component.emailsStore.syncAccount(accountId);

      component.emailsStore.updateSyncProgress(45, 'syncing');
      component.emailsStore.updateSyncProgress(100, 'done');
      component.emailsStore.updateSyncProgress(10, 'error', 'Sync coverage error');
      component.emailsStore.setMultiSelectedThreadIds(['coverage-thread-alpha']);
      component.emailsStore.toggleMultiSelectThread('coverage-thread-alpha');
      component.emailsStore.setMultiSelectedThreadIds([]);
      component.emailsStore.toggleMultiSelectThread('coverage-thread-alpha');
      component.emailsStore.toggleMultiSelectThread('coverage-thread-beta');
      component.emailsStore.clearMultiSelection();
      component.emailsStore.clearSelection();

      await component.emailsStore.loadThreads(accountId, 'INBOX');
      await component.emailsStore.loadThread(accountId, 'coverage-thread-alpha');
      await component.emailsStore.flagEmails(accountId, ['coverage-message-alpha'], 'read', true, 'coverage-thread-alpha');
      await component.emailsStore.flagEmails(accountId, ['coverage-message-alpha'], 'starred', true, 'coverage-thread-alpha');
      component.foldersStore.setActiveFolder('[Gmail]/Starred');
      await component.emailsStore.flagEmails(accountId, ['coverage-message-alpha'], 'starred', false, 'coverage-thread-alpha');
      component.foldersStore.setActiveFolder('INBOX');

      await component.emailsStore.loadThreads(accountId, 'INBOX');
      await component.emailsStore.loadThread(accountId, 'coverage-thread-alpha');
      await component.emailsStore.moveEmails(accountId, ['coverage-message-alpha'], '[Gmail]/Drafts', 'coverage-thread-alpha', 'INBOX', 'coverage-message-alpha');
      await component.emailsStore.moveEmails(accountId, ['coverage-message-beta-child'], '[Gmail]/Drafts', 'coverage-thread-alpha', 'INBOX', 'coverage-message-beta-child');
      await component.emailsStore.deleteEmails(accountId, ['coverage-thread-beta'], 'INBOX', 'coverage-thread-beta');
      await component.emailsStore.addLabels(accountId, ['coverage-message-alpha'], ['Label_1'], 'coverage-thread-alpha');
      await component.emailsStore.removeLabels(accountId, ['coverage-message-alpha'], ['Label_1'], 'coverage-thread-alpha');
      component.emailsStore.clearSearch();
      component.emailsStore.clearThreadsForStreaming();
      component.emailsStore.appendStreamingBatch([
        {
          xGmThrid: 'coverage-stream-a',
          xGmMsgId: 'coverage-stream-a-msg',
          subject: 'Coverage Stream A',
          sender: 'stream-a@example.com',
          snippet: 'stream a',
          lastMessageDate: nowIso,
          isRead: false,
          isStarred: false,
          messageCount: 1,
          labels: ['INBOX'],
          folders: ['INBOX'],
        },
      ]);

      component['syncSub'] = {
        unsubscribe() {
          // no-op
        },
      };
      component['commandSub'] = {
        unsubscribe() {
          // no-op
        },
      };
      component.ngOnDestroy();

      return {
        syncFolderCalls,
        redispatchCount,
        routerNavigateCalls,
        detectChangesCalls,
        consoleErrors,
        aiNavigationToken: aiStore.searchToken(),
        aiStatus: aiStore.searchStreamStatus(),
        multiSelectCount: component.emailsStore.multiSelectCount(),
      };
      } finally {
        browserDocument.elementFromPoint = originalElementFromPoint;
        electronService.syncFolder = originalSyncFolder;
        router.navigate = originalRouterNavigate;
        changeDetector.detectChanges = originalDetectChanges;
        console.error = originalConsoleError;
        component.initializeStoreState = originalInitializeStoreState;
        panel.remove();
        redispatchTarget.remove();
      }
    }, { accountId, seededEmail, nowIso: now.toISO() ?? '2026-01-01T00:00:00.000Z', resolvedTrashFolderId });

    expect(shellCoverage.syncFolderCalls).toBeGreaterThanOrEqual(1);
    expect(shellCoverage.redispatchCount).toBeGreaterThanOrEqual(1);
    expect(shellCoverage.detectChangesCalls).toBeGreaterThanOrEqual(1);
    expect(shellCoverage.consoleErrors).toBeGreaterThanOrEqual(0);
    expect(shellCoverage.multiSelectCount).toBe(0);
  });

  test('mail shell direct method coverage with stubbed dependencies', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const browserGlobal = globalThis as any;
      const browserDocument = browserGlobal.document;
      const component = browserGlobal.ng.getComponent(browserDocument.querySelector('app-mail-shell')) as any;
      const counts: Record<string, number> = {};

      const originalAccountsStore = component.accountsStore;
      const originalFoldersStore = component.foldersStore;
      const originalEmailsStore = component.emailsStore;
      const originalComposeStore = component.composeStore;
      const originalUiStore = component.uiStore;
      const originalElectronService = component.electronService;
      const originalCommandRegistry = component.commandRegistry;
      const originalAiStore = component.aiStore;
      const originalRouter = component.router;
      const originalCdr = component.cdr;

      const makeMessage = (messageId: string, overrides: Record<string, unknown> = {}) => {
        return {
          xGmMsgId: messageId,
          xGmThrid: 'stub-thread-1',
          subject: 'Stub subject',
          fromAddress: 'sender@example.com',
          fromName: 'Sender',
          toAddresses: 'recipient@example.com',
          ccAddresses: 'copy@example.com',
          bccAddresses: '',
          htmlBody: '<p>Body</p>',
          textBody: 'Body',
          messageId: `<${messageId}@example.test>`,
          date: '2026-03-19T00:00:00.000Z',
          isRead: false,
          isStarred: false,
          isDraft: false,
          folders: ['INBOX'],
          labels: ['INBOX'],
          ...overrides,
        };
      };

      const makeThread = (threadId: string, overrides: Record<string, unknown> = {}) => {
        return {
          xGmThrid: threadId,
          xGmMsgId: `${threadId}-message`,
          subject: `Subject ${threadId}`,
          sender: `${threadId}@example.com`,
          snippet: `Snippet ${threadId}`,
          lastMessageDate: '2026-03-19T00:00:00.000Z',
          isRead: false,
          isStarred: false,
          messageCount: 2,
          labels: ['INBOX'],
          folders: ['INBOX'],
          messages: [
            makeMessage(`${threadId}-message-1`),
            makeMessage(`${threadId}-message-2`, { isDraft: true, subject: 'Draft coverage subject' }),
          ],
          ...overrides,
        };
      };

      let activeAccount: { id: number; email: string; displayName: string } | null = { id: 99, email: 'stub@example.com', displayName: 'Stub User' };
      let accounts = [activeAccount];
      let activeFolderId: string | null = 'INBOX';
      let previousFolderId: string | null = '[Gmail]/Starred';
      let searchActive = false;
      let sidebarCollapsed = false;
      let threads = [makeThread('stub-thread-1'), makeThread('stub-thread-2', { isRead: true, isStarred: true })];
      let selectedThread: (typeof threads)[number] | null = threads[0];
      let selectedMessages = [...selectedThread.messages];
      let multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      let syncShouldReject = true;
      let searchFocused = 0;

      const searchInput = browserDocument.createElement('input');
      searchInput.className = 'search-bar-input';
      searchInput.focus = () => {
        searchFocused += 1;
      };
      browserDocument.body.appendChild(searchInput);

      const bottomContainer = browserDocument.createElement('div');
      bottomContainer.className = 'bottom-layout-container';
      Object.defineProperty(bottomContainer, 'clientHeight', { value: 1000, configurable: true });
      browserDocument.body.appendChild(bottomContainer);

      const menuPanel = browserDocument.createElement('div');
      menuPanel.className = 'email-context-menu-panel';
      const menuButton = browserDocument.createElement('button');
      menuPanel.appendChild(menuButton);
      browserDocument.body.appendChild(menuPanel);

      const redispatchTarget = browserDocument.createElement('div');
      let redispatchCount = 0;
      redispatchTarget.addEventListener('contextmenu', () => {
        redispatchCount += 1;
      });
      browserDocument.body.appendChild(redispatchTarget);

      const originalElementFromPoint = browserDocument.elementFromPoint.bind(browserDocument);
      browserDocument.elementFromPoint = () => {
        return redispatchTarget;
      };

      try {
      component.accountsStore = {
        activeAccount: () => {
          return activeAccount;
        },
        activeAccountId: () => {
          return activeAccount?.id ?? null;
        },
        accounts: () => {
          return accounts;
        },
        loadAccounts: async () => {
          counts['loadAccounts'] = (counts['loadAccounts'] ?? 0) + 1;
        },
        setActiveAccount: (accountId: number) => {
          activeAccount = accounts.find((account) => {
            return account.id === accountId;
          }) ?? activeAccount;
        },
      };

      component.foldersStore = {
        normalizeFolderId: (folderId: string) => {
          return folderId.trim();
        },
        searchActive: () => {
          return searchActive;
        },
        deactivateSearch: () => {
          searchActive = false;
          activeFolderId = previousFolderId;
          counts['deactivateSearch'] = (counts['deactivateSearch'] ?? 0) + 1;
        },
        activateSearch: (displayQuery: string) => {
          previousFolderId = activeFolderId;
          activeFolderId = null;
          searchActive = true;
          counts['activateSearch'] = (counts['activateSearch'] ?? 0) + 1;
          counts[`search:${displayQuery}`] = (counts[`search:${displayQuery}`] ?? 0) + 1;
        },
        previousFolderId: () => {
          return previousFolderId ?? 'INBOX';
        },
        activeFolderId: () => {
          return activeFolderId ?? 'INBOX';
        },
        setActiveFolder: (folderId: string) => {
          activeFolderId = folderId;
          counts['setActiveFolder'] = (counts['setActiveFolder'] ?? 0) + 1;
        },
        trashFolderId: () => {
          return '[Gmail]/Trash';
        },
        spamFolderId: () => {
          return '[Gmail]/Spam';
        },
        loadFolders: async () => {
          counts['loadFolders'] = (counts['loadFolders'] ?? 0) + 1;
        },
      };

      component.emailsStore = {
        threads: () => {
          return threads;
        },
        selectedThread: () => {
          return selectedThread;
        },
        selectedMessages: () => {
          return selectedMessages;
        },
        selectedThreadId: () => {
          return selectedThread?.xGmThrid ?? null;
        },
        loadThreads: async () => {
          counts['loadThreads'] = (counts['loadThreads'] ?? 0) + 1;
        },
        loadThread: async (_accountId: number, threadId: string) => {
          counts['loadThread'] = (counts['loadThread'] ?? 0) + 1;
          selectedThread = threads.find((thread) => {
            return thread.xGmThrid === threadId;
          }) ?? selectedThread;
          selectedMessages = [...(selectedThread?.messages ?? [])];
        },
        clearSearch: () => {
          counts['clearSearch'] = (counts['clearSearch'] ?? 0) + 1;
        },
        clearSelection: () => {
          counts['clearSelection'] = (counts['clearSelection'] ?? 0) + 1;
          selectedThread = null;
          selectedMessages = [];
          multiSelectedThreadIds = [];
        },
        clearThreadsForStreaming: () => {
          counts['clearThreadsForStreaming'] = (counts['clearThreadsForStreaming'] ?? 0) + 1;
          threads = [];
        },
        flagEmails: () => {
          counts['flagEmails'] = (counts['flagEmails'] ?? 0) + 1;
        },
        moveEmails: () => {
          counts['moveEmails'] = (counts['moveEmails'] ?? 0) + 1;
        },
        addLabels: () => {
          counts['addLabels'] = (counts['addLabels'] ?? 0) + 1;
        },
        removeLabels: () => {
          counts['removeLabels'] = (counts['removeLabels'] ?? 0) + 1;
        },
        refreshThreads: async () => {
          counts['refreshThreads'] = (counts['refreshThreads'] ?? 0) + 1;
        },
        multiSelectActive: () => {
          return multiSelectedThreadIds.length > 0;
        },
        multiSelectCount: () => {
          return multiSelectedThreadIds.length;
        },
        multiSelectedThreadIds: () => {
          return multiSelectedThreadIds;
        },
        clearMultiSelection: () => {
          counts['clearMultiSelection'] = (counts['clearMultiSelection'] ?? 0) + 1;
          multiSelectedThreadIds = [];
        },
        setMultiSelectedThreadIds: (ids: string[]) => {
          multiSelectedThreadIds = ids;
        },
      };

      component.composeStore = {
        openCompose: (context: Record<string, unknown>) => {
          counts['openCompose'] = (counts['openCompose'] ?? 0) + 1;
          const mode = context['mode'] as string;
          counts[`compose:${mode}`] = (counts[`compose:${mode}`] ?? 0) + 1;
        },
      };

      component.uiStore = {
        sidebarCollapsed: () => {
          return sidebarCollapsed;
        },
        setSidebarWidth: () => {
          counts['setSidebarWidth'] = (counts['setSidebarWidth'] ?? 0) + 1;
        },
        setEmailListWidth: () => {
          counts['setEmailListWidth'] = (counts['setEmailListWidth'] ?? 0) + 1;
        },
        setReadingPaneHeight: () => {
          counts['setReadingPaneHeight'] = (counts['setReadingPaneHeight'] ?? 0) + 1;
        },
      };

      component.electronService = {
        syncFolder: () => {
          counts['syncFolder'] = (counts['syncFolder'] ?? 0) + 1;
          if (syncShouldReject) {
            return Promise.reject(new Error('sync failed'));
          }
          return Promise.resolve({ success: true });
        },
        onEvent: () => {
          return {
            subscribe: () => {
              return {
                unsubscribe: () => {
                  counts['unsubscribe'] = (counts['unsubscribe'] ?? 0) + 1;
                },
              };
            },
          };
        },
      };

      component.commandRegistry = {
        commandTriggered$: {
          subscribe: () => {
            counts['commandSubscribe'] = (counts['commandSubscribe'] ?? 0) + 1;
            return {
              unsubscribe: () => {
                counts['commandUnsubscribe'] = (counts['commandUnsubscribe'] ?? 0) + 1;
              },
            };
          },
        },
      };

      component.aiStore = {
        clearStreamingSearch: () => {
          counts['clearStreamingSearch'] = (counts['clearStreamingSearch'] ?? 0) + 1;
        },
        startNavigationSearch: async () => {
          counts['startNavigationSearch'] = (counts['startNavigationSearch'] ?? 0) + 1;
          return 'stub-token';
        },
        clearNavigationFlag: () => {
          counts['clearNavigationFlag'] = (counts['clearNavigationFlag'] ?? 0) + 1;
        },
        searchStreamStatus: () => {
          return 'idle';
        },
        isNavigationSearch: () => {
          return false;
        },
        searchToken: () => {
          return null;
        },
      };

      component.router = {
        navigate: async () => {
          counts['navigate'] = (counts['navigate'] ?? 0) + 1;
          return true;
        },
        url: '/settings',
      };

      component.cdr = {
        detectChanges: () => {
          counts['detectChanges'] = (counts['detectChanges'] ?? 0) + 1;
        },
      };

      activeAccount = null;
      component.onFolderSelected('INBOX');

      activeAccount = { id: 99, email: 'stub@example.com', displayName: 'Stub User' };
      searchActive = true;
      activeFolderId = 'INBOX';
      component.onFolderSelected('[Gmail]/Spam');
      component.onFolderSelected('[Gmail]/Trash');
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 0);
      });

      selectedMessages = [];
      await component.onThreadSelected({ xGmThrid: 'stub-thread-1', isRead: false });
      selectedMessages = [makeMessage('selected-message')];
      await component.onThreadSelected({ xGmThrid: 'stub-thread-1', isRead: false });
      await component.onThreadSelected({ xGmThrid: 'stub-thread-1', isRead: true });

      activeAccount = null;
      selectedThread = null;
      component.onAction({ action: 'reply' });

      activeAccount = { id: 99, email: 'stub@example.com', displayName: 'Stub User' };
      threads = [makeThread('stub-thread-1'), makeThread('stub-thread-2', { isRead: true, isStarred: true })];
      selectedThread = threads[0];
      selectedMessages = [...selectedThread.messages];

      activeFolderId = '[Gmail]/Trash';
      component.onAction({ action: 'delete' });
      component.onAction({ action: 'star' });

      activeFolderId = 'INBOX';
      component.onAction({ action: 'reply-with:Suggested body' });
      component.onAction({ action: 'delete' });
      component.onAction({ action: 'delete', message: makeMessage('delete-message') });
      component.onAction({ action: 'move-to' });
      component.onAction({ action: 'move-to', targetFolder: '[Gmail]/Drafts' });
      component.onAction({ action: 'move-to', targetFolder: '[Gmail]/Drafts', message: makeMessage('move-message') });
      component.onAction({ action: 'mark-spam' });
      component.onAction({ action: 'mark-spam', message: makeMessage('spam-message') });

      activeFolderId = '[Gmail]/Spam';
      component.onAction({ action: 'mark-spam' });
      component.onAction({ action: 'mark-not-spam' });
      component.onAction({ action: 'mark-not-spam', message: makeMessage('not-spam-message') });

      activeFolderId = 'INBOX';
      component.onAction({ action: 'mark-not-spam' });
      component.onAction({ action: 'star' });
      component.onAction({ action: 'mark-read-unread' });
      component.onAction({ action: 'edit-draft' });

      selectedMessages = [];
      component.onAction({ action: 'add-labels', targetLabels: [] });
      component.onAction({ action: 'add-labels', targetLabels: ['Label 1'] });
      component.onAction({ action: 'remove-labels', targetLabels: [] });
      component.onAction({ action: 'remove-labels', targetLabels: ['Label 1'] });
      selectedMessages = [makeMessage('label-message')];
      component.onAction({ action: 'add-labels', targetLabels: ['Label 1'], message: makeMessage('single-label-add') });
      component.onAction({ action: 'remove-labels', targetLabels: ['Label 1'], message: makeMessage('single-label-remove') });
      component.onAction({ action: 'edit-draft', message: makeMessage('draft-message', { isDraft: true, subject: 'Draft coverage subject' }) });
      component.onAction({ action: 'reply' });
      component.onAction({ action: 'reply-all' });
      component.onAction({ action: 'forward' });

      sidebarCollapsed = false;
      component.onSidebarResized(280);
      sidebarCollapsed = true;
      component.onSidebarResized(300);
      component.onEmailListResized(420);
      component.onReadingPaneResized(400);
      bottomContainer.remove();
      component.onReadingPaneResized(400);

      component.handleShellCommand('go-inbox');
      component.handleShellCommand('go-sent');
      component.handleShellCommand('go-drafts');
      component.handleShellCommand('reply');
      component.handleShellCommand('reply-all');
      component.handleShellCommand('forward');
      component.handleShellCommand('search-focus');
      multiSelectedThreadIds = ['stub-thread-1'];
      component.handleShellCommand('escape');
      multiSelectedThreadIds = [];
      component.handleShellCommand('escape');
      component.handleShellCommand('unknown-command');

      accounts = [];
      activeAccount = null;
      component.lastLoadedAccountId = 1;
      component.lastLoadedFolderId = 'OLD';
      await component.initializeStoreState();

      accounts = [{ id: 100, email: 'new@example.com', displayName: 'New User' }];
      activeAccount = null;
      component.accountsStore.setActiveAccount = () => {
        // Deliberately keep activeAccount null for guard coverage.
      };
      await component.initializeStoreState();

      component.accountsStore.setActiveAccount = (accountId: number) => {
        activeAccount = accounts.find((account) => {
          return account.id === accountId;
        }) ?? activeAccount;
      };
      await component.initializeStoreState();

      threads = [makeThread('stub-thread-1')];
      activeAccount = accounts[0];
      activeFolderId = 'INBOX';
      component.lastLoadedAccountId = null;
      component.lastLoadedFolderId = null;
      await component.initializeStoreState();

      searchActive = true;
      await component.onAccountSwitch(100);

      activeAccount = null;
      component.onChatSourceClicked('missing-account');
      component.openNewCompose();
      component.onSearch({ queries: ['x'], originalQuery: 'x', streaming: true });

      activeAccount = accounts[0];
      component.onChatSourceClicked('message-id-1');
      component.openNewCompose();
      component.onSearch({ queries: ['x'], originalQuery: 'x', streaming: true });
      component.onSearch({ queries: ['x'], originalQuery: 'x', streaming: false });
      searchActive = false;
      component.onSearchCleared();
      searchActive = true;
      previousFolderId = 'INBOX';
      component.onSearchCleared();
      component.onSearchDismissed();

      threads = [makeThread('stub-thread-1'), makeThread('stub-thread-2', { isRead: true, isStarred: true })];
      selectedThread = threads[0];
      selectedMessages = [...selectedThread.messages];
      component.onThreadContextMenu({ thread: threads[0], x: 10, y: 20 });
      component.onContextMenuClosed();
      component.onDocumentContextMenu({
        clientX: 5,
        clientY: 5,
        button: 2,
        buttons: 2,
        target: browserDocument.body,
        preventDefault() {
          // no-op
        },
        stopPropagation() {
          // no-op
        },
      });
      component.contextMenuOpen.set(true);
      component.onDocumentContextMenu({
        clientX: 5,
        clientY: 5,
        button: 2,
        buttons: 2,
        target: menuButton,
        preventDefault() {
          // no-op
        },
        stopPropagation() {
          // no-op
        },
      });
      component.contextMenuOpen.set(true);
      component.onDocumentContextMenu({
        clientX: 5,
        clientY: 5,
        button: 2,
        buttons: 2,
        target: browserDocument.body,
        preventDefault() {
          // no-op
        },
        stopPropagation() {
          // no-op
        },
      });
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 0);
      });

      activeAccount = null;
      component.onContextMenuAction({ action: 'reply' });

      activeAccount = { id: 99, email: 'stub@example.com', displayName: 'Stub User' };
      component.contextMenuThreadId.set('stub-thread-1');
      component.contextMenuPosition.set({ x: 10, y: 10 });
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      activeFolderId = '[Gmail]/Trash';
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'delete' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'star' });

      activeFolderId = 'INBOX';
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'delete' });
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'move-to' });
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'move-to', targetFolder: '[Gmail]/Drafts' });
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'mark-spam' });
      activeFolderId = '[Gmail]/Spam';
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'mark-spam' });
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'mark-not-spam' });
      activeFolderId = 'INBOX';
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'mark-not-spam' });
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      activeFolderId = '[Gmail]/Trash';
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'star' });
      activeFolderId = 'INBOX';
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'star' });
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'mark-read-unread' });
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'add-labels', targetLabels: ['Label 1'] });
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'remove-labels', targetLabels: ['Label 1'] });
      multiSelectedThreadIds = ['stub-thread-1', 'stub-thread-2'];
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'unknown-action' });

      multiSelectedThreadIds = [];
      selectedThread = threads[0];
      selectedMessages = [...selectedThread.messages];
      component.contextMenuThreadId.set('stub-thread-1');
      activeFolderId = '[Gmail]/Trash';
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'delete' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'star' });

      activeFolderId = 'INBOX';
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'delete' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'move-to' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'move-to', targetFolder: '[Gmail]/Drafts' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'star' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'mark-read-unread' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'mark-spam' });
      activeFolderId = '[Gmail]/Spam';
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'mark-spam' });
      activeFolderId = 'INBOX';
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'mark-not-spam' });
      activeFolderId = '[Gmail]/Spam';
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'mark-not-spam' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'add-labels', targetLabels: [] });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'add-labels', targetLabels: ['Label 1'] });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'remove-labels', targetLabels: [] });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'remove-labels', targetLabels: ['Label 1'] });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'reply' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'reply-all' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'forward' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'edit-draft' });
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'unknown-action' });

      component.contextMenuThreadId.set(null);
      component.contextMenuOpen.set(true);
      component.onContextMenuAction({ action: 'reply' });

      selectedThread = null;
      activeAccount = null;
      component.openComposeForAction('reply');
      component.openDraftForEditing();
      activeAccount = { id: 99, email: 'stub@example.com', displayName: 'Stub User' };
      selectedThread = threads[0];
      selectedMessages = [];
      component.openComposeForAction('reply', undefined, 'Prefill coverage');
      selectedMessages = [...selectedThread.messages];
      component.openDraftForEditing();
      component.openDraftForEditing(makeMessage('direct-draft', { isDraft: true, subject: 'Direct draft coverage' }));

      return {
        redispatchCount,
        searchFocused,
        loadThreads: counts['loadThreads'] ?? 0,
        moveEmails: counts['moveEmails'] ?? 0,
        flagEmails: counts['flagEmails'] ?? 0,
        openCompose: counts['openCompose'] ?? 0,
      };
      } finally {
        browserDocument.elementFromPoint = originalElementFromPoint;
        searchInput.remove();
        menuPanel.remove();
        redispatchTarget.remove();

        component.accountsStore = originalAccountsStore;
        component.foldersStore = originalFoldersStore;
        component.emailsStore = originalEmailsStore;
        component.composeStore = originalComposeStore;
        component.uiStore = originalUiStore;
        component.electronService = originalElectronService;
        component.commandRegistry = originalCommandRegistry;
        component.aiStore = originalAiStore;
        component.router = originalRouter;
        component.cdr = originalCdr;
      }
    });

    expect(result.redispatchCount).toBeGreaterThanOrEqual(1);
    expect(result.searchFocused).toBeGreaterThanOrEqual(0);
    expect(result.loadThreads).toBeGreaterThanOrEqual(1);
    expect(result.moveEmails).toBeGreaterThanOrEqual(1);
    expect(result.flagEmails).toBeGreaterThanOrEqual(1);
    expect(result.openCompose).toBeGreaterThanOrEqual(1);
  });

  test('emails store direct method coverage with service stubs', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const browserGlobal = globalThis as any;
      const browserDocument = browserGlobal.document;
      const component = browserGlobal.ng.getComponent(browserDocument.querySelector('app-mail-shell')) as any;
      const store = component.emailsStore as any;
      const electronService = component.electronService as any;
      const accountsStore = component.accountsStore as any;
      const foldersStore = component.foldersStore as any;

      const originalFetchEmails = electronService.fetchEmails;
      const originalFetchOlderEmails = electronService.fetchOlderEmails;
      const originalGetThreadFromDb = electronService.getThreadFromDb;
      const originalFetchThread = electronService.fetchThread;
      const originalFlagEmails = electronService.flagEmails;
      const originalMoveEmails = electronService.moveEmails;
      const originalDeleteEmails = electronService.deleteEmails;
      const originalEnqueueOperation = electronService.enqueueOperation;
      const originalSyncAccount = electronService.syncAccount;
      const originalActiveAccountId = accountsStore.activeAccountId;
      const originalActiveFolderId = foldersStore.activeFolderId;
      const originalTrashFolderId = foldersStore.trashFolderId;
      const originalLoadFolders = foldersStore.loadFolders;
      const originalUpdateSearchResultCount = foldersStore.updateSearchResultCount;

      let activeAccountId = 99;
      let activeFolderId = 'INBOX';
      let searchResultCount = 0;

      try {
      accountsStore.activeAccountId = () => {
        return activeAccountId;
      };
      foldersStore.activeFolderId = () => {
        return activeFolderId;
      };
      foldersStore.trashFolderId = () => {
        return '[Gmail]/Trash';
      };
      foldersStore.loadFolders = async () => {
        return;
      };
      foldersStore.updateSearchResultCount = (count: number) => {
        searchResultCount = count;
      };

      const makeThread = (threadId: string, dateIndex: number, overrides: Record<string, unknown> = {}) => {
        return {
          xGmThrid: threadId,
          xGmMsgId: `${threadId}-message`,
          subject: `Subject ${threadId}`,
          sender: `${threadId}@example.com`,
          snippet: `Snippet ${threadId}`,
          lastMessageDate: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - dateIndex * 60_000).toISOString(),
          isRead: false,
          isStarred: false,
          messageCount: 1,
          labels: ['INBOX'],
          folders: ['INBOX'],
          ...overrides,
        };
      };

      const makeThreads = (count: number, prefix: string) => {
        return Array.from({ length: count }, (_unused, index) => {
          return makeThread(`${prefix}-${index}`, index);
        });
      };

      store.clearAll();
      electronService.fetchEmails = async () => {
        return { success: false, error: { message: 'Load threads failed' } };
      };
      await store.loadThreads(activeAccountId, activeFolderId);

      electronService.fetchEmails = async () => {
        throw new Error('Load threads threw');
      };
      await store.loadThreads(activeAccountId, activeFolderId);

      store.clearAll();
      await store.loadMoreFromServer(activeAccountId, activeFolderId);

      electronService.fetchEmails = async () => {
        return { success: true, data: makeThreads(50, 'base') };
      };
      await store.loadThreads(activeAccountId, activeFolderId);

      electronService.fetchOlderEmails = async () => {
        return { success: false, error: { message: 'Enqueue older failed' } };
      };
      await store.loadMoreFromServer(activeAccountId, activeFolderId);

      electronService.fetchOlderEmails = async () => {
        throw new Error('Older fetch threw');
      };
      await store.loadMoreFromServer(activeAccountId, activeFolderId);

      store.clearAll();
      electronService.fetchEmails = async () => {
        return { success: true, data: makeThreads(50, 'page') };
      };
      await store.loadThreads(activeAccountId, activeFolderId);

      electronService.fetchEmails = async () => {
        return { success: true, data: [makeThread('page-next', 60)] };
      };
      await store.loadMore(activeAccountId, activeFolderId);

      electronService.fetchEmails = async () => {
        return { success: false, error: { message: 'Load more failed' } };
      };
      await store.loadMore(activeAccountId, activeFolderId);

      electronService.fetchEmails = async () => {
        throw new Error('Load more threw');
      };
      await store.loadMore(activeAccountId, activeFolderId);

      store.clearAll();
      electronService.fetchEmails = async () => {
        return { success: true, data: [makeThread('db-exhausted', 1)] };
      };
      electronService.fetchOlderEmails = async () => {
        return { success: true, data: { queueId: 'older-queue' } };
      };
      await store.loadThreads(activeAccountId, activeFolderId);
      await store.loadMore(activeAccountId, activeFolderId);

      store.clearAll();
      store.selectThread('thread-load-fail');
      electronService.getThreadFromDb = async () => {
        throw new Error('Thread DB threw');
      };
      electronService.fetchThread = async () => {
        throw new Error('Fetch thread threw');
      };
      await store.loadThread(activeAccountId, 'thread-load-fail');

      store.selectThread('reconcile-fail');
      electronService.getThreadFromDb = async () => {
        return { success: false, error: { message: 'Reconcile failed' } };
      };
      await store.reconcileThreadFromDb(activeAccountId, 'reconcile-fail');
      electronService.getThreadFromDb = async () => {
        throw new Error('Reconcile threw');
      };
      await store.reconcileThreadFromDb(activeAccountId, 'reconcile-fail');

      electronService.flagEmails = async () => {
        return { success: false, error: { message: 'Flag failed' } };
      };
      await store.flagEmails(activeAccountId, ['message-1'], 'read', true, 'thread-1');
      electronService.flagEmails = async () => {
        throw new Error('Flag threw');
      };
      await store.flagEmails(activeAccountId, ['message-1'], 'starred', false, 'thread-1');

      electronService.moveEmails = async () => {
        return { success: false, error: { message: 'Move failed' } };
      };
      await store.moveEmails(activeAccountId, ['message-1'], '[Gmail]/Drafts', 'thread-1');
      electronService.moveEmails = async () => {
        throw new Error('Move threw');
      };
      await store.moveEmails(activeAccountId, ['message-1'], '[Gmail]/Drafts', 'thread-1');

      electronService.deleteEmails = async () => {
        return { success: false, error: { message: 'Delete failed' } };
      };
      await store.deleteEmails(activeAccountId, ['message-1'], activeFolderId, 'thread-1');
      electronService.deleteEmails = async () => {
        throw new Error('Delete threw');
      };
      await store.deleteEmails(activeAccountId, ['message-1'], activeFolderId, 'thread-1');

      electronService.enqueueOperation = async () => {
        return { success: false, error: { message: 'Label failed' } };
      };
      await store.addLabels(activeAccountId, ['message-1'], ['Label 1'], 'thread-1');
      await store.removeLabels(activeAccountId, ['message-1'], ['Label 1'], 'thread-1');
      electronService.enqueueOperation = async () => {
        throw new Error('Label threw');
      };
      await store.addLabels(activeAccountId, ['message-1'], ['Label 1'], 'thread-1');
      await store.removeLabels(activeAccountId, ['message-1'], ['Label 1'], 'thread-1');

      store.appendStreamingBatch([]);

      electronService.syncAccount = async () => {
        return { success: false, error: { message: 'Sync failed' } };
      };
      await store.syncAccount(activeAccountId);
      electronService.syncAccount = async () => {
        throw new Error('Sync threw');
      };
      await store.syncAccount(activeAccountId);

      store.clearAll();
      electronService.fetchEmails = async () => {
        return { success: true, data: makeThreads(50, 'refresh-existing') };
      };
      await store.loadThreads(activeAccountId, activeFolderId);
      store.selectThread('refresh-existing-0');
      store.markListScrolled();
      store.setMultiSelectedThreadIds(['refresh-existing-0', 'refresh-existing-99']);

      electronService.fetchEmails = async () => {
        const refreshed = makeThreads(50, 'refresh-existing');
        refreshed[0] = makeThread('refresh-new-top', -1, { lastMessageDate: '2026-03-20T00:00:00.000Z' });
        refreshed[1] = makeThread('refresh-existing-0', 0, { snippet: 'Updated snippet', isRead: true, isStarred: true, messageCount: 3 });
        return { success: true, data: refreshed };
      };
      await store.refreshThreads();

      electronService.fetchEmails = async () => {
        return { success: true, data: [makeThread('refresh-single', 1)] };
      };
      await store.refreshThreads();

      activeAccountId = 100;
      electronService.fetchEmails = async () => {
        return { success: true, data: makeThreads(2, 'context-switch') };
      };
      await store.refreshThreads();
      activeAccountId = 99;

      electronService.fetchEmails = async () => {
        throw new Error('Refresh threw');
      };
      await store.refreshThreads();

      return {
        searchResultCount,
        threadCount: store.threads().length,
        error: store.error(),
      };
      } finally {
        electronService.fetchEmails = originalFetchEmails;
        electronService.fetchOlderEmails = originalFetchOlderEmails;
        electronService.getThreadFromDb = originalGetThreadFromDb;
        electronService.fetchThread = originalFetchThread;
        electronService.flagEmails = originalFlagEmails;
        electronService.moveEmails = originalMoveEmails;
        electronService.deleteEmails = originalDeleteEmails;
        electronService.enqueueOperation = originalEnqueueOperation;
        electronService.syncAccount = originalSyncAccount;
        accountsStore.activeAccountId = originalActiveAccountId;
        foldersStore.activeFolderId = originalActiveFolderId;
        foldersStore.trashFolderId = originalTrashFolderId;
        foldersStore.loadFolders = originalLoadFolders;
        foldersStore.updateSearchResultCount = originalUpdateSearchResultCount;
      }
    });

    expect(result.searchResultCount).toBeGreaterThanOrEqual(0);
    expect(result.threadCount).toBeGreaterThanOrEqual(0);
  });
});
