import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BudgetGuard, BudgetEntry } from './budget.js';

describe('BudgetGuard', () => {
  it('should add and retrieve entries', () => {
    const guard = new BudgetGuard();
    const entry: BudgetEntry = {
      actionId: 'action-1',
      cost: 100n,
      txHash: '0x123',
      timestamp: new Date('2024-01-01T00:00:00Z'),
    };

    guard.addEntry(entry);
    const entries = guard.getEntries();

    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].actionId, 'action-1');
  });

  it('should initialize with provided entries', () => {
    const entries: BudgetEntry[] = [{
      actionId: 'action-1',
      cost: 100n,
      txHash: '0x123',
      timestamp: new Date('2024-01-01T00:00:00Z'),
    }];
    const guard = new BudgetGuard(entries);
    assert.strictEqual(guard.getEntries().length, 1);
    assert.strictEqual(guard.getEntries()[0].actionId, 'action-1');
  });

  it('should export ledger correctly', () => {
    const guard = new BudgetGuard();
    guard.addEntry({
      actionId: 'action-1',
      cost: 100n,
      txHash: '0x123',
      timestamp: new Date('2024-01-01T00:00:00Z'),
    });

    guard.addEntry({
      actionId: 'action-2',
      cost: 50n,
      timestamp: new Date('2024-01-02T00:00:00Z'),
    });

    const expected = `2024-01-01T00:00:00.000Z - Action: action-1, Cost: 100, Tx: 0x123\n2024-01-02T00:00:00.000Z - Action: action-2, Cost: 50, Tx: N/A`;

    assert.strictEqual(guard.exportLedger(), expected);
  });
});
