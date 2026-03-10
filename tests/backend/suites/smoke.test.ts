/**
 * smoke.test.ts — Phase 1 verification smoke test.
 *
 * Verifies that:
 *   1. The database is initialized with the expected tables
 *   2. TestEventBus records and retrieves events correctly
 *   3. IPC handlers can be invoked via callIpc()
 *
 * NOTE: This test suite is temporary and should be deleted after Phase 1 acceptance.
 */

import { expect } from 'chai';
import { DatabaseService } from '../../../electron/services/database-service';
import { TestEventBus } from '../infrastructure/test-event-bus';
import { callIpc } from '../infrastructure/test-helpers';

describe('Smoke Test (Phase 1 verification — delete after Phase 1 acceptance)', () => {
  it('should have database initialized with expected tables', () => {
    const database = DatabaseService.getInstance().getDatabase();
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tables.map((table) => table.name);
    expect(tableNames).to.include('accounts');
    expect(tableNames).to.include('emails');
    expect(tableNames).to.include('threads');
    expect(tableNames).to.include('labels');
    expect(tableNames).to.include('filters');
    expect(tableNames).to.include('settings');
  });

  it('should capture events from TestEventBus', async () => {
    const bus = TestEventBus.getInstance();
    bus.clear();
    // Emit a synthetic event
    bus.emit('test:event', ['hello', 'world']);
    const history = bus.getHistory('test:event');
    expect(history).to.have.length(1);
    expect(history[0].args).to.deep.equal(['hello', 'world']);
  });

  it('should invoke IPC handlers via callIpc', async () => {
    const result = await callIpc('db:get-settings') as { success: boolean; data?: unknown };
    expect(result).to.have.property('success', true);
  });
});
