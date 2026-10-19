import assert from 'node:assert/strict';
import test from 'node:test';
import { validateNativeSendCallsV1 } from './nativeSendGuard.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const send = (over: { to?: string; value?: string; data?: string } = {}) => ({
  to: over.to ?? OTHER, value: over.value ?? '100000000000000', data: over.data ?? '0x',
});

test('one plain transfer of positive wei to another address passes', () => {
  assert.doesNotThrow(() => validateNativeSendCallsV1(WALLET, [send()]));
});

test('anything beyond a plain transfer is refused', () => {
  assert.throws(() => validateNativeSendCallsV1(WALLET, []), /native_send_invalid/);
  assert.throws(() => validateNativeSendCallsV1(WALLET, [send(), send()]), /native_send_invalid/);
  assert.throws(() => validateNativeSendCallsV1('0x0000000000000000000000000000000000000000', [send()]), /native_send_invalid/);
  assert.throws(() => validateNativeSendCallsV1(WALLET, [send({ to: WALLET })]), /recipient_invalid/);
  const mixed = '0xAbCdEf0000000000000000000000000000000001';
  assert.throws(() => validateNativeSendCallsV1(mixed, [send({ to: mixed.toLowerCase() })]), /recipient_invalid/);
  assert.throws(() => validateNativeSendCallsV1(WALLET, [send({ to: '0x0000000000000000000000000000000000000000' })]), /recipient_invalid/);
  assert.throws(() => validateNativeSendCallsV1(WALLET, [send({ to: 'alice.base.eth' })]), /recipient_invalid/);
  assert.throws(() => validateNativeSendCallsV1(WALLET, [send({ value: '0' })]), /value_invalid/);
  // A hex amount is the transport's encoding, never the intent's: read as a
  // decimal it would be a different number.
  assert.throws(() => validateNativeSendCallsV1(WALLET, [send({ value: '0x5af3107a4000' })]), /value_invalid/);
  assert.throws(() => validateNativeSendCallsV1(WALLET, [send({ value: '1.5' })]), /value_invalid/);
  assert.throws(() => validateNativeSendCallsV1(WALLET, [send({ data: '0xa9059cbb' })]), /calldata_refused/);
});
