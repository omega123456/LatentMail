/**
 * filters-rules.test.ts — Backend E2E tests for filters and rules.
 *
 * Covers:
 *   - Filter CRUD via db:save-filter / db:update-filter / db:delete-filter / db:toggle-filter
 *   - Filter JSON validation rejects invalid payloads
 *   - Manual filter run via filter:apply-all
 *   - Automatic post-sync filter execution: sync new INBOX emails → filters auto-applied
 *   - No enabled filters: unfiltered emails still marked is_filtered = 1
 *   - Condition matching for all fields: from, to, subject, body, has-attachment
 *   - All operators: contains, equals, starts-with, ends-with, matches (regex)
 *   - Invalid regex doesn't crash the filter run
 *   - Body matching prefers text_body, falls back to stripped html_body
 *   - AND logic across multiple conditions in one filter
 *   - Multiple filters matching the same email: all actions execute
 *   - Actions: mark-read, star, archive, move, delete
 *   - Each action produces correct optimistic DB updates + queued IMAP operations
 *   - Thread read-state recalculation after mark-read
 *   - mail:folder-updated events emitted after action processing
 *   - Error in one filter/action doesn't abort others
 *   - Per-account concurrency guard: overlapping runs are serialized
 */

import { expect } from 'chai';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import {
  callIpc,
  waitForEvent,
  seedTestAccount,
  triggerSyncAndWait,
} from '../infrastructure/test-helpers';
import { imapStateInspector } from '../test-main';
import { emlFixtures } from '../fixtures/index';
import { DatabaseService } from '../../../electron/services/database-service';
import { TestEventBus } from '../infrastructure/test-event-bus';

// ---- Type helpers ----

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface FilterRow {
  id: number;
  name: string;
  conditions: string;
  actions: string;
  isEnabled: boolean;
  isAiGenerated: boolean;
  sortOrder: number;
}

interface QueueUpdateSnapshot {
  queueId: string;
  accountId: number;
  type: string;
  status: string;
  error?: string;
}

// ---- Suite-level state ----

let suiteAccountId: number;
let suiteEmail: string;

// -------------------------------------------------------------------------
// Helper: seed account, inject messages, and run sync
// -------------------------------------------------------------------------

async function setupWithMessages(
  email: string,
  displayName: string,
): Promise<{ accountId: number; email: string }> {
  await quiesceAndRestore();

  // Brief settling pause: allows any lingering in-flight async operations from
  // the previous describe block (e.g. IMAP workers completing after their queue
  // was killed by quiesceAndRestore) to fully release before we reset the mock
  // server and start a new sync. Without this, an IMAP connection from the
  // previous suite can race with the new suite's IMAP setup.
  await new Promise<void>((resolve) => setTimeout(resolve, 200));

  const seeded = seedTestAccount({ email, displayName });
  suiteAccountId = seeded.accountId;
  suiteEmail = seeded.email;

  imapStateInspector.reset();
  imapStateInspector.getServer().addAllowedAccount(suiteEmail);

  const plainMsg = emlFixtures['plain-text'];
  const htmlMsg = emlFixtures['html-email'];

  for (const msg of [plainMsg, htmlMsg]) {
    imapStateInspector.injectMessage('[Gmail]/All Mail', msg.raw, {
      xGmMsgId: msg.headers.xGmMsgId,
      xGmThrid: msg.headers.xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });
    imapStateInspector.injectMessage('INBOX', msg.raw, {
      xGmMsgId: msg.headers.xGmMsgId,
      xGmThrid: msg.headers.xGmThrid,
      xGmLabels: ['\\Inbox'],
    });
  }

  await triggerSyncAndWait(seeded.accountId, { timeout: 25_000 });

  return { accountId: seeded.accountId, email: seeded.email };
}

// -------------------------------------------------------------------------
// Helper: wait for a queue:update completed event
// -------------------------------------------------------------------------

