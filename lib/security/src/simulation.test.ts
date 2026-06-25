import test from 'node:test';
import assert from 'node:assert';
import { simulateTrade } from './simulation.js';

test('simulateTrade validates chain', async () => {
  const res = await simulateTrade('invalid-chain', [{ to: '0x123' }]);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.riskLevel, 'blocked');
  assert.ok(res.error?.includes('Unsupported chain'));
});

test('simulateTrade rejects empty calls', async () => {
  const res = await simulateTrade('84532', []);
  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes('No calls provided'));
});

test('simulateTrade rejects call missing to address', async () => {
  const res = await simulateTrade('84532', [{ to: '' }]);
  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes('Missing target address'));
});

test('simulateTrade rejects uncanonical USDC token', async () => {
  const res = await simulateTrade({
      chain: '84532',
      calls: [{ to: '0xdeadbeef', data: '0x095ea7b30000' }]
  });
  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes('Invalid token address'));
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
