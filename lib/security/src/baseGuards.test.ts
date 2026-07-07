import test from 'node:test';
import assert from 'node:assert';
import {
  canonicalUsdcForBaseChain,
  normalizeBaseChain,
  validateBaseCalls,
} from './baseGuards.js';

test('normalizeBaseChain accepts only Base mainnet and Base Sepolia ids', () => {
  assert.strictEqual(normalizeBaseChain('8453').sendCallsTool, 'send_calls');
  assert.strictEqual(normalizeBaseChain('eip155:8453').mcpChain, 'base');
  assert.strictEqual(normalizeBaseChain('84532').sendCallsTool, 'sepolia_send_calls');
  assert.strictEqual(normalizeBaseChain('eip155:84532').mcpChain, 'base-sepolia');
  assert.throws(() => normalizeBaseChain('1'), /Unsupported Base chain/);
  assert.throws(() => normalizeBaseChain('base'), /Unsupported Base chain/);
});

test('validateBaseCalls fails closed on wrong canonical USDC for chain', () => {
  const mainnetUsdc = canonicalUsdcForBaseChain('8453');
  const sepoliaUsdc = canonicalUsdcForBaseChain('84532');

  assert.throws(
    () => validateBaseCalls('8453', [{ to: sepoliaUsdc, data: '0xa9059cbb00' }]),
    /Only canonical USDC on Base Mainnet/,
  );
  assert.throws(
    () => validateBaseCalls('84532', [{ to: mainnetUsdc, data: '0x095ea7b300' }]),
    /Only canonical USDC on Base Sepolia/,
  );
});

test('validateBaseCalls fails closed on unknown calldata', () => {
  assert.throws(
    () => validateBaseCalls('8453', [{ to: '0x123', data: '0xabcdef' }]),
    /Unsupported calldata/,
  );
  assert.doesNotThrow(() => validateBaseCalls('8453', [{ to: '0x123', data: '0x' }]));
  assert.doesNotThrow(() => validateBaseCalls('8453', [{ to: '0x123' }]));
});

test('validateBaseCalls returns tool selection from normalized chainId', () => {
  const mainnet = validateBaseCalls('eip155:8453', [{ to: '0x123' }]);
  const sepolia = validateBaseCalls('eip155:84532', [{ to: '0x123' }]);

  assert.strictEqual(mainnet.sendCallsTool, 'send_calls');
  assert.strictEqual(mainnet.hexChainId, '0x2105');
  assert.strictEqual(sepolia.sendCallsTool, 'sepolia_send_calls');
  assert.strictEqual(sepolia.hexChainId, '0x14a34');
});
