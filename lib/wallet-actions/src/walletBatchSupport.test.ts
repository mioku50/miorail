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
  const submit = source.slice(source.indexOf('const submit = async () => {'));
  const refusal = submit.indexOf("atomicBatchSupportV1(walletCapabilities, base.id) === 'unsupported'");
  const approve = submit.indexOf('await approveMutateAsync(');
  assert.ok(refusal > 0, 'the hook reads the wallet’s batch support');
  assert.ok(approve > refusal, 'and does so before approving');
  assert.match(submit.slice(refusal, refusal + 200), /setError\(WALLET_CANNOT_BATCH_V1\);\s*return;/);
});
