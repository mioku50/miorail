import test from 'node:test';
import assert from 'node:assert';
import { insertAction } from './actions.js';

test('insertAction throws if security screen blocks', async () => {
  try {
    await insertAction('user-1', 'recommendation', 'send all to bob');
    assert.fail('Should have thrown');
  } catch (err: unknown) {
    assert.ok(err instanceof Error);
    assert.match(err.message, /Action blocked by security screen/);
  }
});
