import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_REVERIFY_OUTCOMES_V1,
  B20_REVERIFY_REFUTING_REFUSALS_V1,
  b20ReverifyDecisionV1,
} from '../src/reverify.js';

// ---------------------------------------------------------------------------
// One distinction carries this whole file.
//
//   the file is served and no longer names this token  → the claim is REFUTED
//   Miorail could not fetch the file                   → the claim is UNTOUCHED
//
// Getting it wrong in the second direction is the expensive one: it takes a
// verified badge away on the strength of a network error, and the project has
// no idea why.
// ---------------------------------------------------------------------------

const claim = (status: 'verified' | 'refuted') => ({
  chainId: 8453 as const,
  tokenAddress: '0xb200000000000000000000578f3ae29d9e6e0101',
  claimantDomain: 'miorail.xyz',
  status,
  verifiedLinks: status === 'verified' ? (['domain_file'] as const) : ([] as const),
  refutedLinks: status === 'refuted' ? (['domain_file'] as const) : ([] as const),
  lastCheckedAt: '2026-08-18T10:00:00.000Z',
});

describe('a claim is taken back only on the project’s own answer', () => {
  test('a file that still names the token keeps the claim and refreshes it', () => {
    const decision = b20ReverifyDecisionV1({ claim: claim('verified') as never, refusal: null });
    assert.equal(decision.outcome, 'reverified');
    assert.equal(decision.status, 'verified');
    assert.equal(decision.writeEvidence, true);
  });

  test('a file that no longer names the token ends the claim', () => {
    const decision = b20ReverifyDecisionV1({ claim: null, refusal: 'token_not_named' });
    assert.equal(decision.outcome, 'refuted');
    assert.equal(decision.status, 'unverified');
    // The evidence goes with it: findings exist because a claim permitted them.
    assert.equal(decision.writeEvidence, true);
  });

  test('a contradicted link is a refutation', () => {
    const decision = b20ReverifyDecisionV1({ claim: claim('refuted') as never, refusal: 'claim_refuted' });
    assert.equal(decision.outcome, 'refuted');
    assert.equal(decision.status, 'refuted');
  });

  test('a served file that stopped being a claim file ends the claim too', () => {
    for (const refusal of ['not_json', 'invalid_schema']) {
      const decision = b20ReverifyDecisionV1({ claim: null, refusal });
      assert.equal(decision.outcome, 'refuted', refusal);
      assert.equal(decision.status, 'unverified', refusal);
    }
  });
});

describe('Miorail’s own failure never takes a claim away', () => {
  test('an unreachable file changes nothing at all', () => {
    const decision = b20ReverifyDecisionV1({ claim: null, refusal: 'unreachable' });
    assert.equal(decision.outcome, 'unreadable');
    // Not `unverified`, not `refuted`, and not an empty evidence write.
    assert.equal(decision.status, null);
    assert.equal(decision.writeEvidence, false);
    assert.match(decision.reason, /could not be read, so nothing was changed/);
  });

  test('`unreachable` is deliberately not a refuting refusal', () => {
    assert.ok(!B20_REVERIFY_REFUTING_REFUSALS_V1.includes('unreachable'));
  });

  test('an unknown shape is a failure, not a refutation', () => {
    // Fail closed: a refusal this build does not know must not cost a project
    // its claim.
    const decision = b20ReverifyDecisionV1({ claim: null, refusal: 'something_new' });
    assert.equal(decision.outcome, 'failed');
    assert.equal(decision.status, null);
    assert.equal(decision.writeEvidence, false);
  });

  test('no outcome outside the named four exists', () => {
    for (const input of [
      { claim: null, refusal: null },
      { claim: null, refusal: 'unreachable' },
      { claim: null, refusal: 'token_not_named' },
      { claim: claim('verified') as never, refusal: null },
      { claim: claim('refuted') as never, refusal: 'claim_refuted' },
    ]) {
      assert.ok(
        (B20_REVERIFY_OUTCOMES_V1 as readonly string[]).includes(b20ReverifyDecisionV1(input).outcome),
      );
    }
  });

  test('every decision that writes nothing also changes no status', () => {
    // The two must move together, or a pass could blank a record's evidence
    // while leaving it verified.
    for (const input of [
      { claim: null, refusal: 'unreachable' },
      { claim: null, refusal: 'something_new' },
      { claim: null, refusal: null },
    ]) {
      const decision = b20ReverifyDecisionV1(input);
      assert.equal(decision.writeEvidence, false);
      assert.equal(decision.status, null);
    }
  });
});
