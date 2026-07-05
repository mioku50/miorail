import test from 'node:test';
import assert from 'node:assert';
import { buildActionPlan, planHasCalls } from './actionPlan.js';

const RECIPI = '0x1111111111111111111111111111111111111111';
const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

test('buildActionPlan encodes a safe USDC transfer on mainnet-readonly', () => {
  const plan = buildActionPlan(`Transfer 1 USDC to ${RECIPI}`, { chainEnv: 'mainnet-readonly' });
  assert.ok(planHasCalls(plan));
  assert.strictEqual(plan.chain, 'eip155:8453');
  assert.strictEqual(plan.calls.length, 1);
  assert.strictEqual(plan.calls[0].to.toLowerCase(), BASE_MAINNET_USDC.toLowerCase());
  assert.strictEqual(plan.calls[0].value, '0');
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

test('buildActionPlan falls back to read-only for unrecognized intents', () => {
  const plan = buildActionPlan('analyze my wallet tokens for risk', { chainEnv: 'mainnet-readonly' });
  assert.ok(!planHasCalls(plan));
  assert.strictEqual(plan.calls.length, 0);
  assert.strictEqual(plan.readOnly, true);
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
