import { test } from 'node:test';
import assert from 'node:assert';
import * as mod from './useWalletConfirmAction';

test('useWalletConfirmAction and CallsStatusPoller are exported correctly', () => {
  assert.equal(typeof mod.useWalletConfirmAction, 'function');
  assert.equal(typeof mod.CallsStatusPoller, 'function');
});

test('useWalletConfirmAction does not invoke useCallsStatus directly', () => {
  const hookSource = mod.useWalletConfirmAction.toString();
  assert.ok(!hookSource.includes('useCallsStatus('), 'useWalletConfirmAction must not call useCallsStatus directly; polling must be encapsulated in CallsStatusPoller');
  assert.ok(hookSource.includes('CallsStatusPoller'), 'useWalletConfirmAction must reference CallsStatusPoller');
});

test('CallsStatusPoller validates batchId length before enabling useCallsStatus', () => {
  const pollerSource = mod.CallsStatusPoller.toString();
  assert.ok(pollerSource.includes('trim()') && pollerSource.includes('length'), 'CallsStatusPoller must check batchId validity before enabling polling');
});

test('T19.8: Prepared call with value "0" creates a wallet_sendCalls request with no BigInt values and omits value', () => {
  const normalized = mod.normalizeCall({
    to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    data: '0x095ea7b3',
    value: '0',
  });
  assert.equal(normalized.to, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(normalized.data, '0x095ea7b3');
  assert.equal(normalized.value, undefined);
  assert.doesNotThrow(() => JSON.stringify(normalized));
});

test('T19.8: Prepared call with non-zero decimal value creates JSON-safe hex quantity string', () => {
  const normalized = mod.normalizeCall({
    to: '0x1234567890123456789012345678901234567890',
    value: '1000000000000000000', // 1 ETH in wei decimal
  });
  assert.equal(typeof normalized.value, 'string');
  assert.equal(normalized.value, '0xde0b6b3a7640000');
  assert.doesNotThrow(() => JSON.stringify(normalized));
});

test('T19.8: JSON.stringify(sendCallsPayload) must not throw and contain no BigInt values', () => {
  const calls = [
    mod.normalizeCall({ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x095ea7b3', value: '0' }),
    mod.normalizeCall({ to: '0x1111111111111111111111111111111111111111', value: BigInt(15) }),
  ];
  const sendCallsPayload = {
    calls,
    chainId: 8453,
    forceAtomic: true,
    capabilities: { dataSuffix: { value: '0x1234' as const, optional: true } },
  };
  let serialized = '';
  assert.doesNotThrow(() => {
    serialized = JSON.stringify(sendCallsPayload);
  });
  assert.ok(!serialized.includes('null'), 'value: undefined must be cleanly omitted or hex formatted');
  assert.ok(serialized.includes('"0xf"'));
});

test('T19.8: sanitizeBigInts recursively converts any bigint in status/receipts objects', () => {
  const rawReceipts = [{ transactionHash: '0xabc', blockNumber: BigInt(12345678), gasUsed: BigInt(21000) }];
  const sanitized = mod.sanitizeBigInts(rawReceipts);
  assert.doesNotThrow(() => JSON.stringify(sanitized));
  const parsed = JSON.parse(JSON.stringify(sanitized));
  assert.equal(parsed[0].blockNumber, '12345678');
  assert.equal(parsed[0].gasUsed, '21000');
});

