import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { EarnDepositFlow, formatEarnAmountForDisplayV1, earnProofStatusMessageV1, type EarnProofState } from './EarnDepositFlow';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'EarnDepositFlow.tsx'), 'utf8');

function state(overrides: Partial<EarnProofState>): EarnProofState {
  return { status: 'idle', proofId: null, recordedFinalStatus: null, txHashes: [], error: null, ...overrides };
}

test('exports the shared flow component and its pure display helpers', () => {
  assert.equal(typeof EarnDepositFlow, 'function');
  assert.equal(typeof formatEarnAmountForDisplayV1, 'function');
  assert.equal(typeof earnProofStatusMessageV1, 'function');
});

test('formatEarnAmountForDisplayV1 renders atomic amounts (USDC 6dp) for display only', () => {
  assert.equal(formatEarnAmountForDisplayV1('500000000', 6), '500');
  assert.equal(formatEarnAmountForDisplayV1('1500000', 6), '1.5');
  assert.equal(formatEarnAmountForDisplayV1('2450000000000', 18), '0.00000245');
  assert.equal(formatEarnAmountForDisplayV1('42', 0), '42');
  // Never throws on garbage — falls back to the raw string.
  assert.equal(formatEarnAmountForDisplayV1('not-a-number', 6), 'not-a-number');
});

test('reconciliation_required is surfaced honestly — a receipt is NEVER shown as a proven deposit', () => {
  const message = earnProofStatusMessageV1(state({ status: 'confirmed', recordedFinalStatus: 'reconciliation_required', proofId: 'route-proof:abc' }));
  assert.match(message, /needs reconciliation/i);
  assert.doesNotMatch(message, /proven onchain/i);
});

test('a proven deposit is only reported when the proof is completed', () => {
  assert.match(earnProofStatusMessageV1(state({ recordedFinalStatus: 'completed' })), /proven onchain/i);
  assert.match(earnProofStatusMessageV1(state({ recordedFinalStatus: 'failed' })), /failed onchain/i);
  assert.match(earnProofStatusMessageV1(state({ recordedFinalStatus: 'partial_failure' })), /needs reconciliation/i);
  // Before any record, it only reports the in-flight status — no proof claim.
  assert.match(earnProofStatusMessageV1(state({ status: 'submitting', recordedFinalStatus: null })), /Status: submitting/);
});

test('the flow drives select → prepare → review → earn submit → proof, and passes NO calldata', () => {
  // Prepare (server owns calldata) is triggered by the card review action.
  assert.ok(/usePrepareEarnDeposit/.test(source), 'the flow must prepare via the earn prepare hook');
  assert.ok(/onReviewDeposit/.test(source), 'the card review action must trigger prepare');
  // The wallet submission is the shared button pinned to the EARN goal.
  assert.ok(/<BlueprintSubmitButton\b/.test(source), 'the flow must use the shared BlueprintSubmitButton');
  assert.ok(/goal="earn"/.test(source), 'the submit button must be pinned to the earn goal');
  // The client passes only run/card/candidate hashes + ids — never calls/data.
  assert.ok(/selectedCandidateHash:\s*candidateHash/.test(source), 'prepare is keyed by the selected candidate hash');
  assert.ok(!/\bdata:\s*['"`]0x/.test(source), 'the client must never construct calldata');
  assert.ok(!/\bcalls:\s*\[/.test(source), 'the client must never assemble a calls array');
});

test('the review shows expiry, the exact approval, and the protocol contract', () => {
  assert.ok(/quoteExpiry/.test(source), 'the review must show the quote expiry');
  assert.ok(/requiredApprovals\[0\]/.test(source), 'the review must show the exact required approval');
  assert.ok(/approvalKind/.test(source), 'the review must label the approval as exact');
  assert.ok(/Protocol contract/.test(source), 'the review must show the pinned protocol contract');
});
