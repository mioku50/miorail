import test from 'node:test';
import assert from 'node:assert';
import { deterministicSimulationIdempotencyKeyV1, useSimulationPayment } from '../src/useSimulationPayment.js';

// T59 decision 10 — wagmi is NOT mocked here; per spec convention for this
// task we test the hook via pure-function behavior (the deterministic key
// builder) plus source introspection (matching lib/wallet-actions's own
// WalletConfirmButton.test.ts pattern of asserting on `fn.toString()`)
// rather than rendering with a WagmiProvider.

test('deterministicSimulationIdempotencyKeyV1 is deterministic for the same (blueprintHash, wallet) pair', () => {
  const blueprintHash = `0x${'1'.repeat(64)}`;
  const wallet = '0x2222222222222222222222222222222222222222';
  const first = deterministicSimulationIdempotencyKeyV1(blueprintHash, wallet);
  const second = deterministicSimulationIdempotencyKeyV1(blueprintHash, wallet);
  assert.equal(first, second, 'a re-click or remount must produce the SAME idempotency key');
  assert.ok(first.length >= 8 && first.length <= 100, 'must satisfy the server schema bounds (8..100)');
});

test('deterministicSimulationIdempotencyKeyV1 differs across blueprints or wallets', () => {
  const wallet = '0x2222222222222222222222222222222222222222';
  const base = deterministicSimulationIdempotencyKeyV1(`0x${'1'.repeat(64)}`, wallet);
  const differentBlueprint = deterministicSimulationIdempotencyKeyV1(`0x${'3'.repeat(64)}`, wallet);
  const differentWallet = deterministicSimulationIdempotencyKeyV1(`0x${'1'.repeat(64)}`, '0x4444444444444444444444444444444444444444');
  assert.notEqual(base, differentBlueprint);
  assert.notEqual(base, differentWallet);
});

test('useSimulationPayment calls runX402PaidFetch exactly once per run() and never sends calldata', () => {
  const source = useSimulationPayment.toString();
  const matches = source.match(/runX402PaidFetch\(/g) ?? [];
  assert.equal(matches.length, 1, 'must call runX402PaidFetch exactly once');
  assert.ok(!/\bcalls\s*:/.test(source), 'the POST body must never include a calls/calldata field');
  assert.ok(source.includes('routeRunId'), 'request body must include routeRunId');
  assert.ok(source.includes('walletAddress'), 'request body must include walletAddress');
  assert.ok(source.includes('blueprintHash'), 'request body must include blueprintHash');
  assert.ok(source.includes('idempotencyKey'), 'request body must include idempotencyKey');
});

test('useSimulationPayment is guarded against concurrent re-clicks (ref-guard)', () => {
  const source = useSimulationPayment.toString();
  assert.ok(source.includes('inFlightRef'), 'must use a ref-guard against a second click while in-flight');
});

test('useSimulationPayment POSTs a JSON body through runX402PaidFetch init', () => {
  const source = useSimulationPayment.toString();
  assert.ok(/method:\s*['"]POST['"]/.test(source), 'must POST, not GET');
  assert.ok(source.includes('JSON.stringify(requestBody)'), 'must serialize the whitelisted request body');
});

test('useSimulationPayment validates the response against SimulateBlueprintResponseV1Schema', () => {
  const source = useSimulationPayment.toString();
  assert.ok(source.includes('SimulateBlueprintResponseV1Schema.safeParse'), 'must validate the server response against the shared api-spec schema');
});

test('useSimulationPayment switches chain instead of silently no-opping on the wrong chain', () => {
  const source = useSimulationPayment.toString();
  assert.ok(source.includes('switchChain'), 'must offer a chain switch when connected to the wrong chain');
});
