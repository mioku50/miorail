import assert from 'node:assert/strict';
import test from 'node:test';
import { AutonomousExecutionGateway } from './gateway';
import { InMemoryAutonomyPolicyRepository } from './policyRepository';

const USER = 'user-1';
const WALLET = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function calldata(selector: string, account: string, amount: bigint): string {
  return `${selector}${account.slice(2).padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;
}

function transfer(recipient = RECIPIENT, usdc = 1): { to: string; data: string; value: string } {
  return { to: MAINNET_USDC, data: calldata('0xa9059cbb', recipient, BigInt(usdc * 1_000_000)), value: '0' };
}

async function setup(overrides: Partial<Parameters<InMemoryAutonomyPolicyRepository['configure']>[0]> = {}) {
  const repository = new InMemoryAutonomyPolicyRepository();
  const policy = await repository.configure({
    userId: USER,
    chainId: 8453,
    walletAddress: WALLET,
    dailyLimit: 100,
    maxPerAction: 75,
    whitelist: [RECIPIENT],
    scope: 'bounded-approval',
    expiresAt: Date.now() + 60_000,
    mainnetOptIn: true,
    ...overrides,
  });
  const rawGateway = new AutonomousExecutionGateway({ repository, mainnetExecutionEnabled: true });
  const gateway = {
    prepare(input: Parameters<AutonomousExecutionGateway['prepare']>[0]) {
      return rawGateway.prepare({
        ...input,
        providerContext: { risk: 'connected', riskProvider: 'goplus', securityProvider: 'goplus' },
        tokenSecurity: [{ address: MAINNET_USDC, provider: 'goplus', status: 'ok' }],
      });
    },
  };
  return { repository, policy, gateway };
}

test('prepares unsigned atomic Base Account calls and reserves the transfer amount', async () => {
  const { gateway, repository } = await setup();
  const result = await gateway.prepare({
    userId: USER,
    actionId: 'action-1',
    chainEnv: 'mainnet',
    walletAddress: WALLET,
    actionType: 'limited_transfer',
    calls: [transfer(RECIPIENT, 25)],
    instruction: 'Transfer 25 USDC to an approved recipient',
  });

  assert.equal(result.success, true);
  assert.equal(result.status, 'approval_required');
  assert.equal(result.spendAmountUsdc, 25);
  assert.equal(result.requiresUserApproval, true);
  assert.equal(result.broadcasted, false);
  assert.deepEqual(result.sendCallsRequest, {
    version: '2.0.0',
    from: WALLET,
    chainId: '0x2105',
    atomicRequired: true,
    calls: [transfer(RECIPIENT, 25)],
  });
  assert.equal((await repository.getByUser(USER, 8453))?.reservedToday, 25);
});

test('fails closed on global mainnet flag, opt-in, expiry, wallet mismatch and kill switch', async () => {
  const { repository, policy } = await setup();
  const input = {
    userId: USER,
    actionId: 'gate-action',
    chainEnv: 'mainnet',
    walletAddress: WALLET,
    actionType: 'limited_transfer' as const,
    calls: [transfer()],
    instruction: 'Transfer one USDC',
  };

  const disabled = new AutonomousExecutionGateway({ repository, mainnetExecutionEnabled: false });
  assert.equal((await disabled.prepare(input)).status, 'mainnet_disabled');

  const noOptIn = await setup({ mainnetOptIn: false });
  assert.equal((await noOptIn.gateway.prepare({ ...input, actionId: 'no-opt-in' })).status, 'mainnet_opt_in_required');

  const expired = await setup({ expiresAt: Date.now() + 5 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await expired.gateway.prepare({ ...input, actionId: 'expired' })).status, 'permission_expired');

  const enabled = new AutonomousExecutionGateway({ repository, mainnetExecutionEnabled: true });
  assert.equal((await enabled.prepare({ ...input, actionId: 'wrong-wallet', walletAddress: OTHER })).status, 'wallet_mismatch');

  await repository.setKillSwitch(policy.id, true);
  assert.equal((await enabled.prepare({ ...input, actionId: 'killed' })).status, 'kill_switch');
});

test('enforces whitelist, zero-only revokes and max-per-action', async () => {
  const { gateway } = await setup();
  assert.equal((await gateway.prepare({
    userId: USER,
    actionId: 'wrong-recipient',
    chainEnv: 'mainnet',
    walletAddress: WALLET,
    actionType: 'limited_transfer',
    calls: [transfer(OTHER)],
    instruction: 'Transfer one USDC',
  })).status, 'recipient_not_whitelisted');

  assert.equal((await gateway.prepare({
    userId: USER,
    actionId: 'unsafe-approval',
    chainEnv: 'mainnet',
    walletAddress: WALLET,
    actionType: 'revoke_approval',
    calls: [{ to: MAINNET_USDC, data: calldata('0x095ea7b3', OTHER, 1n), value: '0' }],
    instruction: 'Revoke approval',
  })).status, 'action_calldata_mismatch');

  const revoke = await gateway.prepare({
    userId: USER,
    actionId: 'safe-revoke',
    chainEnv: 'mainnet',
    walletAddress: WALLET,
    actionType: 'revoke_approval',
    calls: [{ to: MAINNET_USDC, data: calldata('0x095ea7b3', OTHER, 0n), value: '0' }],
    instruction: 'Revoke approval by setting it to zero',
  });
  assert.equal(revoke.success, true);
  assert.equal(revoke.spendAmountUsdc, 0);

  assert.equal((await gateway.prepare({
    userId: USER,
    actionId: 'over-action-cap',
    chainEnv: 'mainnet',
    walletAddress: WALLET,
    actionType: 'limited_transfer',
    calls: [transfer(RECIPIENT, 76)],
    instruction: 'Transfer 76 USDC',
  })).status, 'max_per_action_exceeded');
});

const M_USDC = '0x4444444444444444444444444444444444444444';

function moonwellApprove(usdc = 25): { to: string; data: string; value: string } {
  return { to: MAINNET_USDC, data: calldata('0x095ea7b3', M_USDC, BigInt(usdc * 1_000_000)), value: '0' };
}

function moonwellVerb(): { to: string; data: string; value: string } {
  return { to: M_USDC, data: `0xa0712d68${(25_000_000n).toString(16).padStart(64, '0')}`, value: '0' };
}

test('T44b: moonwell supply prepares the stored batch and reserves the prepared amount', async () => {
  const { gateway, repository } = await setup();
  const calls = [moonwellApprove(25), moonwellVerb()];
  const result = await gateway.prepare({
    userId: USER,
    actionId: 'moonwell-1',
    chainEnv: 'mainnet',
    walletAddress: WALLET,
    actionType: 'moonwell_supply',
    calls,
    instruction: 'supply 25 USDC to moonwell',
    moonwell: { amountDecimal: '25' },
  });

  assert.equal(result.success, true, result.error);
  assert.equal(result.status, 'approval_required');
  assert.equal(result.spendAmountUsdc, 25);
  assert.equal(result.requiresUserApproval, true);
  assert.equal(result.broadcasted, false);
  assert.deepEqual(result.sendCallsRequest?.calls, calls);
  assert.equal(result.sendCallsRequest?.chainId, '0x2105');
  assert.equal((await repository.getByUser(USER, 8453))?.reservedToday, 25);
});

test('T44b: moonwell amounts above maxPerAction fail the reservation', async () => {
  const { gateway, repository } = await setup();
  const result = await gateway.prepare({
    userId: USER,
    actionId: 'moonwell-over-cap',
    chainEnv: 'mainnet',
    walletAddress: WALLET,
    actionType: 'moonwell_borrow',
    calls: [{ to: M_USDC, data: `0xc5ebeaec${(76_000_000n).toString(16).padStart(64, '0')}`, value: '0' }],
    instruction: 'borrow 76 USDC on moonwell',
    moonwell: { amountDecimal: '76' },
  });
  assert.equal(result.success, false);
  assert.equal(result.status, 'max_per_action_exceeded');
  assert.equal((await repository.getByUser(USER, 8453))?.reservedToday, 0);
});

test('T44b: a moonwell batch whose approve mismatches the prepared amount is guard-blocked before reservation', async () => {
  const { gateway, repository } = await setup();
  const result = await gateway.prepare({
    userId: USER,
    actionId: 'moonwell-bad-approve',
    chainEnv: 'mainnet',
    walletAddress: WALLET,
    actionType: 'moonwell_supply',
    calls: [moonwellApprove(60), moonwellVerb()],
    instruction: 'supply 25 USDC to moonwell',
    moonwell: { amountDecimal: '25' },
  });
  assert.equal(result.success, false);
  assert.equal(result.status, 'moonwell_approve_amount_mismatch');
  assert.equal((await repository.getByUser(USER, 8453))?.reservedToday, 0);
});

test('atomic reservations prevent concurrent daily-limit overspend', async () => {
  const { gateway, repository } = await setup({ maxPerAction: 100 });
  const prepare = (actionId: string) => gateway.prepare({
    userId: USER,
    actionId,
    chainEnv: 'mainnet',
    walletAddress: WALLET,
    actionType: 'limited_transfer' as const,
    calls: [transfer(RECIPIENT, 60)],
    instruction: 'Transfer 60 USDC',
  });
  const results = await Promise.all([prepare('concurrent-a'), prepare('concurrent-b')]);

  assert.equal(results.filter((result) => result.success).length, 1);
  assert.equal(results.filter((result) => result.status === 'daily_limit_exceeded').length, 1);
  assert.equal((await repository.getByUser(USER, 8453))?.reservedToday, 60);
});

test('late settlement does not consume another active reservation', async () => {
  const { gateway, repository } = await setup({ maxPerAction: 100 });
  const prepare = (actionId: string, amount: number) => gateway.prepare({
    userId: USER,
    actionId,
    chainEnv: 'mainnet',
    walletAddress: WALLET,
    actionType: 'limited_transfer' as const,
    calls: [transfer(RECIPIENT, amount)],
    instruction: `Transfer ${amount} USDC`,
  });
  await prepare('late-a', 10);
  await repository.release('late-a');
  await prepare('active-b', 20);
  await repository.settle('late-a', { txHash: '0xabc' });

  const policy = await repository.getByUser(USER, 8453);
  assert.equal(policy?.spentToday, 10);
  assert.equal(policy?.reservedToday, 20);
});
