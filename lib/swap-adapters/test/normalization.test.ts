import assert from 'node:assert/strict';
import test from 'node:test';
import {
  atomicToHumanDecimal,
  basisPointsToPercentage,
  humanDecimalToAtomic,
  minimumOutputAtomic,
  percentageToBasisPoints,
  providerFailure,
  providerPolicyRefusalCodeV1,
  PROVIDER_POLICY_REFUSAL_REASONS_V1,
  PROVIDER_POLICY_REFUSED_CODE_V1,
} from '../src/index.js';

test('human decimals convert to atomic amounts without floating point arithmetic', () => {
  assert.equal(humanDecimalToAtomic('100.25', 6), '100250000');
  assert.equal(humanDecimalToAtomic('0.000000000000000001', 18), '1');
  assert.equal(humanDecimalToAtomic('1.0000001', 6), null);
});

test('atomic amounts convert to canonical human decimals', () => {
  assert.equal(atomicToHumanDecimal('100250000', 6), '100.25');
  assert.equal(atomicToHumanDecimal('1', 18), '0.000000000000000001');
});

test('percentage and basis point conversions are deterministic', () => {
  assert.equal(percentageToBasisPoints('0.5'), 50);
  assert.equal(percentageToBasisPoints('1.25'), 125);
  assert.equal(basisPointsToPercentage(50), '0.5');
});

test('minimum output uses integer arithmetic and rounds down', () => {
  assert.equal(minimumOutputAtomic('101', 50), '100');
  assert.equal(minimumOutputAtomic('1000000', 50), '995000');
});

test('splitting a refusal code does not move its outcome', () => {
  // The codes were split so an intermittent Uniswap refusal is diagnosable in
  // the log. The OUTCOME decides retryability and how the engine counts the
  // candidate, so it must not drift with the label: every "we could not accept
  // this answer" code stays `invalid_response`, not the `unavailable` default.
  for (const code of [
    'provider_invalid_schema',
    'provider_output_not_positive',
    'provider_gas_units_missing',
    'provider_minimum_above_output',
    'provider_price_impact_invalid',
    'provider_slippage_echo_mismatch',
  ]) {
    const failure = providerFailure('uniswap', code);
    assert.equal(failure.outcome, 'invalid_response', code);
    assert.equal(failure.retryable, false, code);
    assert.equal(failure.errorCode, code);
  }
});

// ---------------------------------------------------------------------------
// A venue that CAN route this and will not.
//
// 0x answers BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE / SELL_TOKEN_NOT_... at HTTP
// 200 for the Coinbase tokenized equities: a complete answer carrying a
// verdict, not a route finding. Each of the three obvious places to file it
// names the wrong party, so it gets its own outcome.
// ---------------------------------------------------------------------------

test('a policy refusal is its own outcome, not one of its three neighbours', () => {
  const failure = providerFailure('kyberswap', PROVIDER_POLICY_REFUSED_CODE_V1);
  assert.equal(failure.outcome, 'policy_refused');
  // The three it must never collapse into: `unavailable` is the market having
  // no route, `unsupported` is our coverage falling short, and a transport
  // outcome would put a clean 200 on Miorail's account.
  assert.notEqual(failure.outcome, 'unavailable');
  assert.notEqual(failure.outcome, 'unsupported');
  assert.notEqual(failure.outcome, 'invalid_response');
  // Asking again reaches the same rule.
  assert.equal(failure.retryable, false);
  assert.equal(failure.errorCode, PROVIDER_POLICY_REFUSED_CODE_V1);
});

test('both 0x refusal reasons map to the refusal code, and nothing else does', () => {
  for (const reason of PROVIDER_POLICY_REFUSAL_REASONS_V1) {
    assert.equal(providerPolicyRefusalCodeV1(reason), PROVIDER_POLICY_REFUSED_CODE_V1);
    assert.equal(providerPolicyRefusalCodeV1(reason.toLowerCase()), PROVIDER_POLICY_REFUSED_CODE_V1);
    assert.equal(providerPolicyRefusalCodeV1(` ${reason} `), PROVIDER_POLICY_REFUSED_CODE_V1);
  }
  assert.deepEqual(
    [...PROVIDER_POLICY_REFUSAL_REASONS_V1],
    ['BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE', 'SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE'],
  );
  // Typed codes only. A provider message that merely CONTAINS the phrase is
  // prose, and this taxonomy is not built by parsing text.
  assert.equal(providerPolicyRefusalCodeV1('SWAP_VALIDATION_FAILED'), null);
  assert.equal(providerPolicyRefusalCodeV1('reason: BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE'), null);
  assert.equal(providerPolicyRefusalCodeV1(''), null);
  assert.equal(providerPolicyRefusalCodeV1(null), null);
  assert.equal(providerPolicyRefusalCodeV1(42), null);
});

test('no other code acquires the new outcome', () => {
  // The fallback must not widen. Only the pinned refusal code produces
  // `policy_refused`; every neighbouring code keeps exactly the outcome it had
  // before this state existed.
  assert.equal(providerFailure('kyberswap', 'provider_no_route').outcome, 'unavailable');
  assert.equal(providerFailure('kyberswap', 'provider_unsupported_intent').outcome, 'unsupported');
  assert.equal(providerFailure('kyberswap', 'provider_venue_not_covered').outcome, 'unsupported');
  for (const code of [
    'provider_no_route',
    'provider_unsupported_token',
    'provider_unsupported_intent',
    'provider_venue_not_covered',
    'provider_timeout',
    'provider_http_error',
  ]) {
    assert.notEqual(providerFailure('kyberswap', code).outcome, 'policy_refused', code);
  }
});