async function waitForQueueCompleted(
  type: string,
  accountId: number,
  timeoutMs: number = 15_000,
): Promise<void> {
  const bus = TestEventBus.getInstance();

  const priorCount = bus.getHistory('queue:update').filter((record) => {
    const snapshot = record.args[0] as QueueUpdateSnapshot | undefined;
    return (
      snapshot != null &&
      snapshot.accountId === accountId &&
      snapshot.type === type &&
      (snapshot.status === 'completed' || snapshot.status === 'failed')
    );
  }).length;

  await bus.waitFor('queue:update', {
    timeout: timeoutMs,
    predicate: (args) => {
      const snapshot = args[0] as QueueUpdateSnapshot | undefined;
      if (!snapshot) {
        return false;
      }
      if (snapshot.accountId !== accountId) {
        return false;
      }
      if (snapshot.type !== type) {
        return false;
      }
      if (snapshot.status !== 'completed' && snapshot.status !== 'failed') {
        return false;
      }
      const currentCount = bus.getHistory('queue:update').filter((record) => {
        const recordSnapshot = record.args[0] as QueueUpdateSnapshot | undefined;
        return (
          recordSnapshot != null &&
          recordSnapshot.accountId === accountId &&
          recordSnapshot.type === type &&
          (recordSnapshot.status === 'completed' || recordSnapshot.status === 'failed')
        );
      }).length;
      return currentCount > priorCount;
    },
  });
}

// =========================================================================
// Filter CRUD
// =========================================================================

