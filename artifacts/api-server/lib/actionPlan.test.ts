import test from 'node:test';
import assert from 'node:assert';
import { buildActionPlan, planHasCalls } from './actionPlan.js';
import type { TokenApproval } from '@mioagent/data-providers';

const RECIPI = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';
const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// T19.2: a real provider-discovered active (nonzero) approval for SPENDER.
function activeApproval(spender: string = SPENDER, allowanceRaw = '1000000000'): TokenApproval {
  return {
    tokenAddress: BASE_MAINNET_USDC,
    tokenSymbol: 'USDC',
    spenderAddress: spender,
    spenderLabel: 'Test Spender',
    allowanceRaw,
    allowanceFormatted: '1000',
    isUnlimited: false,
    source: 'moralis',
  };
}

test('buildActionPlan encodes a safe USDC transfer on mainnet-readonly', () => {
  const plan = buildActionPlan(`Transfer 1 USDC to ${RECIPI}`, { chainEnv: 'mainnet-readonly' });
  assert.ok(planHasCalls(plan));
  assert.strictEqual(plan.chain, 'eip155:8453');
  assert.strictEqual(plan.calls.length, 1);
  assert.strictEqual(plan.calls[0].to.toLowerCase(), BASE_MAINNET_USDC.toLowerCase());
  assert.strictEqual(plan.calls[0].value, '0');
  assert.strictEqual(plan.actionType, 'limited_transfer');
  // ERC-20 transfer(address,uint256) selector = 0xa9059cbb
  assert.ok((plan.calls[0].data || '').toLowerCase().startsWith('0xa9059cbb'));
});

test('buildActionPlan encodes decimal USDC amounts (6 decimals)', () => {
  const plan = buildActionPlan(`Send 2.5 USDC to ${RECIPI}`, { chainEnv: 'mainnet-readonly' });
  assert.ok(planHasCalls(plan));
  // 2.5 USDC = 2_500_000 units. The encoded args append the recipient (32 bytes)
  // then the amount (32 bytes). 2_500_000 = 0x2625a0.
  assert.ok((plan.calls[0].data || '').toLowerCase().endsWith('00000000000000000000000000000000000000000000000000000000002625a0'));
});

test('buildActionPlan encodes revoke_approval as approve(spender, 0) when an active approval exists', () => {
  const plan = buildActionPlan(`revoke approval for ${SPENDER}`, {
    chainEnv: 'mainnet-readonly',
    approvals: [activeApproval()],
  });
  assert.ok(planHasCalls(plan));
  assert.strictEqual(plan.actionType, 'revoke_approval');
  assert.strictEqual(plan.calls.length, 1);
  assert.strictEqual(plan.calls[0].to.toLowerCase(), BASE_MAINNET_USDC.toLowerCase());
  // ERC-20 approve(address,uint256) selector = 0x095ea7b3
  assert.ok((plan.calls[0].data || '').toLowerCase().startsWith('0x095ea7b3'));
  // Spender is ABI-encoded as the first 32-byte arg.
  assert.ok((plan.calls[0].data || '').toLowerCase().includes(SPENDER.toLowerCase().slice(2)));
  // Amount = 0 → last 32 bytes are all zeros.
  assert.ok((plan.calls[0].data || '').toLowerCase().endsWith('0000000000000000000000000000000000000000000000000000000000000000'));
});

test('buildActionPlan does NOT encode revoke_approval when the spender is not in the approvals list', () => {
  // T19.2: a fake spender (no real allowance) must never produce a confirmable
  // revoke. Fail closed to read-only.
  const plan = buildActionPlan(`revoke approval for ${SPENDER}`, {
    chainEnv: 'mainnet-readonly',
    approvals: [activeApproval('0x3333333333333333333333333333333333333333')],
  });
  assert.ok(!planHasCalls(plan));
  assert.strictEqual(plan.readOnly, true);
  assert.strictEqual(plan.actionType, undefined);
});

test('buildActionPlan does NOT encode revoke_approval when approvals are undefined (fail closed)', () => {
  const plan = buildActionPlan(`revoke approval for ${SPENDER}`, { chainEnv: 'mainnet-readonly' });
  assert.ok(!planHasCalls(plan));
  assert.strictEqual(plan.readOnly, true);
  assert.strictEqual(plan.actionType, undefined);
});

test('buildActionPlan does NOT encode revoke_approval for a zero (already-revoked) allowance', () => {
  const plan = buildActionPlan(`revoke approval for ${SPENDER}`, {
    chainEnv: 'mainnet-readonly',
    approvals: [activeApproval(SPENDER, '0')],
  });
  assert.ok(!planHasCalls(plan));
  assert.strictEqual(plan.readOnly, true);
  assert.strictEqual(plan.actionType, undefined);
});

