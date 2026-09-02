import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_ALWAYS_ALLOW_POLICY_ID_V1,
  B20_POLICY_REGISTRY_V1,
  B20_TRANSFER_POLICY_SCOPES_V1,
  B20_USE_SELECTORS_V1,
  bridgeCapabilityFromReadsV1,
  decodeAddressWordV1,
  decodeBoolWordV1,
  decodeUint64WordV1,
  encodeIsAuthorizedCallV1,
  encodeIsPausedCallV1,
  encodeOftPeersCallV1,
  encodePolicyExistsCallV1,
  encodePolicyIdCallV1,
  transferPauseFromReadV1,
  transferPolicyBindingFromReadsV1,
  walletPolicyCheckFromReadsV1,
} from '../src/onchainUse.js';

const WORD_TRUE = `0x${'0'.repeat(63)}1`;
const WORD_FALSE = `0x${'0'.repeat(64)}`;
const WORD_FIVE = `0x${'0'.repeat(63)}5`;
const ok = (value: string) => ({ ok: true as const, value });
const failed = (reason: string) => ({ ok: false as const, reason });

describe('the selectors and constants Base Docs publishes', () => {
  test('the two published selectors match, which is the cross-check on the rest', () => {
    // Base Docs' Cobalt changelog prints these two by hand. They agree with the
    // keccak of their signatures, so the table computed the same way the chain
    // did — that is the only reason the unpublished ones can be trusted.
    assert.equal(B20_USE_SELECTORS_V1.isAuthorized, '55a1179e');
    assert.equal(B20_USE_SELECTORS_V1.policyExists, '330f5637');
  });

  test('the PolicyRegistry precompile and ALWAYS_ALLOW are pinned', () => {
    assert.equal(B20_POLICY_REGISTRY_V1, '0x8453000000000000000000000000000000000002');
    assert.equal(B20_ALWAYS_ALLOW_POLICY_ID_V1, 0n);
  });

  test('calls encode to the exact bytes a node is sent', () => {
    assert.equal(encodeIsPausedCallV1(), `0x${B20_USE_SELECTORS_V1.isPaused}${'0'.repeat(64)}`);
    assert.equal(
      encodePolicyIdCallV1('sender'),
      `0x${B20_USE_SELECTORS_V1.policyId}${B20_TRANSFER_POLICY_SCOPES_V1.sender.slice(2)}`,
    );
    assert.equal(encodePolicyExistsCallV1(5n), `0x${B20_USE_SELECTORS_V1.policyExists}${'0'.repeat(63)}5`);
    assert.equal(
      encodeIsAuthorizedCallV1(5n, '0xDEAD00000000000000000000000000000000BEEF'),
      `0x${B20_USE_SELECTORS_V1.isAuthorized}${'0'.repeat(63)}5${'0'.repeat(24)}dead00000000000000000000000000000000beef`,
    );
    assert.equal(encodeOftPeersCallV1(30184), `0x${'bb0b6a53'}${(30184).toString(16).padStart(64, '0')}`);
  });

  test('an argument that is not what it claims to be is refused, not coerced', () => {
    assert.throws(() => encodeIsPausedCallV1(300));
    assert.throws(() => encodeIsAuthorizedCallV1(5n, 'not-an-address'));
    assert.throws(() => encodeOftPeersCallV1(-1));
  });
});

describe('decoding refuses what it does not understand', () => {
  test('a boolean word is 0 or 1 and nothing else', () => {
    assert.equal(decodeBoolWordV1(WORD_FALSE), false);
    assert.equal(decodeBoolWordV1(WORD_TRUE), true);
    // Not a `false` with rubbish in it: a call that answered something this
    // decoder does not understand, which is a different fact entirely when the
    // question is whether transfers are frozen.
    assert.equal(decodeBoolWordV1(WORD_FIVE), null);
    assert.equal(decodeBoolWordV1('0x'), null);
    assert.equal(decodeBoolWordV1(`0x${'0'.repeat(62)}`), null);
  });

  test('a uint64 word larger than uint64 is not a policy id', () => {
    assert.equal(decodeUint64WordV1(WORD_FIVE), 5n);
    assert.equal(decodeUint64WordV1(`0x${'f'.repeat(64)}`), null);
  });

  test('an address word with dirty high bits is refused', () => {
    assert.equal(
      decodeAddressWordV1(`0x${'0'.repeat(24)}dead00000000000000000000000000000000beef`),
      '0xdead00000000000000000000000000000000beef',
    );
    assert.equal(decodeAddressWordV1(`0x1${'0'.repeat(63)}`), null);
  });
});

describe('transfers, paused or not', () => {
  test('a read that answered false means transfers are active', () => {
    assert.deepEqual(transferPauseFromReadV1(ok(WORD_FALSE)), {
      state: 'read',
      transfersPaused: false,
    });
  });

  test('a call that did not complete is unread, never "not paused"', () => {
    assert.deepEqual(transferPauseFromReadV1(failed('execution reverted')), {
      state: 'unread',
      reason: 'execution reverted',
    });
    assert.equal(transferPauseFromReadV1(ok('0x')).state, 'unread');
  });
});

