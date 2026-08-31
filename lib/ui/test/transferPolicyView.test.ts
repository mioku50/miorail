import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  TRANSFER_POLICY_FOOTNOTE_V1,
  transferPolicyViewV1,
} from '../src/console/transferPolicyView';

// ---------------------------------------------------------------------------
// The token's own transfer rules, in the reader's words.
//
// The chain answers three verdicts about two different addresses plus a pause
// flag. That is the right shape to store and the wrong shape to read: the
// person looking at it wants to know whether they can move their own money,
// and "transfer_sender = authorized, policy id 5, blocklist" answers a
// different question in a different vocabulary.
// ---------------------------------------------------------------------------

const scope = (over: Record<string, unknown> = {}) => ({
  scope: 'transfer_sender',
  subject: 'wallet',
  account: '0x1111111111111111111111111111111111111111',
  verdict: 'authorized',
  policyId: '5',
  reason: null,
  ...over,
});

const all = (verdict: string) => [
  scope({ scope: 'transfer_sender', verdict }),
  scope({ scope: 'transfer_receiver', verdict }),
  scope({ scope: 'transfer_executor', subject: 'executor', verdict }),
];

describe('the onchain transfer policy, said as a reader would ask it', () => {
  test('an authorized wallet is told what it can do, in its own words', () => {
    const view = transferPolicyViewV1({
      transferPause: { state: 'not_paused' },
      scopes: all('authorized'),
    });
    assert.equal(view?.title, 'Onchain transfer policy');
    assert.deepEqual(
      view?.lines.map((line) => line.text),
      [
        'Your wallet can send this token.',
        'Your wallet can receive this token.',
        'The app that would move the token is allowed to.',
      ],
    );
    assert.equal(view?.verdict, 'authorized');
    // None of the system vocabulary reaches the screen.
    const markup = view!.lines.map((line) => line.text).join(' ');
    for (const word of ['transfer_sender', 'not_established', 'policyId', 'blocklist', 'scope']) {
      assert.doesNotMatch(markup, new RegExp(word, 'i'), word);
    }
  });

  test('an unknown executor is "not confirmed", never silence and never a denial', () => {
    // The state every review in this build is in: the router is chosen after
    // the review step, so no exact executor address exists to ask about.
    const view = transferPolicyViewV1({
      executor: null,
      transferPause: { state: 'not_paused' },
      scopes: [
        scope({ scope: 'transfer_sender', verdict: 'authorized' }),
        scope({ scope: 'transfer_receiver', verdict: 'not_established', reason: 'x' }),
        scope({
          scope: 'transfer_executor',
          subject: 'executor',
          account: null,
          verdict: 'not_established',
        }),
      ],
    });
    assert.equal(view?.lines[1]?.text, 'Receiving status not confirmed.');
    assert.match(view?.lines[2]?.text ?? '', /Not confirmed which app would move the token/);
    // Not authorized: two of three scopes did not answer.
    assert.equal(view?.verdict, 'not_established');
    assert.equal(
      view?.lines.some((line) => /cannot|blocked|denied/i.test(line.text)),
      false,
    );
  });

  test('a denial names the side it applies to, and an executor denial is not the wallet', () => {
    const wallet = transferPolicyViewV1({
      transferPause: { state: 'not_paused' },
      scopes: [
        scope({ scope: 'transfer_sender', verdict: 'denied' }),
        scope({ scope: 'transfer_receiver', verdict: 'authorized' }),
      ],
    });
    assert.equal(wallet?.lines[0]?.text, 'Your wallet cannot send this token right now.');
    assert.equal(wallet?.lines[0]?.tone, 'off');
    assert.equal(wallet?.verdict, 'denied');

    const executor = transferPolicyViewV1({
      transferPause: { state: 'not_paused' },
      scopes: [
        scope({ scope: 'transfer_sender', verdict: 'authorized' }),
        scope({ scope: 'transfer_receiver', verdict: 'authorized' }),
        scope({ scope: 'transfer_executor', subject: 'executor', verdict: 'denied' }),
      ],
    });
    // A reader told "you are blocked" when the refusal belongs to a router
    // would go looking for a problem with their own account that is not there.
    assert.match(executor?.lines[2]?.text ?? '', /not about your wallet/);
    assert.match(executor?.lines[0]?.text ?? '', /Your wallet can send/);
  });

  test('a pause is the contract refusing everyone, and it outranks the per-address lines', () => {
    const view = transferPolicyViewV1({
      transferPause: { state: 'paused' },
      scopes: all('authorized'),
    });
    assert.match(view?.lines[0]?.text ?? '', /paused on the contract right now, for everyone/);
    // Every scope said yes, and the transfer still cannot happen. An
    // `authorized` headline over a paused contract would be a false all-clear.
    assert.equal(view?.verdict, 'denied');
  });

  test('an unread pause is not an unpaused contract', () => {
    const view = transferPolicyViewV1({
      transferPause: { state: 'not_established' },
      scopes: all('authorized'),
    });
    assert.equal(view?.lines[0]?.text, 'Whether transfers are paused was not confirmed.');
    assert.equal(view?.lines[0]?.tone, 'neutral');
    // Unread is not a denial either.
    assert.equal(view?.verdict, 'authorized');
  });

  test('nothing read renders nothing at all', () => {
    // "No restriction found" and "we did not look" are the two states this
    // product exists to keep apart, and an empty box says neither.
    assert.equal(transferPolicyViewV1(null), null);
    assert.equal(transferPolicyViewV1({ scopes: [] }), null);
    assert.equal(transferPolicyViewV1({ scopes: [scope({ scope: 'mint_receiver' })] }), null);
  });

  test('the footnote states the boundary and never widens it', () => {
    assert.match(TRANSFER_POLICY_FOOTNOTE_V1, /read on chain/);
    assert.match(TRANSFER_POLICY_FOOTNOTE_V1, /say nothing about the market/);
  });
});
