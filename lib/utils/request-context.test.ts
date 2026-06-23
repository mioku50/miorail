import test from 'node:test';
import assert from 'node:assert';
import { requestContext } from './request-context.js';

test('requestContext - run and getStore', async () => {
  const result = await requestContext.run({ requestId: 'req-1', userId: 'user-A' }, async () => {
    // Simulate async work
    await new Promise((resolve) => setTimeout(resolve, 10));

    const store = requestContext.getStore();
    return store;
  });

  assert.ok(result);
  assert.strictEqual(result.requestId, 'req-1');
  assert.strictEqual(result.userId, 'user-A');
});

test('requestContext - isolation between runs', async () => {
  const p1 = requestContext.run({ requestId: 'req-1' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return requestContext.getStore()?.requestId;
  });

  const p2 = requestContext.run({ requestId: 'req-2' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return requestContext.getStore()?.requestId;
  });

  const [res1, res2] = await Promise.all([p1, p2]);

  assert.strictEqual(res1, 'req-1');
  assert.strictEqual(res2, 'req-2');
});

test('requestContext - set value', async () => {
  await requestContext.run({ requestId: 'req-1' }, async () => {
    requestContext.set('userId', 'user-B');
    const store = requestContext.getStore();

    assert.strictEqual(store?.requestId, 'req-1');
    assert.strictEqual(store?.userId, 'user-B');
  });
});