describe('a policy binding needs three reads, in order', () => {
  test('ALWAYS_ALLOW is a positive finding: the scope restricts nobody', () => {
    assert.deepEqual(transferPolicyBindingFromReadsV1('sender', ok(WORD_FALSE), null), {
      scope: 'sender',
      state: 'unrestricted',
    });
  });

  test('a real policy id is bound, and its existence is a separate read', () => {
    assert.deepEqual(transferPolicyBindingFromReadsV1('sender', ok(WORD_FIVE), ok(WORD_TRUE)), {
      scope: 'sender',
      state: 'bound',
      policyId: '5',
      policyExists: true,
    });
    // Named but never checked: the caller skipped a read, and the answer says
    // so rather than assuming the policy is there.
    assert.equal(transferPolicyBindingFromReadsV1('sender', ok(WORD_FIVE), null).state, 'unread');
  });
});

describe('one wallet against one bound policy', () => {
  const bound = transferPolicyBindingFromReadsV1('sender', ok(WORD_FIVE), ok(WORD_TRUE));

  test('allowed and blocked are only claimed over a policy that exists', () => {
    assert.deepEqual(walletPolicyCheckFromReadsV1(bound, ok(WORD_TRUE)), {
      scope: 'sender',
      state: 'allowed',
      policyId: '5',
    });
    assert.deepEqual(walletPolicyCheckFromReadsV1(bound, ok(WORD_FALSE)), {
      scope: 'sender',
      state: 'blocked',
      policyId: '5',
    });
  });

  test('a missing policy is refused rather than resolved', () => {
    // Base Docs' own invariant: a non-existent BLOCKLIST authorizes everyone
    // and a non-existent ALLOWLIST denies everyone. `isAuthorized` over a
    // missing policy is a coin flip dressed as a fact, and this read cannot
    // tell which kind is missing.
    const missing = transferPolicyBindingFromReadsV1('sender', ok(WORD_FIVE), ok(WORD_FALSE));
    const check = walletPolicyCheckFromReadsV1(missing, ok(WORD_TRUE));
    assert.equal(check.state, 'not_confirmed');
    assert.match(
      check.state === 'not_confirmed' ? check.reason : '',
      /does not exist|answers differently by type/,
    );
  });

  test('an unrestricted scope needs no per-wallet call at all', () => {
    const unrestricted = transferPolicyBindingFromReadsV1('receiver', ok(WORD_FALSE), null);
    assert.deepEqual(walletPolicyCheckFromReadsV1(unrestricted, null), {
      scope: 'receiver',
      state: 'unrestricted',
    });
  });

  test('every failure lands on not_confirmed, and none of them on allowed', () => {
    for (const check of [
      walletPolicyCheckFromReadsV1(bound, failed('timeout')),
      walletPolicyCheckFromReadsV1(bound, ok('0x')),
      walletPolicyCheckFromReadsV1(bound, null),
      walletPolicyCheckFromReadsV1(
        transferPolicyBindingFromReadsV1('sender', failed('reverted'), null),
        ok(WORD_TRUE),
      ),
    ]) {
      assert.equal(check.state, 'not_confirmed');
    }
  });
});

describe('a bridge is a configured destination, not a selector', () => {
  const endpoint = ok(`0x${'0'.repeat(24)}1a44076050125825900e736c501f859c50fe728c`);

  test('an OFT-shaped contract with no peer set claims no destination', () => {
    const capability = bridgeCapabilityFromReadsV1({
      endpoint,
      peers: [{ endpointId: 30101, read: ok(`0x${'0'.repeat(64)}`) }],
    });
    assert.equal(capability.state, 'detected');
    assert.deepEqual(capability.state === 'detected' ? capability.configuredPeers : null, []);
  });

  test('a non-zero peer is a destination and is named by its endpoint id', () => {
    const capability = bridgeCapabilityFromReadsV1({
      endpoint,
      peers: [
        { endpointId: 30101, read: ok(`0x${'0'.repeat(63)}1`) },
        { endpointId: 30184, read: ok(`0x${'0'.repeat(64)}`) },
      ],
    });
    assert.deepEqual(capability.state === 'detected' ? capability.configuredPeers : null, [30101]);
  });

  test('a contract that is not an OFT is none_detected, not unread', () => {
    // Coinbase's B20 tokens revert on `endpoint()`. That is an answer — there is
    // no bridge at this address — and it must not read as a failed measurement.
    assert.deepEqual(
      bridgeCapabilityFromReadsV1({ endpoint: failed('execution reverted'), peers: [] }),
      { state: 'none_detected' },
    );
    assert.deepEqual(bridgeCapabilityFromReadsV1({ endpoint: ok('0x'), peers: [] }), {
      state: 'none_detected',
    });
  });

  test('an endpoint that answered while every peer read failed is unread', () => {
    const capability = bridgeCapabilityFromReadsV1({
      endpoint,
      peers: [{ endpointId: 30101, read: failed('timeout') }],
    });
    assert.equal(capability.state, 'unread');
  });
});