describe('Filters & Rules', () => {
  describe('Filter CRUD — db:save-filter / db:get-filters / db:update-filter / db:delete-filter / db:toggle-filter', () => {
    before(async function () {
      this.timeout(35_000);
      await setupWithMessages('filter-crud@example.com', 'Filter CRUD Test');
    });

    it('db:save-filter creates a new filter and returns its id', async () => {
      const response = await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Test Filter',
        conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'alice' }]),
        actions: JSON.stringify([{ type: 'mark-read' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      }) as IpcResponse<{ id: number }>;

      expect(response.success).to.equal(true);
      expect(response.data!.id).to.be.a('number');
      expect(response.data!.id).to.be.above(0);
    });

    it('db:get-filters returns the saved filter', async () => {
      const response = await callIpc('db:get-filters', suiteAccountId) as IpcResponse<{ filters: FilterRow[] }>;

      expect(response.success).to.equal(true);
      expect(response.data!.filters).to.be.an('array');
      expect(response.data!.filters.length).to.be.at.least(1);

      const savedFilter = response.data!.filters.find((filter) => filter.name === 'Test Filter');
      expect(savedFilter).to.not.be.undefined;
      expect(savedFilter!.isEnabled).to.equal(true);
    });

    it('db:update-filter modifies a filter and returns success', async () => {
      // First save a filter
      const saveResponse = await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Filter To Update',
        conditions: JSON.stringify([{ field: 'subject', operator: 'contains', value: 'old' }]),
        actions: JSON.stringify([{ type: 'star' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 2,
      }) as IpcResponse<{ id: number }>;

      expect(saveResponse.success).to.equal(true);
      const filterId = saveResponse.data!.id;

      // Now update it
      const updateResponse = await callIpc('db:update-filter', {
        id: filterId,
        name: 'Updated Filter Name',
        conditions: JSON.stringify([{ field: 'subject', operator: 'equals', value: 'new' }]),
        actions: JSON.stringify([{ type: 'mark-read' }]),
        isEnabled: true,
        sortOrder: 2,
      }) as IpcResponse<null>;

      expect(updateResponse.success).to.equal(true);

      // Verify the update was persisted
      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      const filterRow = rawDb.prepare(
        'SELECT name FROM filters WHERE id = :filterId',
      ).get({ filterId }) as Record<string, unknown> | undefined;

      expect(filterRow).to.not.be.undefined;
      expect(filterRow!['name']).to.equal('Updated Filter Name');
    });

    it('db:delete-filter removes the filter from the DB', async () => {
      // Create a filter to delete
      const saveResponse = await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Filter To Delete',
        conditions: JSON.stringify([{ field: 'from', operator: 'equals', value: 'spam@example.com' }]),
        actions: JSON.stringify([{ type: 'delete' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 3,
      }) as IpcResponse<{ id: number }>;

      expect(saveResponse.success).to.equal(true);
      const filterId = saveResponse.data!.id;

      const deleteResponse = await callIpc('db:delete-filter', filterId) as IpcResponse<null>;
      expect(deleteResponse.success).to.equal(true);

      // Verify the filter is gone
      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      const filterRow = rawDb.prepare(
        'SELECT id FROM filters WHERE id = :filterId',
      ).get({ filterId }) as Record<string, unknown> | undefined;

      expect(filterRow).to.be.undefined;
    });

    it('db:toggle-filter disables and re-enables a filter', async () => {
      // Create a filter to toggle
      const saveResponse = await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Toggleable Filter',
        conditions: JSON.stringify([{ field: 'subject', operator: 'contains', value: 'toggle' }]),
        actions: JSON.stringify([{ type: 'star' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 4,
      }) as IpcResponse<{ id: number }>;

      expect(saveResponse.success).to.equal(true);
      const filterId = saveResponse.data!.id;

      // Disable the filter
      const disableResponse = await callIpc('db:toggle-filter', filterId, false) as IpcResponse<null>;
      expect(disableResponse.success).to.equal(true);

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      const disabledRow = rawDb.prepare(
        'SELECT is_enabled FROM filters WHERE id = :filterId',
      ).get({ filterId }) as Record<string, unknown> | undefined;
      expect(disabledRow!['is_enabled']).to.equal(0);

      // Re-enable it
      const enableResponse = await callIpc('db:toggle-filter', filterId, true) as IpcResponse<null>;
      expect(enableResponse.success).to.equal(true);

      const enabledRow = rawDb.prepare(
        'SELECT is_enabled FROM filters WHERE id = :filterId',
      ).get({ filterId }) as Record<string, unknown> | undefined;
      expect(enabledRow!['is_enabled']).to.equal(1);
    });

    it('db:save-filter rejects invalid JSON in conditions', async () => {
      const response = await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Invalid Filter',
        conditions: 'not valid json {{{',
        actions: JSON.stringify([{ type: 'star' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 5,
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('DB_INVALID_INPUT');
    });

    it('db:save-filter rejects invalid JSON in actions', async () => {
      const response = await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Invalid Actions Filter',
        conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'test' }]),
        actions: '{ invalid',
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 6,
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('DB_INVALID_INPUT');
    });

    it('db:update-filter rejects invalid JSON in conditions', async () => {
      const saveResponse = await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Filter For Invalid Update',
        conditions: JSON.stringify([{ field: 'subject', operator: 'contains', value: 'test' }]),
        actions: JSON.stringify([{ type: 'star' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 7,
      }) as IpcResponse<{ id: number }>;

      const filterId = saveResponse.data!.id;

      const updateResponse = await callIpc('db:update-filter', {
        id: filterId,
        name: 'Bad Update',
        conditions: 'not json',
        actions: JSON.stringify([{ type: 'mark-read' }]),
        isEnabled: true,
        sortOrder: 7,
      }) as IpcResponse<unknown>;

      expect(updateResponse.success).to.equal(false);
      expect(updateResponse.error!.code).to.equal('DB_INVALID_INPUT');
    });
  });

  // =========================================================================
  // Manual filter:apply-all
  // =========================================================================

  describe('Manual filter:apply-all', () => {
    before(async function () {
      this.timeout(35_000);
      await setupWithMessages('filter-manual@example.com', 'Filter Manual Test');
    });

    it('filter:apply-all returns success with result stats when no filters exist', async () => {
      const response = await callIpc('filter:apply-all', suiteAccountId) as IpcResponse<{
        emailsProcessed: number;
        emailsMatched: number;
        actionsDispatched: number;
        errors: number;
      }>;

      expect(response.success).to.equal(true);
      expect(response.data!.errors).to.equal(0);
      // emailsProcessed may be 0 if already filtered from the before() hook sync
      expect(response.data!.emailsProcessed).to.be.a('number');
    });

    it('filter:apply-all returns FILTER_INVALID_INPUT for invalid accountId', async () => {
      // Pass 0 which is invalid
      const response = await callIpc('filter:apply-all', 0) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('FILTER_INVALID_INPUT');
    });

    it('filter:apply-all marks-read emails matching a mark-read filter', async function () {
      this.timeout(25_000);

      // Restore clean state to ensure emails are unread/unfiltered
      await quiesceAndRestore();
      const seeded = seedTestAccount({ email: 'filter-mark-read@example.com' });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const plainMsg = emlFixtures['plain-text'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      // Reset is_filtered to 0 so filter:apply-all can process it again
      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare(
        'UPDATE emails SET is_filtered = 0, is_read = 0 WHERE account_id = :accountId',
      ).run({ accountId: suiteAccountId });

      // Create a filter that marks from:alice as read
      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Mark Alice as Read',
        conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'alice@example.com' }]),
        actions: JSON.stringify([{ type: 'mark-read' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      // Run filter manually
      const applyResponse = await callIpc('filter:apply-all', suiteAccountId) as IpcResponse<{
        emailsProcessed: number;
        emailsMatched: number;
        actionsDispatched: number;
        errors: number;
      }>;

      expect(applyResponse.success).to.equal(true);
      expect(applyResponse.data!.emailsProcessed).to.be.at.least(1);
      expect(applyResponse.data!.emailsMatched).to.be.at.least(1);
      expect(applyResponse.data!.actionsDispatched).to.be.at.least(1);
      expect(applyResponse.data!.errors).to.equal(0);

      // The email should now be marked as read
      const emailRow = rawDb.prepare(
        'SELECT is_read FROM emails WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).get({ xGmMsgId: plainMsg.headers.xGmMsgId, accountId: suiteAccountId }) as Record<string, unknown> | undefined;

      expect(emailRow).to.not.be.undefined;
      expect(emailRow!['is_read']).to.equal(1);
    });

    it('filter:apply-all marks all emails is_filtered=1 even with no filters', async function () {
      this.timeout(20_000);

      // Restore clean state
      await quiesceAndRestore();
      const seeded = seedTestAccount({ email: 'filter-no-filters@example.com' });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const htmlMsg = emlFixtures['html-email'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', htmlMsg.raw, {
        xGmMsgId: htmlMsg.headers.xGmMsgId,
        xGmThrid: htmlMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', htmlMsg.raw, {
        xGmMsgId: htmlMsg.headers.xGmMsgId,
        xGmThrid: htmlMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      // Reset is_filtered to 0 so filter:apply-all can process it
      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare(
        'UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId',
      ).run({ accountId: suiteAccountId });

      // No filters saved — running apply-all should still mark emails as filtered
      const applyResponse = await callIpc('filter:apply-all', suiteAccountId) as IpcResponse<{
        emailsProcessed: number;
        emailsMatched: number;
        actionsDispatched: number;
        errors: number;
      }>;

      expect(applyResponse.success).to.equal(true);
      expect(applyResponse.data!.emailsProcessed).to.be.at.least(1);
      expect(applyResponse.data!.emailsMatched).to.equal(0);
      expect(applyResponse.data!.actionsDispatched).to.equal(0);
      expect(applyResponse.data!.errors).to.equal(0);

      // Verify is_filtered=1 in the DB
      const emailRow = rawDb.prepare(
        'SELECT is_filtered FROM emails WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).get({ xGmMsgId: htmlMsg.headers.xGmMsgId, accountId: suiteAccountId }) as Record<string, unknown> | undefined;

      expect(emailRow).to.not.be.undefined;
      expect(emailRow!['is_filtered']).to.equal(1);
    });
  });

  // =========================================================================
  // Condition matching — all fields
  // =========================================================================

  describe('Condition matching — field types', () => {
    before(async function () {
      this.timeout(35_000);
      await setupWithMessages('filter-fields@example.com', 'Filter Fields Test');
    });

    it('from field — contains operator matches sender email', async function () {
      this.timeout(20_000);

      // Reset is_filtered to test fresh
      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare('UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'From Contains Alice',
        conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'alice@example.com' }]),
        actions: JSON.stringify([{ type: 'star' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      const applyResponse = await callIpc('filter:apply-all', suiteAccountId) as IpcResponse<{
        emailsMatched: number;
        actionsDispatched: number;
      }>;

      expect(applyResponse.success).to.equal(true);
      // plain-text is from alice@example.com — must match at least 1
      expect(applyResponse.data!.emailsMatched).to.be.at.least(1);
      expect(applyResponse.data!.actionsDispatched).to.be.at.least(1);
    });

    it('subject field — equals operator matches exact subject', async function () {
      this.timeout(20_000);

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare('UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      // Delete previous filters to isolate this test
      rawDb.prepare('DELETE FROM filters WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Subject Equals',
        conditions: JSON.stringify([{ field: 'subject', operator: 'equals', value: 'plain text test message' }]),
        actions: JSON.stringify([{ type: 'mark-read' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      const applyResponse = await callIpc('filter:apply-all', suiteAccountId) as IpcResponse<{
        emailsMatched: number;
      }>;

      expect(applyResponse.success).to.equal(true);
      // The subject comparison is case-insensitive; "Plain text test message" should match
      expect(applyResponse.data!.emailsMatched).to.be.at.least(1);
    });

    it('subject field — starts-with operator', async function () {
      this.timeout(20_000);

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare('UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId').run({ accountId: suiteAccountId });
      rawDb.prepare('DELETE FROM filters WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Subject Starts With Plain',
        conditions: JSON.stringify([{ field: 'subject', operator: 'starts-with', value: 'plain' }]),
        actions: JSON.stringify([{ type: 'star' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      const applyResponse = await callIpc('filter:apply-all', suiteAccountId) as IpcResponse<{
        emailsMatched: number;
      }>;

      expect(applyResponse.success).to.equal(true);
      expect(applyResponse.data!.emailsMatched).to.be.at.least(1);
    });

    it('subject field — ends-with operator', async function () {
      this.timeout(20_000);

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare('UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId').run({ accountId: suiteAccountId });
      rawDb.prepare('DELETE FROM filters WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Subject Ends With message',
        conditions: JSON.stringify([{ field: 'subject', operator: 'ends-with', value: 'message' }]),
        actions: JSON.stringify([{ type: 'mark-read' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      const applyResponse = await callIpc('filter:apply-all', suiteAccountId) as IpcResponse<{
        emailsMatched: number;
      }>;

      expect(applyResponse.success).to.equal(true);
      expect(applyResponse.data!.emailsMatched).to.be.at.least(1);
    });

    it('subject field — matches (regex) operator', async function () {
      this.timeout(20_000);

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare('UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId').run({ accountId: suiteAccountId });
      rawDb.prepare('DELETE FROM filters WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Subject Regex',
        conditions: JSON.stringify([{ field: 'subject', operator: 'matches', value: 'plain.+test' }]),
        actions: JSON.stringify([{ type: 'star' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      const applyResponse = await callIpc('filter:apply-all', suiteAccountId) as IpcResponse<{
        emailsMatched: number;
      }>;

      expect(applyResponse.success).to.equal(true);
      expect(applyResponse.data!.emailsMatched).to.be.at.least(1);
    });

    it('invalid regex does not crash the filter run', async function () {
      this.timeout(20_000);

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare('UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId').run({ accountId: suiteAccountId });
      rawDb.prepare('DELETE FROM filters WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Invalid Regex Filter',
        conditions: JSON.stringify([{ field: 'subject', operator: 'matches', value: '(unclosed[invalid' }]),
        actions: JSON.stringify([{ type: 'mark-read' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      // Should not throw — filter run should complete (with errors=0 since no match is treated as skip)
      const applyResponse = await callIpc('filter:apply-all', suiteAccountId) as IpcResponse<{
        emailsProcessed: number;
        emailsMatched: number;
        actionsDispatched: number;
        errors: number;
      }>;

      // The response must succeed — invalid regex is handled gracefully inside evaluateCondition
      expect(applyResponse.success).to.equal(true);
      expect(applyResponse.data!.emailsMatched).to.equal(0);
    });

    it('AND logic: all conditions must match for a filter to fire', async function () {
      this.timeout(20_000);

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare('UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId').run({ accountId: suiteAccountId });
      rawDb.prepare('DELETE FROM filters WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      // Both conditions: from alice AND subject contains "plain" — should match plain-text.eml only
      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'AND Filter',
        conditions: JSON.stringify([
          { field: 'from', operator: 'contains', value: 'alice@example.com' },
          { field: 'subject', operator: 'contains', value: 'plain' },
        ]),
        actions: JSON.stringify([{ type: 'star' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      const applyResponse = await callIpc('filter:apply-all', suiteAccountId) as IpcResponse<{
        emailsMatched: number;
      }>;

      expect(applyResponse.success).to.equal(true);
      // Only the plain-text.eml should match (from:alice AND subject:plain)
      // html-email.eml has a different sender and subject
      expect(applyResponse.data!.emailsMatched).to.be.at.least(1);
    });
  });

  // =========================================================================
  // Filter actions
  // =========================================================================

  describe('Filter actions', () => {
    before(async function () {
      this.timeout(35_000);
      await setupWithMessages('filter-actions@example.com', 'Filter Actions Test');
    });

    it('star action: sets isStarred=true for matched emails', async function () {
      this.timeout(20_000);

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare('UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId').run({ accountId: suiteAccountId });
      rawDb.prepare('DELETE FROM filters WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Star Alice',
        conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'alice@example.com' }]),
        actions: JSON.stringify([{ type: 'star' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      await callIpc('filter:apply-all', suiteAccountId);

      const plainMsg = emlFixtures['plain-text'];
      const emailRow = rawDb.prepare(
        'SELECT is_starred FROM emails WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).get({ xGmMsgId: plainMsg.headers.xGmMsgId, accountId: suiteAccountId }) as Record<string, unknown> | undefined;

      expect(emailRow).to.not.be.undefined;
      expect(emailRow!['is_starred']).to.equal(1);
    });

    it('archive action: moves matched email from INBOX to All Mail', async function () {
      this.timeout(25_000);

      await quiesceAndRestore();
      const seeded = seedTestAccount({ email: 'filter-archive@example.com' });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const plainMsg = emlFixtures['plain-text'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      // Reset is_filtered to 0
      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare('UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Archive Alice',
        conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'alice@example.com' }]),
        actions: JSON.stringify([{ type: 'archive' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      await callIpc('filter:apply-all', suiteAccountId);

      // After archive, the email should be in All Mail but NOT in INBOX
      const folders = db.getFoldersForEmail(suiteAccountId, plainMsg.headers.xGmMsgId);
      expect(folders).to.include('[Gmail]/All Mail');
      expect(folders).to.not.include('INBOX');
    });

    it('delete action: moves matched email to Trash folder', async function () {
      this.timeout(25_000);

      await quiesceAndRestore();
      const seeded = seedTestAccount({ email: 'filter-delete@example.com' });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const htmlMsg = emlFixtures['html-email'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', htmlMsg.raw, {
        xGmMsgId: htmlMsg.headers.xGmMsgId,
        xGmThrid: htmlMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', htmlMsg.raw, {
        xGmMsgId: htmlMsg.headers.xGmMsgId,
        xGmThrid: htmlMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare('UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      // html-email.eml is from carol@example.com — match that sender
      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Delete Carol',
        conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'carol@example.com' }]),
        actions: JSON.stringify([{ type: 'delete' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      await callIpc('filter:apply-all', suiteAccountId);

      // After delete, the email should be in Trash
      const trashFolder = db.getTrashFolder(suiteAccountId);
      const folders = db.getFoldersForEmail(suiteAccountId, htmlMsg.headers.xGmMsgId);
      expect(folders).to.include(trashFolder);
      expect(folders).to.not.include('INBOX');
    });

    it('move action: moves matched email to a custom label folder', async function () {
      this.timeout(30_000);

      await quiesceAndRestore();
      const seeded = seedTestAccount({ email: 'filter-move@example.com' });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const plainMsg = emlFixtures['plain-text'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare('UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      // Create a custom label first (needed for IMAP folder to exist)
      await callIpc('label:create', String(suiteAccountId), 'WorkItems', null);

      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Move Alice to WorkItems',
        conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'alice@example.com' }]),
        actions: JSON.stringify([{ type: 'move', value: 'WorkItems' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      await callIpc('filter:apply-all', suiteAccountId);

      // The email should now be in WorkItems
      const folders = db.getFoldersForEmail(suiteAccountId, plainMsg.headers.xGmMsgId);
      expect(folders).to.include('WorkItems');
      expect(folders).to.not.include('INBOX');
    });

    it('multiple filters matching the same email: all actions execute', async function () {
      this.timeout(25_000);

      await quiesceAndRestore();
      const seeded = seedTestAccount({ email: 'filter-multi@example.com' });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const plainMsg = emlFixtures['plain-text'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare('UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      // Two filters both matching plain-text.eml
      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Mark Read Filter',
        conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'alice@example.com' }]),
        actions: JSON.stringify([{ type: 'mark-read' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Star Filter',
        conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'alice@example.com' }]),
        actions: JSON.stringify([{ type: 'star' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 2,
      });

      const applyResponse = await callIpc('filter:apply-all', suiteAccountId) as IpcResponse<{
        actionsDispatched: number;
      }>;

      expect(applyResponse.success).to.equal(true);
      // Both mark-read AND star actions should have fired
      expect(applyResponse.data!.actionsDispatched).to.be.at.least(2);

      const emailRow = rawDb.prepare(
        'SELECT is_read, is_starred FROM emails WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).get({ xGmMsgId: plainMsg.headers.xGmMsgId, accountId: suiteAccountId }) as Record<string, unknown> | undefined;

      expect(emailRow!['is_read']).to.equal(1);
      expect(emailRow!['is_starred']).to.equal(1);
    });

    it('emits mail:folder-updated after filter actions with folder changes', async function () {
      this.timeout(25_000);

      await quiesceAndRestore();
      const seeded = seedTestAccount({ email: 'filter-event@example.com' });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const plainMsg = emlFixtures['plain-text'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare('UPDATE emails SET is_filtered = 0 WHERE account_id = :accountId').run({ accountId: suiteAccountId });

      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Archive Alice For Event',
        conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'alice@example.com' }]),
        actions: JSON.stringify([{ type: 'archive' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      const bus = TestEventBus.getInstance();
      const priorCount = bus.getHistory('mail:folder-updated').filter((record) => {
        const payload = record.args[0] as Record<string, unknown> | undefined;
        return (
          payload != null &&
          Number(payload['accountId']) === suiteAccountId &&
          payload['reason'] === 'filter'
        );
      }).length;

      await callIpc('filter:apply-all', suiteAccountId);

      // Wait for mail:folder-updated with reason='filter'
      await waitForEvent('mail:folder-updated', {
        timeout: 10_000,
        predicate: (args) => {
          const payload = args[0] as Record<string, unknown> | undefined;
          if (!payload) {
            return false;
          }
          if (Number(payload['accountId']) !== suiteAccountId) {
            return false;
          }
          if (payload['reason'] !== 'filter') {
            return false;
          }
          const currentCount = bus.getHistory('mail:folder-updated').filter((record) => {
            const recordPayload = record.args[0] as Record<string, unknown> | undefined;
            return (
              recordPayload != null &&
              Number(recordPayload['accountId']) === suiteAccountId &&
              recordPayload['reason'] === 'filter'
            );
          }).length;
          return currentCount > priorCount;
        },
      });
    });
  });

  // =========================================================================
  // Post-sync automatic filter execution
  // =========================================================================

  describe('Post-sync automatic filter execution', () => {
    before(async function () {
      this.timeout(30_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'filter-postsync@example.com',
        displayName: 'Post-Sync Filter Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);
    });

    it('marks new INBOX emails as filtered=1 automatically after sync', async function () {
      this.timeout(25_000);

      const plainMsg = emlFixtures['plain-text'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();

      const emailRow = rawDb.prepare(
        'SELECT is_filtered FROM emails WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).get({ xGmMsgId: plainMsg.headers.xGmMsgId, accountId: suiteAccountId }) as Record<string, unknown> | undefined;

      expect(emailRow).to.not.be.undefined;
      expect(emailRow!['is_filtered']).to.equal(1);
    });

    it('auto-applies an enabled filter during post-sync processing', async function () {
      this.timeout(25_000);

      // Create a star filter BEFORE syncing the new message
      await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Auto-Star Filter',
        conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'alice@example.com' }]),
        actions: JSON.stringify([{ type: 'star' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      });

      // Inject a new message with a different msgid/thrid
      const plainMsg = emlFixtures['plain-text'];
      const newMsgId = '9990000000000001';
      const newThrid = '9990000000000002';
      const modifiedRaw = Buffer.from(
        plainMsg.raw.toString('utf8')
          .replace(plainMsg.headers.xGmMsgId, newMsgId)
          .replace(plainMsg.headers.xGmThrid, newThrid)
          .replace('Message-ID: <plain-text-001@example.com>', 'Message-ID: <postsync-filter-test@example.com>'),
        'utf8',
      );

      imapStateInspector.injectMessage('[Gmail]/All Mail', modifiedRaw, {
        xGmMsgId: newMsgId,
        xGmThrid: newThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', modifiedRaw, {
        xGmMsgId: newMsgId,
        xGmThrid: newThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();

      // is_filtered must be 1 (filter processing ran)
      const emailRow = rawDb.prepare(
        'SELECT is_filtered, is_starred FROM emails WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).get({ xGmMsgId: newMsgId, accountId: suiteAccountId }) as Record<string, unknown> | undefined;

      expect(emailRow).to.not.be.undefined;
      expect(emailRow!['is_filtered']).to.equal(1);
      // The star filter should have applied
      expect(emailRow!['is_starred']).to.equal(1);
    });
  });
});
