import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_EXTRA_METADATA_SELECTOR_V1,
  crossCheckUnderlyingBindingV1,
  isValidIsinV1,
  readB20SecurityIdentifierV1,
  underlyingKeyForIsinV1,
  type B20BatchCallV1,
  type B20ReaderV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// The ISIN a B20 declares about itself.
//
// Measured on Base 2026-08-31, every one matching the reviewed key exactly:
// NVDAc US67066G1040, AAPLc US0378331005, TSLAc US88160R1014, MSFTc
// US5949181045 — the last two on addresses production measures and the reviewed
// corpus does not contain.
// ---------------------------------------------------------------------------

const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const fail = { ok: false as const, reason: 'transport' as const };

/** ABI-encodes a string return the way the precompile does. */
function stringReturn(value: string): { ok: true; value: string } {
  const bytes = Buffer.from(value, 'utf8');
  const body = bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64 || 64, '0');
  return {
    ok: true,
    value: `0x${(32).toString(16).padStart(64, '0')}${bytes.length.toString(16).padStart(64, '0')}${body}`,
  };
}

/** `byKey` is keyed on the metadata key the call encodes, so a test says what
 * the chain publishes rather than which order the reader asks in. */
function readerV1(byKey: Record<string, unknown>): B20ReaderV1 {
  const answer = (call: B20BatchCallV1) => {
    if (!call.data.startsWith(`0x${B20_EXTRA_METADATA_SELECTOR_V1}`)) return fail;
    const length = Number(BigInt(`0x${call.data.slice(10 + 64, 10 + 128)}`));
    const key = Buffer.from(call.data.slice(10 + 128, 10 + 128 + length * 2), 'hex').toString('utf8');
    return byKey[key] ?? stringReturn('');
  };
  return {
    readBlockAnchor: async () => ({ ok: true, value: { blockTag: '0x1', blockNumber: 1n } }),
    readIsB20: async () => ({ ok: true, value: true }),
    readIsB20Initialized: async () => ({ ok: true, value: true }),
    readVariantActivated: async () => ({ ok: true, value: true }),
    call: async (call: B20BatchCallV1) => answer(call),
    callMany: async (calls: readonly B20BatchCallV1[]) => calls.map((call) => answer(call)),
  } as never;
}

const read = (byKey: Record<string, unknown>) =>
  readB20SecurityIdentifierV1({ reader: readerV1(byKey), tokenAddress: TOKEN, blockTag: '0x1' });

describe('the ISIN a B20 declares about itself', () => {
  test('the key is lowercase, and the uppercase spelling answers with nothing', async () => {
    // The trap this module exists around: `extraMetadata("ISIN")` does not
    // revert, it returns an EMPTY STRING. A caller using the obvious spelling
    // gets a well-formed answer that means nothing, and cannot tell it apart
    // from a token that publishes no identifier at all.
    assert.deepEqual(await read({ isin: stringReturn('US67066G1040') }), {
      ok: true,
      isin: 'US67066G1040',
      key: 'isin',
    });
    assert.deepEqual(await read({ ISIN: stringReturn('') }), { ok: false, reason: 'not_published' });
  });

  test('a value that is not an ISIN is refused, never passed through', async () => {
    // This is issuer-writable metadata about to be used as the identity of a
    // security, so it is checked before it is allowed to mean anything.
    assert.deepEqual(await read({ isin: stringReturn('NOT-AN-ISIN') }), {
      ok: false,
      reason: 'malformed',
      value: 'NOT-AN-ISIN',
    });
    // Right shape, wrong check digit.
    assert.equal((await read({ isin: stringReturn('US67066G1041') })).ok, false);
  });

  test('two keys naming two securities is refused, not resolved', async () => {
    const result = await read({
      isin: stringReturn('US67066G1040'),
      ISIN: stringReturn('US0378331005'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'conflicting');
  });

  test('a failed read is never "publishes nothing"', async () => {
    assert.deepEqual(await read({ isin: fail, ISIN: fail }), { ok: false, reason: 'unavailable' });
  });

  test('the check digit is validated, not just the shape', () => {
    assert.equal(isValidIsinV1('US67066G1040'), true);
    assert.equal(isValidIsinV1('US0378331005'), true);
    assert.equal(isValidIsinV1('US88160R1014'), true);
    assert.equal(isValidIsinV1('US67066G1041'), false);
    assert.equal(isValidIsinV1('us67066g1040'), false);
    assert.equal(isValidIsinV1('US67066G104'), false);
  });

  test('agreement with the reviewed binding is a confirmation', () => {
    assert.deepEqual(
      crossCheckUnderlyingBindingV1({
        onchain: { ok: true, isin: 'US67066G1040', key: 'isin' },
        reviewedUnderlyingKey: 'security:isin:US67066G1040',
      }),
      { status: 'confirmed', underlyingKey: underlyingKeyForIsinV1('US67066G1040') },
    );
  });

  test('disagreement is a contradiction, and neither side wins quietly', () => {
    // Our reviewed mapping and the issuer's own statement naming different
    // securities for one address is not a gap to be filled later.
    const result = crossCheckUnderlyingBindingV1({
      onchain: { ok: true, isin: 'US0378331005', key: 'isin' },
      reviewedUnderlyingKey: 'security:isin:US67066G1040',
    });
    assert.equal(result.status, 'contradicted');
    assert.equal(
      result.status === 'contradicted' && result.onchainUnderlyingKey,
      'security:isin:US0378331005',
    );
    assert.equal(
      result.status === 'contradicted' && result.reviewedUnderlyingKey,
      'security:isin:US67066G1040',
    );
  });

  test('an unreviewed contract naming itself is evidence, not a confirmation', () => {
    // TSLAc and MSFTc, measured: both publish a valid ISIN and neither is in the
    // reviewed corpus. An issuer agreeing with itself proves nothing about our
    // binding, so the identifier is carried and the status is withheld.
    const result = crossCheckUnderlyingBindingV1({
      onchain: { ok: true, isin: 'US88160R1014', key: 'isin' },
      reviewedUnderlyingKey: null,
    });
    assert.equal(result.status, 'not_established');
    assert.match(result.status === 'not_established' ? result.reason : '', /US88160R1014/);
  });

  test('a read that did not complete leaves the binding exactly as it was', () => {
    const result = crossCheckUnderlyingBindingV1({
      onchain: { ok: false, reason: 'unavailable' },
      reviewedUnderlyingKey: 'security:isin:US67066G1040',
    });
    assert.equal(result.status, 'not_established');
    // Never worded as a contradiction: we did not look.
    assert.match(result.status === 'not_established' ? result.reason : '', /not read/);
  });
});
