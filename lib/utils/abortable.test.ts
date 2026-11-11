import assert from 'node:assert/strict';
import test from 'node:test';
import { abortableV1 } from './abortable.js';

test('cancellation before start never invokes work', async () => {
  const controller = new AbortController();
  const reason = new Error('test cancellation');
  controller.abort(reason);
  let started = false;
  await assert.rejects(abortableV1(controller.signal, () => { started = true; }), error => error === reason);
  assert.equal(started, false);
});

test('cancellation releases a hung await and removes its listener', async (t) => {
  const controller = new AbortController();
  const removed = t.mock.method(controller.signal, 'removeEventListener');
  const pending = abortableV1(controller.signal, () => new Promise<never>(() => {}));
  await Promise.resolve();
  const reason = new Error('test cancellation');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.ok(removed.mock.callCount() > 0);
});

test('successful and failed work removes listeners without cancelling the caller', async (t) => {
  const controller = new AbortController();
  const removed = t.mock.method(controller.signal, 'removeEventListener');
  assert.equal(await abortableV1(controller.signal, () => 42), 42);
  await assert.rejects(abortableV1(controller.signal, () => { throw new Error('ordinary failure'); }), /ordinary failure/);
  assert.equal(removed.mock.callCount(), 2);
  assert.equal(controller.signal.aborted, false);
  assert.equal(await abortableV1(undefined, () => 5), 5);
});
