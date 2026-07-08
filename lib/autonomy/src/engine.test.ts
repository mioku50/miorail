import test, { mock } from 'node:test';
import assert from 'node:assert';
import { base } from '@base-org/account';
import { AutonomyEngine, deriveBaseChain } from './engine';
import { InMemorySpendPermissionRepository } from './repository';
import { Call } from './types';

const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

function transferData(recipient: string, amount: bigint): string {
  return `0xa9059cbb${recipient.slice(2).padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;
}

test('AutonomyEngine persists permissions in repository outside engine instances', async () => {
  const repository = new InMemorySpendPermissionRepository();
  const engine1 = new AutonomyEngine({ repository, chainEnv: 'sepolia' });
  const engine2 = new AutonomyEngine({ repository, chainEnv: 'sepolia' });

  await engine1.createPermission({
    id: 'perm1',
    userId: 'user1',
    limit: 100,
    spent: 0,
    whitelist: ['0xallowed'],
    expiresAt: Date.now() + 10000,
    isActive: true,
  });

  const permission = await engine2.getPermission('perm1');
  assert.strictEqual(permission?.id, 'perm1');
  assert.strictEqual(permission?.chainId, 84532);
  assert.strictEqual(permission?.asset, BASE_SEPOLIA_USDC);
});

test('AutonomyEngine execution preparation on Sepolia does not increment spent', async () => {
  const engine = new AutonomyEngine({ chainEnv: 'sepolia' });

  await engine.createPermission({
    id: 'perm1',
    userId: 'user1',
    limit: 100,
    spent: 0,
    whitelist: ['0xallowed'],
    expiresAt: Date.now() + 10000,
    isActive: true,
  });

  const res1 = await engine.validateAndPrepareExecution('perm1', [{ to: '0xallowed', data: '0x', value: '0' }], 0);
  assert.strictEqual(res1.success, true);
  assert.deepStrictEqual(res1.sendCallsRequest, {
    version: '2.0.0',
    from: 'user1',
    chainId: '0x14a34',
    atomicRequired: true,
    calls: [{ to: '0xallowed', data: '0x', value: '0' }],
  });
  assert.strictEqual(res1.approvalUrl, 'base-account://wallet_sendCalls?chainId=0x14a34');

  const res2 = await engine.validateAndPrepareExecution('perm1', [{ to: '0xallowed', data: '0x', value: '0' }], 150);
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.error, 'Spend limit exceeded');

  const stored = await engine.getPermission('perm1');
  assert.strictEqual(stored?.spent, 0);

  await engine.killSwitch('perm1');
  const res3 = await engine.validateAndPrepareExecution('perm1', [{ to: '0xallowed', data: '0x', value: '0' }], 10);
  assert.strictEqual(res3.success, false);
  assert.strictEqual(res3.error, 'Permission is inactive (kill-switch engaged)');
});

test('AutonomyEngine prepares Base subscription charge using chain-derived testnet flag', async (t) => {
  const engine = new AutonomyEngine({ chainEnv: 'sepolia' });

  await engine.createPermission({
    id: 'sub1',
    userId: 'user1',
    limit: 100,
    spent: 0,
    whitelist: ['0xallowed'],
    expiresAt: Date.now() + 10000,
    isActive: true,
  });

  const mockGetStatus = mock.method(base.subscription, 'getStatus', async () => ({ isSubscribed: true }));
  const mockPrepareCharge = mock.method(base.subscription, 'prepareCharge', async (opts: { id: string; amount: string; testnet: boolean }) => [{ to: '0xcharge', data: `0x${opts.amount}`, value: 0n }]);
  const mockPrepareRevoke = mock.method(base.subscription, 'prepareRevoke', async () => ({ to: '0xrevoke', data: '0x', value: 0n }));

  t.after(() => {
    mockGetStatus.mock.restore();
    mockPrepareCharge.mock.restore();
    mockPrepareRevoke.mock.restore();
  });

  const res = await engine.validateAndPrepareExecution('sub1', [{ to: '0xallowed', data: '0x', value: '0' }], 50);
  assert.strictEqual(res.success, true);
  assert.deepStrictEqual((res.sendCallsRequest as { calls: Call[] }).calls, [
    { to: '0xcharge', data: '0x50', value: '0' },
    { to: '0xallowed', data: '0x', value: '0' },
  ]);
  assert.strictEqual(mockPrepareCharge.mock.calls.length, 1);
  assert.deepStrictEqual(mockPrepareCharge.mock.calls[0].arguments, [{ id: 'sub1', amount: '50', testnet: true }]);

  const status = await engine.getSubscriptionStatus('sub1');
  assert.deepStrictEqual(status, { isSubscribed: true });
  assert.deepStrictEqual(mockGetStatus.mock.calls[0].arguments, [{ id: 'sub1', testnet: true }]);

  const revoke = await engine.prepareSubscriptionRevoke('sub1');
  assert.deepStrictEqual(revoke, { to: '0xrevoke', data: '0x', value: 0n });
  assert.deepStrictEqual(mockPrepareRevoke.mock.calls[0].arguments, [{ id: 'sub1', testnet: true }]);
});

test('confirmed settlement increments spent atomically and requires durable proof', async () => {
  const engine = new AutonomyEngine({ chainEnv: 'sepolia' });
  await engine.createPermission({
    id: 'atomic1',
    userId: 'user1',
    limit: 100,
    spent: 0,
    whitelist: ['0xallowed'],
    expiresAt: Date.now() + 10000,
    isActive: true,
  });

  const missingProof = await engine.recordConfirmedSettlement('atomic1', 10, {});
  assert.strictEqual(missingProof.success, false);
  assert.strictEqual(missingProof.error, 'Confirmed settlement proof required');

  const results = await Promise.all([
    engine.recordConfirmedSettlement('atomic1', 60, { txHash: '0xaaa' }),
    engine.recordConfirmedSettlement('atomic1', 60, { txHash: '0xbbb' }),
  ]);
  assert.strictEqual(results.filter((result) => result.success).length, 1);
  assert.strictEqual(results.filter((result) => !result.success).length, 1);

  const stored = await engine.getPermission('atomic1');
  assert.strictEqual(stored?.spent, 60);
});

test('mainnet-readonly and missing user opt-in fail closed before prepareCharge', async (t) => {
  const mockPrepareCharge = mock.method(base.subscription, 'prepareCharge', async () => [{ to: '0xcharge', data: '0x', value: 0n }]);
  t.after(() => mockPrepareCharge.mock.restore());

  const readonlyEngine = new AutonomyEngine({
    chainEnv: 'mainnet-readonly',
    mainnetExecutionEnabled: true,
    mainnetOptIn: { isEnabled: async () => true },
  });
  await readonlyEngine.createPermission({
    id: 'mainnet-readonly',
    userId: 'user1',
    limit: 100,
    spent: 0,
    whitelist: [BASE_MAINNET_USDC],
    expiresAt: Date.now() + 10000,
    isActive: true,
  });

  const readonlyResult = await readonlyEngine.validateAndPrepareExecution(
    'mainnet-readonly',
    [{ to: BASE_MAINNET_USDC, data: transferData('0x1111111111111111111111111111111111111111', 1n), value: '0' }],
    1,
  );
  assert.strictEqual(readonlyResult.success, false);
  assert.strictEqual(readonlyResult.error, 'Mainnet autonomy is disabled in mainnet-readonly mode');

  const noOptInEngine = new AutonomyEngine({
    chainEnv: 'mainnet',
    mainnetExecutionEnabled: true,
    mainnetOptIn: { isEnabled: async () => false },
  });
  await noOptInEngine.createPermission({
    id: 'mainnet-no-optin',
    userId: 'user1',
    limit: 100,
    spent: 0,
    whitelist: [BASE_MAINNET_USDC],
    expiresAt: Date.now() + 10000,
    isActive: true,
  });

  const noOptInResult = await noOptInEngine.validateAndPrepareExecution(
    'mainnet-no-optin',
    [{ to: BASE_MAINNET_USDC, data: transferData('0x1111111111111111111111111111111111111111', 1n), value: '0' }],
    1,
  );
  assert.strictEqual(noOptInResult.success, false);
  assert.strictEqual(noOptInResult.error, 'Mainnet autonomy requires explicit user opt-in');
  assert.strictEqual(mockPrepareCharge.mock.calls.length, 0);
});

test('mainnet path derives chain 0x2105 and testnet false only after both gates pass', async (t) => {
  const engine = new AutonomyEngine({
    chainEnv: 'mainnet',
    mainnetExecutionEnabled: true,
    mainnetOptIn: { isEnabled: async (userId) => userId === 'user1' },
  });
  await engine.createPermission({
    id: 'mainnet-ok',
    userId: 'user1',
    limit: 100,
    spent: 0,
    whitelist: [BASE_MAINNET_USDC],
    expiresAt: Date.now() + 10000,
    isActive: true,
  });

  const mockPrepareCharge = mock.method(base.subscription, 'prepareCharge', async (opts: { id: string; amount: string; testnet: boolean }) => [{ to: BASE_MAINNET_USDC, data: `0x${opts.amount}`, value: 0n }]);
  t.after(() => mockPrepareCharge.mock.restore());

  const result = await engine.validateAndPrepareExecution(
    'mainnet-ok',
    [{ to: BASE_MAINNET_USDC, data: transferData('0x1111111111111111111111111111111111111111', 1n), value: '0' }],
    10,
    { instruction: 'Transfer 1 unit of canonical Base USDC within spend permission limits' },
  );
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.approvalUrl, 'base-account://wallet_sendCalls?chainId=0x2105');
  assert.strictEqual((result.sendCallsRequest as { chainId: string }).chainId, '0x2105');
  assert.deepStrictEqual(mockPrepareCharge.mock.calls[0].arguments, [{ id: 'mainnet-ok', amount: '10', testnet: false }]);

  const stored = await engine.getPermission('mainnet-ok');
  assert.strictEqual(stored?.spent, 0);
});

test('wrong USDC asset for chain fails closed', async () => {
  const engine = new AutonomyEngine({ chainEnv: 'mainnet' });
  await assert.rejects(
    () => engine.createPermission({
      id: 'wrong-asset',
      userId: 'user1',
      chainId: 8453,
      asset: BASE_SEPOLIA_USDC,
      limit: 100,
      spent: 0,
      whitelist: [BASE_SEPOLIA_USDC],
      expiresAt: Date.now() + 10000,
      isActive: true,
    }),
    /Only canonical USDC is supported on Base 8453/,
  );
});

test('deriveBaseChain maps env to Base chain metadata', () => {
  assert.deepStrictEqual(deriveBaseChain('mainnet'), {
    chainId: 8453,
    caip2: 'eip155:8453',
    hexChainId: '0x2105',
    mcpChain: 'base',
    sendCallsTool: 'send_calls',
  });
  assert.deepStrictEqual(deriveBaseChain('sepolia'), {
    chainId: 84532,
    caip2: 'eip155:84532',
    hexChainId: '0x14a34',
    mcpChain: 'base-sepolia',
    sendCallsTool: 'sepolia_send_calls',
  });
});
