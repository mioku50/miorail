import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  CAPABILITY_VERDICTS_V1,
  ISSUER_CAPABILITY_PROFILES_V1,
  REPRESENTATION_CAPABILITIES_V1,
  capabilityVerdictV1,
  issuerCapabilitiesV1,
} from '../src/capabilities.js';
import {
  EXIT_FAMILY_MODELS_V1,
  ExitFamilyMismatchError,
  ISSUER_EXIT_FAMILIES_V1,
  assertSameExitFamilyV1,
} from '../src/exitFamilies.js';

describe('capability verdicts', () => {
  test('documented and callable are independent, and the verdict says which', () => {
    assert.equal(
      capabilityVerdictV1({ documented: 'documented', callable: 'callable' }),
      'supported',
    );
    assert.equal(
      capabilityVerdictV1({ documented: 'documented', callable: 'absent' }),
      'documented_not_callable',
    );
    assert.equal(
      capabilityVerdictV1({ documented: 'undocumented', callable: 'callable' }),
      'callable_not_documented',
    );
    assert.equal(
      capabilityVerdictV1({ documented: 'undocumented', callable: 'absent' }),
      'unknown',
    );
  });

  test('not applicable is a decision and outranks whatever the chain did', () => {
    // A reviewed "this cannot exist here" is not overturned by a selector that
    // happens to answer, and it is never softened into "unknown".
    for (const callable of ['callable', 'absent', 'off_chain', 'not_probed'] as const) {
      assert.equal(
        capabilityVerdictV1({ documented: 'not_applicable', callable }),
        'not_applicable',
      );
    }
  });

  test('not probed is never a finding', () => {
    // The distinction the user asked for: unknown is the absence of evidence,
    // not_applicable is a claim. A capability nobody called is the former even
    // when the issuer documents it.
    assert.equal(
      capabilityVerdictV1({ documented: 'documented', callable: 'not_probed' }),
      'unknown',
    );
    assert.equal(
      capabilityVerdictV1({ documented: 'undocumented', callable: 'not_probed' }),
      'unknown',
    );
  });

  test('a documented off-chain process is not an absent one', () => {
    // Coinbase's primary redemption runs through authorized participants.
    // Probing a selector for it would return `absent`, which reads as "this
    // issuer has no redemption" — false, and the opposite of what it documents.
    assert.equal(
      capabilityVerdictV1({ documented: 'documented', callable: 'off_chain' }),
      'documented_off_chain',
    );
    // But we do not assert an off-chain process nobody documented: there is
    // nothing on chain to point at and no source to quote.
    assert.equal(
      capabilityVerdictV1({ documented: 'undocumented', callable: 'off_chain' }),
      'unknown',
    );
  });

  test('every verdict it can return is a declared one', () => {
    for (const documented of ['documented', 'undocumented', 'not_applicable'] as const) {
      for (const callable of ['callable', 'absent', 'off_chain', 'not_probed'] as const) {
        assert.ok(CAPABILITY_VERDICTS_V1.includes(capabilityVerdictV1({ documented, callable })));
      }
    }
  });
});

describe('issuer profiles', () => {
  test('every issuer answers for every capability', () => {
    for (const issuer of ['coinbase'] as const) {
      const states = issuerCapabilitiesV1(issuer);
      assert.deepEqual(
        states.map((state) => state.capability),
        [...REPRESENTATION_CAPABILITIES_V1],
        'a missing row would read as a capability nobody thought about',
      );
    }
  });

  test('the active B20 ratio is callable while advance state remains off chain', () => {
    const actions = issuerCapabilitiesV1('coinbase').find(
      (state) => state.capability === 'corporate_actions',
    );
    assert.equal(actions?.verdict, 'supported');
    assert.match(actions?.note ?? '', /offchain registry/);
  });

  test('a distribution reaches every B20 holder as a multiplier change', () => {
    const coinbase = issuerCapabilitiesV1('coinbase').find(
      (state) => state.capability === 'distributions',
    );
    assert.equal(coinbase?.verdict, 'supported');
    assert.match(coinbase?.note ?? '', /no registration and no account/);
  });

  test('the B20 ratio is read, never assumed', () => {
    const coinbase = issuerCapabilitiesV1('coinbase').find((state) => state.capability === 'ratio');
    assert.match(coinbase?.probe ?? '', /multiplier\(\)/);
    assert.match(coinbase?.note ?? '', /the scale is read, never assumed/);
  });

  test('Coinbase is the only reviewed issuer', () => {
    // Backed and Dinari were removed on 2026-11-18, code and data.
    assert.deepEqual(Object.keys(ISSUER_CAPABILITY_PROFILES_V1), ['coinbase']);
  });
});

describe('exit families', () => {
  test('the two are never on one axis', () => {
    assert.throws(
      () => assertSameExitFamilyV1('secondary_market_cash', 'issuer_redemption'),
      ExitFamilyMismatchError,
    );
    assert.doesNotThrow(() =>
      assertSameExitFamilyV1('secondary_market_cash', 'secondary_market_cash'),
    );
  });

  test('a redemption is never a measured cost at a size', () => {
    const redemption = EXIT_FAMILY_MODELS_V1.issuer_redemption;
    assert.equal(redemption.evidence, 'documented_process');
    assert.equal(redemption.sizeDependent, false);
    assert.equal(redemption.observableByUs, false);
    assert.equal(redemption.eligibility, 'issuer_account_required');
  });

  test('a market sale is the only family this product can measure', () => {
    const market = EXIT_FAMILY_MODELS_V1.secondary_market_cash;
    assert.equal(market.evidence, 'measured_round_trip');
    assert.equal(market.observableByUs, true);
    assert.deepEqual(ISSUER_EXIT_FAMILIES_V1.coinbase, ['secondary_market_cash']);
  });
});
