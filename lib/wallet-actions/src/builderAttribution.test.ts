import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  builderAttributionOutcomeV1,
  builderCodeForSurfaceV1,
  builderCodeToDataSuffix,
  dataSuffixSupportV1,
} from './attribution';

// T67X-B5/B6 — what the client is allowed to CLAIM about attribution, and what
// attribution is not allowed to touch.

const here = dirname(fileURLToPath(import.meta.url));
const SUFFIX = builderCodeToDataSuffix('bc_a1b2c3d4')!;

describe('reading dataSuffix support out of wallet_getCapabilities', () => {
  test('both the decimal and hex chain keys are understood', () => {
    // wagmi keys by decimal, the raw RPC response by hex. Guessing which layer
    // the caller came through is how this silently returns null forever.
    assert.equal(dataSuffixSupportV1({ 8453: { dataSuffix: { supported: true } } }), true);
    assert.equal(dataSuffixSupportV1({ '0x2105': { dataSuffix: { supported: true } } }), true);
    assert.equal(dataSuffixSupportV1({ 8453: { dataSuffix: { supported: false } } }), false);
  });

  test('anything a wallet might actually return degrades to "did not say"', () => {
    assert.equal(dataSuffixSupportV1(undefined), null);
    assert.equal(dataSuffixSupportV1(null), null);
    assert.equal(dataSuffixSupportV1({}), null);
    assert.equal(dataSuffixSupportV1({ 8453: {} }), null);
    assert.equal(dataSuffixSupportV1({ 8453: { dataSuffix: {} } }), null);
    assert.equal(dataSuffixSupportV1({ 8453: { dataSuffix: { supported: 'yes' } } }), null);
    assert.equal(dataSuffixSupportV1({ 84532: { dataSuffix: { supported: true } } }), null, 'wrong chain');
  });
});

describe('classifying what happened to the attribution', () => {
  test('a confirmed-supporting wallet plus a suffix is the only route to "included"', () => {
    const outcome = builderAttributionOutcomeV1({
      suffix: SUFFIX,
      capabilities: { 8453: { dataSuffix: { supported: true } } },
    });
    assert.equal(outcome.status, 'included');
    assert.equal(outcome.builderCodePresent, true);
    assert.equal(outcome.dataSuffixRequested, true);
    assert.equal(outcome.dataSuffixSupported, true);
  });

  test('a wallet that says no is unsupported_by_wallet, not a failure', () => {
    // The batch went out. `optional: true` means the transaction the user asked
    // for still happened; only the attribution did not.
    const outcome = builderAttributionOutcomeV1({
      suffix: SUFFIX,
      capabilities: { 8453: { dataSuffix: { supported: false } } },
    });
    assert.equal(outcome.status, 'unsupported_by_wallet');
    assert.equal(outcome.dataSuffixRequested, true);
  });

  test('a silent wallet is NOT "included", however likely it is', () => {
    // Passing the capability is not evidence the wallet honoured it. This is
    // the assertion the whole classifier exists for.
    const outcome = builderAttributionOutcomeV1({ suffix: SUFFIX, capabilities: undefined });
    assert.equal(outcome.status, 'unavailable');
    assert.equal(outcome.dataSuffixRequested, true);
    assert.equal(outcome.dataSuffixSupported, null);
  });

  test('no code means nothing was requested', () => {
    const outcome = builderAttributionOutcomeV1({
      suffix: undefined,
      capabilities: { 8453: { dataSuffix: { supported: true } } },
    });
    assert.equal(outcome.status, 'unavailable');
    assert.equal(outcome.builderCodePresent, false);
    assert.equal(outcome.dataSuffixRequested, false);
  });

  test('a conflicted env attributes nothing, so nothing is claimed', () => {
    const code = builderCodeForSurfaceV1({
      VITE_BASE_BUILDER_CODE: 'bc_one',
      VITE_BUILDER_CODE: 'bc_two',
    });
    assert.equal(code, undefined);
    const outcome = builderAttributionOutcomeV1({
      suffix: builderCodeToDataSuffix(code),
      capabilities: { 8453: { dataSuffix: { supported: true } } },
    });
    assert.equal(outcome.status, 'unavailable');
  });
});

describe('T67X-B6: attribution touches nothing financial', () => {
  const source = readFileSync(resolve(here, 'useSubmitApprovedBlueprint.ts'), 'utf8');

  test('the suffix is a capability, never part of a call', () => {
    // If the suffix were spliced into call data, it would change the calls the
    // server approved and the hash bound to them. It is passed beside the
    // batch, and the wallet appends it to the outer UserOperation callData.
    assert.match(source, /capabilities: suffix \? \{ dataSuffix: \{ value: suffix, optional: true \} \} : undefined/);
    assert.equal(/payload\.calls[\s\S]{0,200}suffix/.test(source), false, 'the suffix must never be mixed into calls');
  });

  test('nothing about the builder code reaches the submission record', () => {
    // The record carries the approved calls hash, the batch and the receipts.
    // An attribution field in it would make a public identifier part of the
    // financial record, and any change to it a change to a Proof.
    const records = source.match(/recordSafely\(\{[\s\S]*?\}\)/g) ?? [];
    assert.ok(records.length > 0, 'the record call sites must be findable');
    for (const record of records) {
      for (const banned of ['builderCode', 'builderAttribution', 'dataSuffix', 'suffix']) {
        assert.equal(record.includes(banned), false, `${banned} must not travel in a submission record`);
      }
    }
  });

  test('the suffix is computed after approval, so it cannot influence it', () => {
    // Ordering is the guarantee: the server has already re-validated and
    // approved the blueprint by the time a builder code is looked at.
    assert.ok(
      source.indexOf('approveMutateAsync') < source.indexOf('builderCodeToDataSuffix(builderCode)'),
      'approval must complete before attribution is considered',
    );
  });

  test('atomicRequired stays a top-level field, not an invented capability', () => {
    // `atomic` is what wallet_getCapabilities REPORTS. Sending it back as a
    // request capability would be a field no wallet has a contract to honour.
    assert.match(source, /forceAtomic: true/);
    assert.equal(/capabilities:[\s\S]{0,120}atomic:/.test(source), false);
  });
});
