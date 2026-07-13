import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listDynamicBaseMcpToolsCached,
  dynamicBaseMcpCacheKey,
  clearDynamicBaseMcpToolsCacheForTests,
} from '../src/dynamicBaseMcpCache.js';

function createMockClient(name: string) {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      getClient() {
        return {
          listTools: async () => {
            calls += 1;
            return { tools: [{ name, description: 'read-only', inputSchema: { type: 'object', properties: {} } }] };
          },
          callTool: async () => ({ content: [] }),
        };
      },
    },
  };
}

test.beforeEach(() => clearDynamicBaseMcpToolsCacheForTests());

test('a second call within the TTL and same (userId, oauth-token-version) key reuses the cached inventory (no second listTools call)', async () => {
  const mock = createMockClient('get_balance');
  const key = dynamicBaseMcpCacheKey('user-1', 'token-v1');
  const first = await listDynamicBaseMcpToolsCached(mock.client, key, undefined, { now: () => 1_000 });
  const second = await listDynamicBaseMcpToolsCached(mock.client, key, undefined, { now: () => 1_500 });
  assert.equal(mock.calls(), 1);
  assert.deepEqual(first.map((t) => t.name), second.map((t) => t.name));
});

test('a different oauth-token-version busts the cache immediately (reconnect/refresh invalidates stale inventory)', async () => {
  const mock = createMockClient('get_balance');
  const keyV1 = dynamicBaseMcpCacheKey('user-1', 'token-v1');
  const keyV2 = dynamicBaseMcpCacheKey('user-1', 'token-v2');
  await listDynamicBaseMcpToolsCached(mock.client, keyV1, undefined, { now: () => 1_000 });
  await listDynamicBaseMcpToolsCached(mock.client, keyV2, undefined, { now: () => 1_000 });
  assert.equal(mock.calls(), 2);
});

test('different users never share a cache entry', async () => {
  const mock = createMockClient('get_balance');
  await listDynamicBaseMcpToolsCached(mock.client, dynamicBaseMcpCacheKey('user-1', 'v1'), undefined, { now: () => 1_000 });
  await listDynamicBaseMcpToolsCached(mock.client, dynamicBaseMcpCacheKey('user-2', 'v1'), undefined, { now: () => 1_000 });
  assert.equal(mock.calls(), 2);
});

test('the cache expires after the TTL and re-lists live', async () => {
  const mock = createMockClient('get_balance');
  const key = dynamicBaseMcpCacheKey('user-1', 'token-v1');
  await listDynamicBaseMcpToolsCached(mock.client, key, undefined, { now: () => 0, ttlMs: 60_000 });
  await listDynamicBaseMcpToolsCached(mock.client, key, undefined, { now: () => 30_000, ttlMs: 60_000 });
  assert.equal(mock.calls(), 1);
  await listDynamicBaseMcpToolsCached(mock.client, key, undefined, { now: () => 60_001, ttlMs: 60_000 });
  assert.equal(mock.calls(), 2);
});
