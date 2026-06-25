import test from 'node:test';
import assert from 'node:assert';
import { PaymentPolicy, ApprovalGuard } from './payment-policy.js';
import type { X402PaymentRequired } from '@mioagent/x402-parser';

test('PaymentPolicy validates exact match', () => {
  const policy = new PaymentPolicy(['0xusdc'], ['8453']);
  const req: X402PaymentRequired = {
    accepts: [{ amount: '1000', payTo: '0xabc', asset: '0xUSDC', network: '8453' }]
  };

  const isValid = policy.isValidPayment(
    { amount: '1000', payTo: '0xabc', asset: '0xusdc', network: '8453', txHash: '0x123' },
    req
  );
  assert.strictEqual(isValid, true);
});

test('PaymentPolicy rejects invalid asset', () => {
  const policy = new PaymentPolicy(['0xusdc'], ['8453']);
  const req: X402PaymentRequired = {
    accepts: [{ amount: '1000', payTo: '0xabc', asset: '0xUSDC', network: '8453' }]
  };

  const isValid = policy.isValidPayment(
    { amount: '1000', payTo: '0xabc', asset: '0xeth', network: '8453', txHash: '0x123' },
    req
  );
  assert.strictEqual(isValid, false);
});

test('PaymentPolicy rejects invalid network', () => {
  const policy = new PaymentPolicy(['0xusdc'], ['8453']);
  const req: X402PaymentRequired = {
    accepts: [{ amount: '1000', payTo: '0xabc', asset: '0xUSDC', network: '8453' }]
  };

  const isValid = policy.isValidPayment(
    { amount: '1000', payTo: '0xabc', asset: '0xusdc', network: '1', txHash: '0x123' },
    req
  );
  assert.strictEqual(isValid, false);
});

test('PaymentPolicy rejects missing option match', () => {
  const policy = new PaymentPolicy(['0xusdc'], ['8453']);
  const req: X402PaymentRequired = {
    accepts: [{ amount: '1000', payTo: '0xabc', asset: '0xUSDC', network: '8453' }]
  };

  const isValid = policy.isValidPayment(
    { amount: '1000', payTo: '0xdef', asset: '0xusdc', network: '8453', txHash: '0x123' },
    req
  );
  assert.strictEqual(isValid, false);
});

test('PaymentPolicy rejects when amount parsing fails', () => {
  const policy = new PaymentPolicy(['0xusdc'], ['8453']);
  const req: X402PaymentRequired = {
    accepts: [{ amount: '1000', payTo: '0xabc', asset: '0xUSDC', network: '8453' }]
  };

  const isValid = policy.isValidPayment(
    { amount: 'invalid', payTo: '0xabc', asset: '0xusdc', network: '8453', txHash: '0x123' },
    req
  );
  assert.strictEqual(isValid, false);
});

test('PaymentPolicy rejects insufficient amount', () => {
  const policy = new PaymentPolicy(['0xusdc'], ['8453']);
  const req: X402PaymentRequired = {
    accepts: [{ amount: '1000', payTo: '0xabc', asset: '0xUSDC', network: '8453' }]
  };

  const isValid = policy.isValidPayment(
    { amount: '999', payTo: '0xabc', asset: '0xusdc', network: '8453', txHash: '0x123' },
    req
  );
  assert.strictEqual(isValid, false);
});

test('ApprovalGuard throws on no receipt', () => {
  const policy = new PaymentPolicy(['0xusdc'], ['8453']);
  const guard = new ApprovalGuard(policy);
  const req: X402PaymentRequired = { accepts: [] };

  assert.throws(() => guard.verifyOrThrow(null, req), /Payment required: No receipt provided/);
});

test('ApprovalGuard throws on invalid payment', () => {
  const policy = new PaymentPolicy(['0xusdc'], ['8453']);
  const guard = new ApprovalGuard(policy);
  const req: X402PaymentRequired = {
    accepts: [{ amount: '1000', payTo: '0xabc', asset: '0xUSDC', network: '8453' }]
  };

  assert.throws(() => guard.verifyOrThrow(
    { amount: '500', payTo: '0xabc', asset: '0xusdc', network: '8453', txHash: '0x123' },
    req
  ), /Payment required: Invalid or insufficient payment receipt/);
});

test('ApprovalGuard passes on valid payment', () => {
  const policy = new PaymentPolicy(['0xusdc'], ['8453']);
  const guard = new ApprovalGuard(policy);
  const req: X402PaymentRequired = {
    accepts: [{ amount: '1000', payTo: '0xabc', asset: '0xUSDC', network: '8453' }]
  };

  assert.doesNotThrow(() => guard.verifyOrThrow(
    { amount: '1000', payTo: '0xabc', asset: '0xusdc', network: '8453', txHash: '0x123' },
    req
  ));
});
