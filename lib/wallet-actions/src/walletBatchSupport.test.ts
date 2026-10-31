import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WALLET_CANNOT_BATCH_V1,
  WALLET_HAS_NO_BATCHES_V1,
  WALLET_UPGRADE_DECLINED_V1,
  atomicBatchSupportV1,
  rememberWalletCannotBatchV1,
  walletBatchBlockerV1,
  walletBatchKeyV1,
  walletCannotSendSentenceV1,
  walletDidNotSendV1,
  walletKnownNotToBatchV1,
  walletRefusedBatchesV1,
  walletSubmissionFailureMessageV1,
} from './walletBatchSupport';

const here = path.dirname(fileURLToPath(import.meta.url));

test('what a wallet reports about one-transaction batches, in either key spelling', () => {
  // wagmi keys by decimal chain id; the raw RPC by hex.
  assert.equal(atomicBatchSupportV1({ 8453: { atomic: { status: 'supported' } } }), 'supported');
  assert.equal(atomicBatchSupportV1({ '0x2105': { atomic: { status: 'ready' } } }), 'ready');
  assert.equal(atomicBatchSupportV1({ 8453: { atomic: { status: 'unsupported' } } }), 'unsupported');
  // The draft spelling some wallets still answer with.
  assert.equal(atomicBatchSupportV1({ 8453: { atomicBatch: { supported: true } } }), 'supported');
  assert.equal(atomicBatchSupportV1({ 8453: { atomicBatch: { supported: false } } }), 'unsupported');
  // Saying nothing is not a refusal.
  assert.equal(atomicBatchSupportV1(undefined), null);
  assert.equal(atomicBatchSupportV1({}), null);
  assert.equal(atomicBatchSupportV1({ 1: { atomic: { status: 'unsupported' } } }), null);
  assert.equal(atomicBatchSupportV1({ 8453: { atomic: { status: 'maybe' } } }), null);
});

test('a refusal about what the wallet can do is said in words; anything else keeps its own', () => {
  // viem wraps the wallet's error; the code sits somewhere down the cause chain.
  const wrapped = (code: number) =>
    Object.assign(new Error('Request failed.'), { cause: Object.assign(new Error('rpc'), { cause: { code } }) });
  assert.equal(walletSubmissionFailureMessageV1(wrapped(5760)), WALLET_CANNOT_BATCH_V1);
  assert.equal(walletSubmissionFailureMessageV1(wrapped(5750)), WALLET_UPGRADE_DECLINED_V1);
  assert.equal(walletSubmissionFailureMessageV1(Object.assign(new Error('x'), { code: 4200 })), WALLET_HAS_NO_BATCHES_V1);
  assert.equal(walletSubmissionFailureMessageV1(Object.assign(new Error('x'), { code: -32601 })), WALLET_HAS_NO_BATCHES_V1);
  assert.equal(walletSubmissionFailureMessageV1(Object.assign(new Error('nonce too low'), { code: -32000 })), 'nonce too low');
  assert.equal(walletSubmissionFailureMessageV1('boom'), 'Wallet submission failed');
  for (const message of [WALLET_CANNOT_BATCH_V1, WALLET_HAS_NO_BATCHES_V1, WALLET_UPGRADE_DECLINED_V1]) {
    assert.match(message, /Nothing was (approved or )?sent/);
  }
});

test('the submit hook refuses a wallet that cannot batch BEFORE the server approves anything', () => {
  // Structural: the hook drives wagmi, which these tests do not mount.
  const source = readFileSync(path.join(here, 'useSubmitApprovedBlueprint.ts'), 'utf8');
  assert.match(source, /knownNotToBatch, blocker: walletBlocker, walletName \} = batchSupport;/);
  assert.match(source, /const batchSupport = useWalletBatchSupportV1\(\);/);
  const submit = source.slice(source.indexOf('const submit = async () => {'));
  const refusal = submit.indexOf('if (blocker) {');
  const approve = submit.indexOf('await approveMutateAsync(');
  assert.ok(refusal > 0, 'the hook reads the wallet’s batch support');
  assert.ok(approve > refusal, 'and does so before approving');
  assert.match(submit.slice(refusal, refusal + 120), /setError\(blocker\);\s*return;/);
  // A swap is not refused: it goes in steps (sequentialDelivery.ts).
  assert.match(source, /const blocker = deliveryPlan === 'sequential' \? null : walletBlocker;/);
});

// What Rabby answers, read from its source on 2026-10-31: eth-rpc-errors'
// methodNotFound for both wallet_getCapabilities and wallet_sendCalls.
const rabby = (method: string) =>
  Object.assign(new Error(`The method "${method}" does not exist / is not available.`), {
    code: -32601,
    cause: Object.assign(new Error(`method [${method}] doesn't has corresponding handler`), { code: -32601 }),
  });

