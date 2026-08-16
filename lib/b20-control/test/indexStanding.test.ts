import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_TOKEN_INDEX_STANDINGS_V1,
  b20IdentityWasEstablishedV1,
  b20TokenIndexStandingV1,
  detectB20IdentityV1,
  inspectB20TokenV1,
  type B20DetectionOutcomeV1,
} from '../src/index.js';

describe('b20TokenIndexStandingV1', () => {
  test('an indexed launch settles it without asking the chain', () => {
    // The factory value is deliberately the one that would otherwise produce
    // the worst answer: an index hit must not be overridable by a failed read.
    assert.equal(b20TokenIndexStandingV1({ indexed: true, detection: 'rpc_failure' }), 'indexed_b20');
    assert.equal(b20TokenIndexStandingV1({ indexed: true, detection: null }), 'indexed_b20');
    assert.equal(b20TokenIndexStandingV1({ indexed: true, detection: 'not_b20' }), 'indexed_b20');
  });

  test('confirmed by the factory but absent from the index is its own state', () => {
    // This is MIO. Reporting it as `not_b20` is the bug this type exists for.
    assert.equal(
      b20TokenIndexStandingV1({ indexed: false, detection: 'b20' }),
      'confirmed_b20_not_indexed',
    );
  });

  test('created-but-uninitialised is still confirmed, not denied', () => {
    // isB20 true, isB20Initialized false. The factory has confirmed the
    // identity; only the setup is unfinished.
    assert.equal(
      b20TokenIndexStandingV1({ indexed: false, detection: 'b20_uninitialised' }),
      'confirmed_b20_not_indexed',
    );
  });

  test('a factory that answered no is a real negative', () => {
    assert.equal(b20TokenIndexStandingV1({ indexed: false, detection: 'not_b20' }), 'not_b20');
  });

  test('every way of not getting an answer is uncertainty, never a verdict', () => {
    const silent: (B20DetectionOutcomeV1 | null)[] = [
      null,
      'rpc_failure',
      'unavailable_at_block',
      'invalid_address',
      'unsupported_chain',
    ];
    for (const detection of silent) {
      assert.equal(
        b20TokenIndexStandingV1({ indexed: false, detection }),
        'identity_check_unavailable',
        `${String(detection)} must not decide anything about the token`,
      );
    }
  });

  test('no input produces not_b20 unless the factory actually said so', () => {
    // The guarantee stated as a property rather than case by case: `not_b20`
    // has exactly one source.
    const outcomes: (B20DetectionOutcomeV1 | null)[] = [
      null, 'b20', 'not_b20', 'b20_uninitialised', 'unavailable_at_block',
      'rpc_failure', 'invalid_address', 'unsupported_chain',
    ];
    for (const indexed of [true, false]) {
      for (const detection of outcomes) {
        const standing = b20TokenIndexStandingV1({ indexed, detection });
        if (standing === 'not_b20') {
          assert.equal(detection, 'not_b20');
          assert.equal(indexed, false);
        }
      }
    }
  });

  test('the standing is always one of the four declared members', () => {
    const outcomes: (B20DetectionOutcomeV1 | null)[] = [
      null, 'b20', 'not_b20', 'b20_uninitialised', 'unavailable_at_block',
      'rpc_failure', 'invalid_address', 'unsupported_chain',
    ];
    for (const indexed of [true, false]) {
      for (const detection of outcomes) {
        assert.ok(
          B20_TOKEN_INDEX_STANDINGS_V1.includes(b20TokenIndexStandingV1({ indexed, detection })),
        );
      }
    }
  });
});

describe('b20IdentityWasEstablishedV1', () => {
  test('only the unavailable state counts as unestablished', () => {
    assert.equal(b20IdentityWasEstablishedV1('indexed_b20'), true);
    assert.equal(b20IdentityWasEstablishedV1('confirmed_b20_not_indexed'), true);
    assert.equal(b20IdentityWasEstablishedV1('not_b20'), true);
    assert.equal(b20IdentityWasEstablishedV1('identity_check_unavailable'), false);
  });
});

// ---------------------------------------------------------------------------
// The console fallback reads identity with `detectB20IdentityV1`, not with the
// full `inspectB20TokenV1`. That is a performance decision — three reads rather
// than a whole control card — and it is only safe while the two agree about
// what a token IS. These pin them together on the same reader responses.
// ---------------------------------------------------------------------------
describe('detectB20IdentityV1 agrees with the full inspection', () => {
  const ADDRESS = '0xb200000000000000000000578f3ae29d9e6e0101';
  const ANCHOR = {
    ok: true as const,
    value: { blockNumber: '50044247', blockHash: `0x${'a'.repeat(64)}`, blockTag: '0x2fb9f14' },
    raw: `0x${'a'.repeat(64)}`,
  };
  const readerV1 = (over: Record<string, unknown>) =>
    ({
      readBlockAnchor: async () => ANCHOR,
      readIsB20: async () => ({ ok: true as const, value: true }),
      readIsB20Initialized: async () => ({ ok: true as const, value: true }),
      readVariantActivated: async () => ({ ok: true as const, value: true }),
      call: async () => ({ ok: false as const, reason: 'transport' as const }),
      callMany: async () => [{ ok: false as const, reason: 'transport' as const }],
      ...over,
    }) as never;

  const cases: readonly [string, Record<string, unknown>, string][] = [
    ['confirmed and initialised', {}, 'b20'],
    [
      'confirmed but not initialised',
      { readIsB20Initialized: async () => ({ ok: true as const, value: false }) },
      'b20_uninitialised',
    ],
    ['factory says no', { readIsB20: async () => ({ ok: true as const, value: false }) }, 'not_b20'],
    [
      'factory returned nothing at this block',
      { readIsB20: async () => ({ ok: false as const, reason: 'empty_result' as const }) },
      'unavailable_at_block',
    ],
    [
      'endpoint failed on the identity call',
      { readIsB20: async () => ({ ok: false as const, reason: 'transport' as const }) },
      'rpc_failure',
    ],
    [
      'endpoint failed before any read',
      { readBlockAnchor: async () => ({ ok: false as const, reason: 'transport' as const }) },
      'rpc_failure',
    ],
  ];

  for (const [name, over, expected] of cases) {
    test(`${name} → ${expected}, both ways`, async () => {
      const reader = readerV1(over);
      const light = await detectB20IdentityV1({ reader }, { chainId: 8453, tokenAddress: ADDRESS });
      assert.equal(light, expected);

      const full = await inspectB20TokenV1(
        { reader },
        { tenantId: 'test', chainId: 8453, tokenAddress: ADDRESS, now: new Date('2026-08-16T00:00:00.000Z') },
      );
      assert.equal(
        full.snapshot.detection.outcome,
        light,
        'the cheap identity read and the full inspection must not disagree about what a token is',
      );
    });
  }

  test('an unsupported chain is reported, not thrown', async () => {
    const outcome = await detectB20IdentityV1({ reader: readerV1({}) }, { chainId: 1, tokenAddress: ADDRESS });
    assert.equal(outcome, 'unsupported_chain');
  });

  test('a malformed address is reported, not thrown', async () => {
    const outcome = await detectB20IdentityV1({ reader: readerV1({}) }, { chainId: 8453, tokenAddress: '0xnope' });
    assert.equal(outcome, 'invalid_address');
  });
});
