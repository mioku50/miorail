import test, { mock } from 'node:test';
import assert from 'node:assert';
import { base } from '@base-org/account';
import { AutonomyEngine } from './engine';

test('AutonomyEngine execution preparation (no cost)', async () => {
  const engine = new AutonomyEngine();

  engine.createPermission({
    id: 'perm1',
    userId: 'user1',
    limit: 100,
    spent: 0,
    whitelist: ['0xallowed'],
    expiresAt: Date.now() + 10000,
    isActive: true
  });

  const res1 = await engine.validateAndPrepareExecution('perm1', [{ to: '0xallowed', data: '0x', value: '0' }], 0);
  assert.strictEqual(res1.success, true);
  assert.deepStrictEqual(res1.sendCallsRequest, {
    version: '2.0.0',
    from: 'user1',
    chainId: '0x14a34',
    atomicRequired: true,
    calls: [{ to: '0xallowed', data: '0x', value: '0' }]
  });

  const res2 = await engine.validateAndPrepareExecution('perm1', [{ to: '0xallowed', data: '0x', value: '0' }], 150);
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.error, 'Spend limit exceeded');

  engine.killSwitch('perm1');
  const res3 = await engine.validateAndPrepareExecution('perm1', [{ to: '0xallowed', data: '0x', value: '0' }], 10);
  assert.strictEqual(res3.success, false);
  assert.strictEqual(res3.error, 'Permission is inactive (kill-switch engaged)');
});

test('AutonomyEngine base.subscription integration with cost', async (t) => {
  const engine = new AutonomyEngine();

  engine.createPermission({
    id: 'sub1',
    userId: 'user1',
    limit: 100,
    spent: 0,
    whitelist: ['0xallowed'],
    expiresAt: Date.now() + 10000,
    isActive: true
  });

  const mockGetStatus = mock.method(base.subscription, 'getStatus', async () => ({ isSubscribed: true }));
  const mockPrepareCharge = mock.method(base.subscription, 'prepareCharge', async (opts: any) => [{ to: '0xcharge', data: '0x' + opts.amount, value: '0' }]);
  const mockPrepareRevoke = mock.method(base.subscription, 'prepareRevoke', async () => ({ to: '0xrevoke', data: '0x', value: '0' }));

  t.after(() => {
    mockGetStatus.mock.restore();
    mockPrepareCharge.mock.restore();
    mockPrepareRevoke.mock.restore();
  });

  const res = await engine.validateAndPrepareExecution('sub1', [{ to: '0xallowed', data: '0x', value: '0' }], 50);
  assert.strictEqual(res.success, true);
  assert.deepStrictEqual(res.sendCallsRequest.calls, [
    { to: '0xcharge', data: '0x50', value: '0' },
    { to: '0xallowed', data: '0x', value: '0' }
  ]);
  assert.strictEqual(mockPrepareCharge.mock.calls.length, 1);
  assert.deepStrictEqual(mockPrepareCharge.mock.calls[0].arguments, [{ id: 'sub1', amount: '50', testnet: true }]);

  const status = await engine.getSubscriptionStatus('sub1');
  assert.deepStrictEqual(status, { isSubscribed: true });

  const revoke = await engine.prepareSubscriptionRevoke('sub1');
  assert.deepStrictEqual(revoke, { to: '0xrevoke', data: '0x', value: '0' });
});
