import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_TOKEN_INDEX_STANDINGS_V1,
  b20IdentityWasEstablishedV1,
  b20TokenIndexStandingV1,
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
