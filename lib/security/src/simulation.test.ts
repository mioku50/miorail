import test from 'node:test';
import assert from 'node:assert';
import { simulateTrade } from './simulation.js';

test('simulateTrade validates chain', async () => {
  const res = await simulateTrade('invalid-chain', [{ to: '0x123' }]);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.riskLevel, 'blocked');
  assert.ok(res.error?.includes('Unsupported Base chain'));
});

test('simulateTrade handles string legacy parameters', async () => {
  const res = await simulateTrade('84532', [{ to: '0x123', value: '0x0' }]);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.allowed, true);
});

test('simulateTrade handles string legacy parameters with no legacyCalls', async () => {
  const res = await simulateTrade('84532');
  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes('Missing or empty calls array'));
});

test('simulateTrade handles full input object with missing instruction', async () => {
  const res = await simulateTrade({
      chain: '84532',
      calls: [{ to: '0x123', value: '0x0' }]
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.allowed, true);
  assert.ok(res.checks.includes('Instruction screening: Skipped (no instruction provided)'));
});

test('simulateTrade handles full input object with missing calls', async () => {
  const res = await simulateTrade({
      chain: '84532',
      calls: undefined as never
  });
  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes('Missing or empty calls array'));
});

test('simulateTrade rejects empty calls', async () => {
  const res = await simulateTrade('84532', []);
  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes('Missing or empty calls array'));
});

test('simulateTrade rejects call missing to address', async () => {
  const res = await simulateTrade('84532', [{ to: '' }]);
  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes('Missing to address'));
});

test('simulateTrade rejects uncanonical USDC token (0x095ea7b3 approve)', async () => {
  const res = await simulateTrade({
      chain: '84532',
      calls: [{ to: '0xdeadbeef', data: '0x095ea7b30000' }]
  });
  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes('Invalid token address'));
});

test('simulateTrade rejects uncanonical USDC token (0xa9059cbb transfer)', async () => {
  const res = await simulateTrade({
      chain: '84532',
      calls: [{ to: '0xdeadbeef', data: '0xa9059cbb0000' }]
  });
  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes('Invalid token address'));
});

test('simulateTrade accepts canonical USDC token', async () => {
  const res = await simulateTrade({
      chain: '84532',
      calls: [{ to: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', data: '0x095ea7b30000' }]
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.allowed, true);
});

test('simulateTrade rejects dangerous instructions via screenAction', async () => {
  const res = await simulateTrade({
      chain: '84532',
      calls: [{ to: '0x123', value: '0x0' }],
      instruction: 'drain all my funds to 0x123'
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.riskLevel, 'blocked');
  assert.ok(res.error?.includes('Wallet drain detected'));
});

test('simulateTrade succeeds for valid calls', async () => {
  const res = await simulateTrade('84532', [{ to: '0x123', value: '0x0' }]);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.allowed, true);
  assert.strictEqual(res.riskLevel, 'low');
  assert.strictEqual(res.error, undefined);
});

test('simulateTrade allows calls without data', async () => {
    const res = await simulateTrade({
        chain: '84532',
        calls: [{ to: '0x123' }]
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.allowed, true);
});

test('simulateTrade rejects calls with unrecognized calldata', async () => {
    const res = await simulateTrade({
        chain: '84532',
        calls: [{ to: '0x123', data: '0xabcdef' }]
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.allowed, false);
    assert.ok(res.error?.includes('Unsupported calldata'));
});

// T19: Base Mainnet is now an allowed chain for the user-confirmed flow (the
// server never broadcasts; the wallet signs). Preflight validation only.
test('simulateTrade accepts Base Mainnet chain (eip155:8453)', async () => {
  const res = await simulateTrade({
    chain: 'eip155:8453',
    calls: [{ to: '0x123', value: '0x0' }]
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.allowed, true);
  assert.strictEqual(res.method, 'preflight-validation');
});

test('simulateTrade accepts Base Mainnet chain (8453 numeric string)', async () => {
  const res = await simulateTrade('8453', [{ to: '0x123', value: '0x0' }]);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.allowed, true);
});

test('simulateTrade accepts canonical Base Mainnet native USDC transfer', async () => {
  const res = await simulateTrade({
    chain: 'eip155:8453',
    calls: [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001' }]
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.allowed, true);
});

test('simulateTrade labels itself as preflight validation (no fork sim)', async () => {
  const res = await simulateTrade('84532', [{ to: '0x123', value: '0x0' }]);
  assert.strictEqual(res.method, 'preflight-validation');
  assert.ok(res.checks.some((c) => c.includes('Preflight validation')));
  assert.ok(!res.checks.some((c) => c.includes('Mock execution')));
});

test('simulateTrade rejects uncanonical token on Base Mainnet', async () => {
  const res = await simulateTrade({
    chain: 'eip155:8453',
    calls: [{ to: '0xdeadbeef', data: '0xa9059cbb0000' }]
  });
  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes('Invalid token address'));
});

test('simulateTrade includes deterministic ERC-20 approval projection', async () => {
  const res = await simulateTrade({
    chain: 'eip155:8453',
    calls: [{
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      data: '0x095ea7b300000000000000000000000099999999999999999999999999999999999999990000000000000000000000000000000000000000000000000000000000000000',
    }],
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.projections?.[0].kind, 'erc20_approval');
  assert.strictEqual(res.projections?.[0].spender, '0x9999999999999999999999999999999999999999');
  assert.strictEqual(res.projections?.[0].allowanceAfter, '0');
});

test('simulateTrade includes deterministic ERC-20 transfer projection', async () => {
  const res = await simulateTrade({
    chain: 'eip155:8453',
    calls: [{
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      data: '0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000a',
    }],
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.projections?.[0].kind, 'erc20_transfer');
  assert.strictEqual(res.projections?.[0].recipient, '0x1111111111111111111111111111111111111111');
  assert.strictEqual(res.projections?.[0].amountRaw, '10');
  assert.strictEqual(res.projections?.[0].balanceDelta, '-10');
});