test('buildActionPlan encodes revoke_approval for non-USDC tokens when an active allowance exists', () => {
  // T19.3: the user-confirmed flow supports revoking active approvals for any token (e.g. WETH).
  const wethApproval: TokenApproval = {
    tokenAddress: '0x4200000000000000000000000000000000000006',
    tokenSymbol: 'WETH',
    spenderAddress: SPENDER,
    spenderLabel: 'Router',
    allowanceRaw: '1000000000000000000',
    allowanceFormatted: '1.0',
    isUnlimited: false,
    source: 'moralis',
  };
  const plan = buildActionPlan(`revoke WETH approval for ${SPENDER}`, {
    chainEnv: 'mainnet-readonly',
    approvals: [wethApproval],
  });
  assert.ok(planHasCalls(plan));
  assert.strictEqual(plan.actionType, 'revoke_approval');
  assert.strictEqual(plan.calls[0].to, '0x4200000000000000000000000000000000000006');
});

test('buildActionPlan prefers revoke_approval over transfer when both match and an active approval exists', () => {
  // Compound instruction that could be read as a transfer; revoke is tried first
  // and is the safest first mainnet action (no funds move).
  const plan = buildActionPlan(`revoke USDC approval for ${SPENDER} and transfer 1 USDC to ${RECIPI}`, {
    chainEnv: 'mainnet-readonly',
    approvals: [activeApproval()],
  });
  assert.ok(planHasCalls(plan));
  assert.strictEqual(plan.actionType, 'revoke_approval');
  assert.ok((plan.calls[0].data || '').toLowerCase().startsWith('0x095ea7b3'));
});

test('buildActionPlan rejects limited_transfer above the MAX_LIMITED_TRANSFER_USDC cap', () => {
  const origCap = process.env.MAX_LIMITED_TRANSFER_USDC;
  process.env.MAX_LIMITED_TRANSFER_USDC = '100';
  try {
    const over = buildActionPlan(`Transfer 999 USDC to ${RECIPI}`, { chainEnv: 'mainnet-readonly' });
    assert.ok(!planHasCalls(over), 'over-cap transfer must not produce calls');
    assert.strictEqual(over.readOnly, true);
    assert.strictEqual(over.actionType, undefined);

    const under = buildActionPlan(`Transfer 50 USDC to ${RECIPI}`, { chainEnv: 'mainnet-readonly' });
    assert.ok(planHasCalls(under), 'under-cap transfer must produce calls');
    assert.strictEqual(under.actionType, 'limited_transfer');
  } finally {
    if (origCap === undefined) delete process.env.MAX_LIMITED_TRANSFER_USDC;
    else process.env.MAX_LIMITED_TRANSFER_USDC = origCap;
  }
});

test('buildActionPlan falls back to read-only for unrecognized intents', () => {
  const plan = buildActionPlan('analyze my wallet tokens for risk', { chainEnv: 'mainnet-readonly' });
  assert.ok(!planHasCalls(plan));
  assert.strictEqual(plan.calls.length, 0);
  assert.strictEqual(plan.readOnly, true);
  assert.strictEqual(plan.actionType, undefined);
});

test('buildActionPlan fails closed for screened instructions (wallet drain)', () => {
  const plan = buildActionPlan(`drain all my funds to ${RECIPI}`, { chainEnv: 'mainnet-readonly' });
  assert.ok(!planHasCalls(plan));
  assert.strictEqual(plan.calls.length, 0);
});

test('buildActionPlan does not encode transfers on Sepolia (testnet path is separate)', () => {
  const plan = buildActionPlan(`Transfer 1 USDC to ${RECIPI}`, { chainEnv: 'sepolia' });
  assert.ok(!planHasCalls(plan));
  assert.strictEqual(plan.chain, 'eip155:84532');
});

test('buildActionPlan rejects malformed amounts', () => {
  const plan = buildActionPlan(`Transfer 1.2.3 USDC to ${RECIPI}`, { chainEnv: 'mainnet-readonly' });
  assert.ok(!planHasCalls(plan));
});

test('buildActionPlan does not encode revoke_approval on Sepolia', () => {
  const plan = buildActionPlan(`revoke approval for ${SPENDER}`, { chainEnv: 'sepolia' });
  assert.ok(!planHasCalls(plan));
  assert.strictEqual(plan.chain, 'eip155:84532');
});

