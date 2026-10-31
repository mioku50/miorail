import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { SPONSORED_GAS_LABELS_V1, paymasterServiceSupportV1, sponsoredGasPlanV1 } from './sponsoredGas';

const here = path.dirname(url.fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The fee sponsor, from the wallet's side: sent only when offered, always
// optional, never claimed for a wallet that did not say it can take one, and
// dropped for the retry once a send with it has failed.
// ---------------------------------------------------------------------------

const OFFER = { paymasterUrl: 'https://miorail.xyz/api/paymaster', context: { sponsorship: 'signed-token' } };
const SUPPORTED = { 8453: { paymasterService: { supported: true } } };
const UNSUPPORTED = { 8453: { paymasterService: { supported: false } } };

test('support is read under the decimal or the hex chain id', () => {
  assert.equal(paymasterServiceSupportV1(SUPPORTED), true);
  assert.equal(paymasterServiceSupportV1({ '0x2105': { paymasterService: { supported: true } } }), true);
  assert.equal(paymasterServiceSupportV1(UNSUPPORTED), false);
  // Not said is not "no".
  assert.equal(paymasterServiceSupportV1({ 8453: {} }), null);
  assert.equal(paymasterServiceSupportV1(undefined), null);
  // Another chain's answer is not this chain's.
  assert.equal(paymasterServiceSupportV1({ 1: { paymasterService: { supported: true } } }), null);
});

test('no offer, no capability — the batch goes exactly as before', () => {
  assert.deepEqual(sponsoredGasPlanV1({ offer: null, capabilities: SUPPORTED, declinedBefore: false }), {
    capability: null,
    state: 'not_offered',
  });
  assert.equal(SPONSORED_GAS_LABELS_V1.not_offered, null, 'nothing is said about a fee nobody offered to pay');
});

test('an offer to a wallet that takes a sponsor is sent, optional, to Miorail’s URL', () => {
  const plan = sponsoredGasPlanV1({ offer: OFFER, capabilities: SUPPORTED, declinedBefore: false });
  assert.equal(plan.state, 'sponsored');
  // Reported support is not a payment: the wallet decides, and its fee line says.
  assert.doesNotMatch(SPONSORED_GAS_LABELS_V1.sponsored!, /^Miorail pays/);
  assert.match(SPONSORED_GAS_LABELS_V1.sponsored!, /Your wallet shows who pays/);
  assert.deepEqual(plan.capability, {
    paymasterService: { url: 'https://miorail.xyz/api/paymaster', context: { sponsorship: 'signed-token' }, optional: true },
  });
});

test('a wallet that did not say is still offered, and not promised anything', () => {
  const plan = sponsoredGasPlanV1({ offer: OFFER, capabilities: undefined, declinedBefore: false });
  assert.equal(plan.state, 'offered');
  assert.ok(plan.capability);
  assert.doesNotMatch(SPONSORED_GAS_LABELS_V1.offered!, /^Miorail pays/);
});

test('a wallet that cannot take a sponsor is told it pays, and is not sent one', () => {
  const plan = sponsoredGasPlanV1({ offer: OFFER, capabilities: UNSUPPORTED, declinedBefore: false });
  assert.deepEqual(plan, { capability: null, state: 'unsupported_by_wallet' });
});

test('after a failed send with the sponsor, the retry goes without it and says who pays', () => {
  const plan = sponsoredGasPlanV1({ offer: OFFER, capabilities: SUPPORTED, declinedBefore: true });
  assert.deepEqual(plan, { capability: null, state: 'paid_after_decline' });
  assert.match(SPONSORED_GAS_LABELS_V1.declined!, /Press again/);
  // The wallet opens on the retry itself: "Press again" there names the press
  // that was just made.
  assert.doesNotMatch(SPONSORED_GAS_LABELS_V1.paid_after_decline!, /Press again/);
  assert.match(SPONSORED_GAS_LABELS_V1.paid_after_decline!, /^You pay the network fee/);
});

test('the submit hook sends the sponsor beside the Builder Code and drops it after a failure', () => {
  // Structural: the hook drives wagmi, which these tests do not mount.
  const source = readFileSync(path.join(here, 'useSubmitApprovedBlueprint.ts'), 'utf8');
  // Both capabilities in one object — the sponsor must never replace the
  // attribution, which is lost silently when missing.
  assert.match(source, /\.\.\.\(suffix \? \{ dataSuffix: \{ value: suffix, optional: true \} \} : \{\}\),\s*\.\.\.\(gas\.capability \?\? \{\}\),/);
  // Declined only on a failure that was not the person saying no, and not the
  // wallet saying it cannot send a batch at all: Rabby's -32601 read as "the
  // sponsor failed, press again" on 2026-10-31.
  const marker = 'const message = walletSubmissionFailureMessageV1(cause, walletName);';
  const failure = source.slice(source.indexOf(marker));
  assert.ok(source.includes(marker));
  assert.match(
    failure.slice(0, 700),
    /if \(walletCannotSendSentenceV1\(cause\) !== null\) \{(?:\s*\/\/[^\n]*\n)*\s*setSponsoredGas\(null\);\s*\} else if \(gas\.capability\) \{\s*\/\/[^\n]*\n\s*sponsorDeclinedRef\.current = true;/,
  );
  const rejection = source.slice(source.indexOf('if (isWalletRejectionError(cause)) {'), source.indexOf(marker));
  assert.doesNotMatch(rejection, /sponsorDeclinedRef/, 'saying no in the wallet is not the sponsor failing');
});