test('a wallet with no batch methods is stopped before anything is approved, by its own name', () => {
  assert.equal(
    walletBatchBlockerV1({ capabilities: undefined, capabilitiesError: rabby('wallet_getCapabilities'), walletName: 'Rabby Wallet' }),
    WALLET_HAS_NO_BATCHES_V1.replace(/^This wallet/, 'Rabby Wallet'),
  );
  assert.equal(walletBatchBlockerV1({ capabilities: undefined, capabilitiesError: rabby('wallet_getCapabilities') }), WALLET_HAS_NO_BATCHES_V1);
  assert.equal(walletBatchBlockerV1({ capabilities: { 8453: { atomic: { status: 'unsupported' } } }, capabilitiesError: null }), WALLET_CANNOT_BATCH_V1);
  // Not answered yet, a timeout, or a wallet that can: it is asked.
  for (const capabilitiesError of [null, new Error('timeout'), Object.assign(new Error('Internal error'), { code: -32603 })]) {
    assert.equal(walletBatchBlockerV1({ capabilities: undefined, capabilitiesError }), null);
  }
  assert.equal(walletBatchBlockerV1({ capabilities: { 8453: { atomic: { status: 'ready' } } }, capabilitiesError: null }), null);
  // A name the wallet gives itself is a label, kept short or not used, and
  // wagmi's catch-all connector names no wallet at all.
  for (const walletName of ['x'.repeat(41), 'Injected', 'Browser Wallet']) {
    assert.equal(
      walletBatchBlockerV1({ capabilities: undefined, capabilitiesError: rabby('wallet_getCapabilities'), walletName }),
      WALLET_HAS_NO_BATCHES_V1,
    );
  }
});

test('only an answer that proves nothing was sent lets a review be offered again', () => {
  assert.equal(walletDidNotSendV1(rabby('wallet_sendCalls')), true);
  assert.equal(walletDidNotSendV1(Object.assign(new Error('declined'), { code: 4001 })), true);
  assert.equal(walletDidNotSendV1({ name: 'UserRejectedRequestError' }), true);
  for (const code of [5760, 5750, 5710, 4200]) assert.equal(walletDidNotSendV1({ cause: { code } }), true);
  // A lost response may have been sent.
  assert.equal(walletDidNotSendV1(new Error('wallet response lost')), false);
  assert.equal(walletDidNotSendV1(Object.assign(new Error('nonce too low'), { code: -32000 })), false);
  assert.equal(walletCannotSendSentenceV1(rabby('wallet_sendCalls'), 'Rabby Wallet')?.startsWith('Rabby Wallet cannot send'), true);
});

// Coinbase Wallet with an imported key, 2026-10-31, as viem wraps it: the
// only signal is the wallet's own words.
const coinbase = () =>
  Object.assign(new Error('An internal error was received.'), {
    code: -32603,
    details: 'atomic batch is not supported',
  });

test('a wallet that refuses a batch in words sent nothing, and the loan page says so instead of locking', () => {
  assert.equal(walletCannotSendSentenceV1(coinbase(), 'Coinbase Wallet'), WALLET_CANNOT_BATCH_V1.replace(/^This wallet/, 'Coinbase Wallet'));
  assert.equal(walletDidNotSendV1(coinbase()), true);
  // Words alone are not enough under any other code, and a required
  // capability (5700) is its own answer.
  assert.equal(walletDidNotSendV1(Object.assign(new Error('chain not supported'), { code: 4902 })), false);
  assert.equal(walletDidNotSendV1(Object.assign(new Error('This Wallet does not support a capability'), { code: 5700 })), false);
  assert.equal(walletDidNotSendV1(Object.assign(new Error('Internal error'), { code: -32603 })), false);
});

test('a wallet that refused a batch is not asked for one again in this tab; a declined switch is', () => {
  assert.equal(walletRefusedBatchesV1(rabby('wallet_sendCalls')), true);
  assert.equal(walletRefusedBatchesV1(coinbase()), true);
  assert.equal(walletRefusedBatchesV1({ cause: { code: 5760 } }), true);
  assert.equal(walletRefusedBatchesV1({ cause: { code: 5750 } }), false);
  assert.equal(walletRefusedBatchesV1(Object.assign(new Error('declined'), { code: 4001 })), false);
  assert.equal(walletBatchKeyV1('io.rabby', null), null);
  const key = walletBatchKeyV1('com.coinbase.wallet', `0x${'1'.repeat(40)}`.toUpperCase().replace('0X', '0x'));
  assert.equal(key, `com.coinbase.wallet:0x${'1'.repeat(40)}`);
  assert.equal(walletKnownNotToBatchV1(key), false);
  rememberWalletCannotBatchV1(key);
  assert.equal(walletKnownNotToBatchV1(key), true);
  // The capabilities said nothing, and the refusal did: the button says so first.
  assert.equal(
    walletBatchBlockerV1({ capabilities: { 8453: {} }, capabilitiesError: null, walletName: 'Coinbase Wallet', knownNotToBatch: true }),
    WALLET_CANNOT_BATCH_V1.replace(/^This wallet/, 'Coinbase Wallet'),
  );
});

test('the wallet is not asked again on focus: a refetch blanks an answer that is only an error', () => {
  const source = readFileSync(path.join(here, 'walletBatchSupport.ts'), 'utf8');
  for (const option of ['refetchOnWindowFocus: false', 'refetchOnReconnect: false', 'retryOnMount: false']) {
    assert.ok(source.includes(option), option);
  }
});
