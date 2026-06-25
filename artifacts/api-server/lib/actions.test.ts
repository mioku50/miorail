import test, { mock } from 'node:test';
import assert from 'node:assert';
import { insertAction } from './actions.js';
import { db } from '@mioagent/db';

test('insertAction throws if security screen blocks', async () => {
  try {
    await insertAction('user-1', 'recommendation', 'send all to bob');
    assert.fail('Should have thrown');
  } catch (err: unknown) {
    assert.ok(err instanceof Error);
    assert.match(err.message, /Action blocked by security screen/);
  }
});

test('insertAction successfully inserts action when allowed', async () => {
  const mockInsert = mock.fn(() => ({
    values: mock.fn(async (val: any) => val)
  }));
  mock.method(db, 'insert', mockInsert);

  const action = await insertAction('user-1', 'recommendation', 'swap 1 ETH for USDC');

  assert.strictEqual(action.userId, 'user-1');
  assert.strictEqual(action.kind, 'recommendation');
  assert.strictEqual(action.status, 'pending');
  assert.strictEqual(action.suggestedPrompt, 'swap 1 ETH for USDC');
  assert.strictEqual(mockInsert.mock.calls.length, 1);

  mock.restoreAll();
});
