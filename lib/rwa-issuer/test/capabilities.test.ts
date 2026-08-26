import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  CAPABILITY_VERDICTS_V1,
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
    // Dinari pays dividends in USD+ to registered accounts. Probing a selector
    // for that would return `absent`, which reads as "this issuer does not do
    // dividends" — false, and the opposite of what the issuer documents.
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
    for (const issuer of ['coinbase', 'dinari', 'backed'] as const) {
      const states = issuerCapabilitiesV1(issuer);
      assert.deepEqual(
        states.map((state) => state.capability),
        [...REPRESENTATION_CAPABILITIES_V1],
        'a missing row would read as a capability nobody thought about',
      );
    }
  });

  test("Dinari's pause is supported, because the deployment answers it", () => {
    // The correction that mattered. The published release ABI declares no
    // `paused()`; the deployed Base dShares return false for it. Reading only
    // the document would have called this unavailable forever.
    const pause = issuerCapabilitiesV1('dinari').find(
      (state) => state.capability === 'pause_state',
    );
    assert.equal(pause?.verdict, 'supported');
    assert.match(pause?.probe ?? '', /0x5c975abb/);
  });

  test("Dinari's bridge is never not_applicable", () => {
    // The other correction. The token is itself a LayerZero V2 OFT and returns
    // the canonical EndpointV2, so storing `not_applicable` would have been
    // false about a live transport.
    const bridge = issuerCapabilitiesV1('dinari').find((state) => state.capability === 'bridge');
    assert.notEqual(bridge?.verdict, 'not_applicable');
    assert.equal(bridge?.verdict, 'supported');
    // And it still does not claim to know the destinations.
    assert.match(bridge?.note ?? '', /peers\(uint32\) reverts/);
  });

  test('the active B20 ratio is callable while advance state remains off chain', () => {
    const actions = issuerCapabilitiesV1('coinbase').find(
      (state) => state.capability === 'corporate_actions',
    );
    assert.equal(actions?.verdict, 'supported');
    assert.match(actions?.note ?? '', /offchain registry/);
  });

  test('a distribution reaches every B20 holder and only a registered dShare holder', () => {
    // The sharpest difference between the two issuers, and the reason the exit
    // families are separate. A B20 dividend is a multiplier change visible to
    // anybody holding the token; a dShare dividend needs an account.
    const coinbase = issuerCapabilitiesV1('coinbase').find(
      (state) => state.capability === 'distributions',
    );
    const dinari = issuerCapabilitiesV1('dinari').find(
      (state) => state.capability === 'distributions',
    );
    assert.equal(coinbase?.verdict, 'supported');
    assert.equal(dinari?.verdict, 'documented_off_chain');
    assert.match(dinari?.note ?? '', /never registered does not receive them/);
  });

  test('holding a dShare is not the same permission as redeeming one', () => {
    const eligibility = issuerCapabilitiesV1('dinari').find(
      (state) => state.capability === 'eligibility',
    );
    assert.equal(eligibility?.verdict, 'documented_off_chain');
    assert.match(eligibility?.note ?? '', /blacklist/);
  });

  test('one issuer never inherits the other issuer’s ratio convention', () => {
    const coinbase = issuerCapabilitiesV1('coinbase').find((state) => state.capability === 'ratio');
    const dinari = issuerCapabilitiesV1('dinari').find((state) => state.capability === 'ratio');
    assert.match(coinbase?.probe ?? '', /multiplier\(\)/);
    assert.match(dinari?.probe ?? '', /balancePerShare\(\)/);
    assert.match(dinari?.note ?? '', /double-count/);
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
    assert.ok(ISSUER_EXIT_FAMILIES_V1.dinari.includes('issuer_redemption'));
  });
});
