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
  walletBatchBlockerV1,
  walletCannotSendSentenceV1,
  walletDidNotSendV1,
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
  assert.match(source, /blocker: walletBlocker, walletName \} = useWalletBatchSupportV1\(\);/);
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
