import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaseAppNotifyErrorV1, createBaseAppNotifyClientV1, type BaseAppNotifyClientV1 } from './baseAppNotify.js';
import { baseAppNotifyStatusV1 } from './baseAppNotifyStatus.js';

const KEY = 'fixture-notification-key';
const config = { apiKey: KEY, appUrl: 'https://example.com' };
const WALLET = `0x${'1'.repeat(40)}`;
function reader(status: number, body: unknown, calls: string[] = []) {
  return createBaseAppNotifyClientV1({ config, gapMs: 0, fetch: (async (_url, init) => {
    calls.push(String(init?.method));
    assert.equal(init?.method, 'GET', 'the availability probe must not send');
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch });
}

test('an off channel performs no provider request', async () => {
  let reads = 0;
  const client: BaseAppNotifyClientV1 = {
    enabledWallets: async () => { reads++; return new Set(); },
    send: async () => { assert.fail('must not send'); },
  };
  assert.deepEqual(await baseAppNotifyStatusV1({ config: null, client }), { state: 'off', reason: null, optedIn: null });
  assert.equal(reads, 0);
});

test('provider readiness is an opt-in read, not proof that a push was delivered', async () => {
  const calls: string[] = [];
  assert.deepEqual(await baseAppNotifyStatusV1({ config, client: reader(200, {
    success: true, users: [{ address: WALLET, notificationsEnabled: true }],
  }, calls) }), { state: 'ready', reason: null, optedIn: 1 });
  assert.deepEqual(calls, ['GET']);
  assert.deepEqual(await baseAppNotifyStatusV1({ config, client: reader(200, { success: true, users: [] }) }),
    { state: 'ready', reason: null, optedIn: 0 });
});

test('the provider retirement notice is classified without retaining its body', async () => {
  const client = reader(404, { code: 5, message: 'Notification endpoint has been retired', details: [KEY] });
  const error = await client.enabledWallets().catch(cause => cause as BaseAppNotifyErrorV1);
  assert.ok(error instanceof BaseAppNotifyErrorV1);
  assert.equal(error.status, 404);
  assert.equal(error.transient, false);
  assert.equal(error.message, 'base_app_notifications_retired');
  assert.ok(!String(error.stack).includes(KEY));
  const result = await baseAppNotifyStatusV1({ config, client });
  assert.deepEqual(result, { state: 'unavailable', reason: 'provider_retired', optedIn: null });
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('an ordinary 404 or an unrecognised error is not called a retired API', async () => {
  for (const body of [
    { code: 5, message: 'Project not found' },
    { code: 3, message: 'Notification endpoint has been retired' },
    { code: 5, message: `Notification endpoint has been retired ${KEY}` },
  ]) {
    assert.deepEqual(await baseAppNotifyStatusV1({ config, client: reader(404, body) }),
      { state: 'unavailable', reason: 'provider_404', optedIn: null });
  }
});

test('an unknown successful response is unavailable, never zero subscribers', async () => {
  assert.deepEqual(await baseAppNotifyStatusV1({ config, client: reader(200, {}) }),
    { state: 'unavailable', reason: 'unreadable_subscriber_list', optedIn: null });
});

test('incomplete subscribers and provider failures stay distinct and leak no prose', async () => {
  const cases: [number | null, string, string][] = [
    [200, 'base_app_subscribers_incomplete', 'incomplete_subscriber_list'],
    [401, `provider prose ${KEY}`, 'authentication_refused'],
    [403, `provider prose ${KEY}`, 'access_refused'],
    [429, `provider prose ${KEY}`, 'provider_rate_limited'],
    [503, `provider prose ${KEY}`, 'provider_unavailable'],
    [null, `provider prose ${KEY}`, 'provider_unavailable'],
  ];
  for (const [status, message, reason] of cases) {
    const client: BaseAppNotifyClientV1 = {
      enabledWallets: async () => { throw new BaseAppNotifyErrorV1(status, true, message); },
      send: async () => { assert.fail('must not send'); },
    };
    assert.deepEqual(await baseAppNotifyStatusV1({ config, client }), { state: 'unavailable', reason, optedIn: null });
  }
});
