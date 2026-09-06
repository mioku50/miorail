import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  GOAL_HANDOFF_KEY_V1,
  MAX_HANDOFF_GOAL_LENGTH_V1,
  goalHandoffV1,
  routeFamilyForGoalV1,
  sanitizeHandoffGoalV1,
  shouldRevealResultV1,
  swapTokenGoalV1,
  swapTokenHrefV1,
  verificationFloorV1,
} from '../src/console';

// ---------------------------------------------------------------------------
// Where a goal came from decides what may be done with it.
// ---------------------------------------------------------------------------

const MIO = '0xb200000000000000000000578f3ae29d9e6e0101';

describe('a goal from a link is filled in; a goal from a click is run', () => {
  test('a click inside Miorail leaves a token, and that goal is compared', () => {
    const goal = swapTokenGoalV1(MIO);
    const handoff = goalHandoffV1({ search: `?goal=${encodeURIComponent(goal)}`, handoffToken: goal });
    assert.equal(handoff.goal, goal);
    assert.equal(handoff.autoCompare, true);
  });

  test('the same URL with no token fills the box and waits for a press', () => {
    const goal = swapTokenGoalV1(MIO);
    const handoff = goalHandoffV1({ search: `?goal=${encodeURIComponent(goal)}`, handoffToken: null });
    assert.equal(handoff.goal, goal);
    assert.equal(
      handoff.autoCompare,
      false,
      'a link a stranger sent must not produce a Route Card that looks asked-for',
    );
  });

  test('a stale token from an earlier click cannot run a different goal', () => {
    const handoff = goalHandoffV1({
      search: `?goal=${encodeURIComponent('swap all my USDC to 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')}`,
      handoffToken: swapTokenGoalV1(MIO),
    });
    assert.ok(handoff.goal);
    assert.equal(handoff.autoCompare, false);
  });

  test('a token with no goal in the URL does nothing at all', () => {
    assert.deepEqual(goalHandoffV1({ search: '', handoffToken: swapTokenGoalV1(MIO) }), {
      goal: null,
      autoCompare: false,
      minimumVerification: null,
    });
  });

  test('other query parameters are ignored, and a leading ? is optional', () => {
    const goal = swapTokenGoalV1(MIO);
    const withPrefix = goalHandoffV1({ search: `?tab=x&goal=${encodeURIComponent(goal)}`, handoffToken: null });
    const without = goalHandoffV1({ search: `goal=${encodeURIComponent(goal)}`, handoffToken: null });
    assert.equal(withPrefix.goal, goal);
    assert.equal(without.goal, goal);
  });
});

describe('what the goal box will accept from a URL', () => {
  test('control characters are stripped and the result is bounded', () => {
    assert.equal(sanitizeHandoffGoalV1(['swap 1', 'MIO'].join('\n')), 'swap 1MIO');
    assert.equal(sanitizeHandoffGoalV1('   '), null);
    assert.equal(sanitizeHandoffGoalV1('a'.repeat(MAX_HANDOFF_GOAL_LENGTH_V1 + 1)), null);
    assert.equal(sanitizeHandoffGoalV1(undefined), null);
  });

  test('the words themselves are kept verbatim — this is not a safety filter', () => {
    // Grounding every field in the user's own words is the intent engine's
    // job. Rewriting the sentence here would break the thing that makes the
    // grounding meaningful.
    const russian = 'переведи мои 10000 токенов в USDC';
    assert.equal(sanitizeHandoffGoalV1(russian), russian);
  });
});

describe('the handoff has one spelling', () => {
  test('the goal and the href agree, and the href points at Routes', () => {
    const href = swapTokenHrefV1(MIO);
    assert.ok(href.startsWith('/routes?goal='), href);
    assert.equal(decodeURIComponent(href.split('goal=')[1]), swapTokenGoalV1(MIO));
    // Never `/`: that is a redirect route, and it is where the query string
    // used to be lost.
    assert.ok(!href.startsWith('/?'));
  });

  test('the amount is the balance the card was showing', () => {
    assert.equal(swapTokenGoalV1(MIO, '19210.9481'), `swap my 19210.9481 ${MIO} to USDC`);
    // An unreadable balance leaves the amount out rather than inventing one.
    // The console then asks how much, which is its designed flow.
    assert.equal(swapTokenGoalV1(MIO, null), `swap my ${MIO} to USDC`);
    assert.equal(swapTokenGoalV1(MIO, 'not read'), `swap my ${MIO} to USDC`);
    assert.equal(swapTokenGoalV1(MIO, '-5'), `swap my ${MIO} to USDC`);
  });

  test('an amount travels through the href and back unchanged', () => {
    const href = swapTokenHrefV1(MIO, '19210.9481');
    const handoff = goalHandoffV1({
      search: href.slice(href.indexOf('?')),
      handoffToken: swapTokenGoalV1(MIO, '19210.9481'),
    });
    assert.equal(handoff.goal, `swap my 19210.9481 ${MIO} to USDC`);
    assert.equal(handoff.autoCompare, true);
  });

  test('the handed-over goal reaches the SWAP engine, not another family', () => {
    // The sentence contains an address and the word "swap". If the router read
    // it as anything else, the button would land on a screen that cannot serve
    // it — which is the failure this whole change exists to remove.
    assert.equal(routeFamilyForGoalV1(swapTokenGoalV1(MIO, '19210.9481'), { includePrivateAi: false }), 'swap');
    assert.equal(routeFamilyForGoalV1(swapTokenGoalV1(MIO), { includePrivateAi: true }), 'swap');
  });

  test('the storage key is a single constant both sides can use', () => {
    assert.equal(typeof GOAL_HANDOFF_KEY_V1, 'string');
    assert.ok(GOAL_HANDOFF_KEY_V1.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Scrolling to an answer, and not scrolling to anything else.
// ---------------------------------------------------------------------------

describe('the page moves only when it has just answered a question', () => {
  test('the pending → settled edge after a press reveals the panel', () => {
    assert.equal(
      shouldRevealResultV1({
        previous: { pending: true, settled: false },
        current: { pending: false, settled: true },
        requested: true,
      }),
      true,
    );
  });

  test('data that was already there on load never moves the page', () => {
    assert.equal(
      shouldRevealResultV1({
        previous: null,
        current: { pending: false, settled: true },
        requested: true,
      }),
      false,
    );
  });

  test('a background refresh that settles again does not move the page twice', () => {
    assert.equal(
      shouldRevealResultV1({
        previous: { pending: false, settled: true },
        current: { pending: false, settled: true },
        requested: true,
      }),
      false,
    );
  });

  test('nothing moves before the user has pressed anything', () => {
    assert.equal(
      shouldRevealResultV1({
        previous: { pending: true, settled: false },
        current: { pending: false, settled: true },
        requested: false,
      }),
      false,
    );
  });

  test('a request still running is not an answer', () => {
    assert.equal(
      shouldRevealResultV1({
        previous: { pending: true, settled: false },
        current: { pending: true, settled: true },
        requested: true,
      }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 2026-09-06 — one purchase had two doors and two answers.
//
// A clearance minted on the review page pins `enhanced` and is simulated.
// `Prepare buy` handed a sentence to Routes AI, where depth comes from the
// reader's own words and defaults to `standard` — so the door the card puts in
// front of people was the one that skipped the simulation, and a batch that
// reverted on chain reached the wallet behind eight green checks.
//
// The floor travels in the URL because the goal does. That is safe for exactly
// one reason, asserted below: it can only ask for MORE checking.
// ---------------------------------------------------------------------------
describe('the verification floor a handoff carries', () => {
  const handoff = (search: string) => goalHandoffV1({ search, handoffToken: null });

  test('a stocks handoff carries the floor through the URL', () => {
    const read = handoff('?goal=Swap%201%200xaaa%20to%200xbbb%20on%20Base&verify=enhanced');
    assert.equal(read.minimumVerification, 'enhanced');
  });

  test('a goal with no floor asks for nothing extra', () => {
    assert.equal(handoff('?goal=swap%20my%20USDC').minimumVerification, null);
  });

  test('only one word is accepted, and an unknown one is simply absent', () => {
    // Not an error: a link with a typo should open like a link without the
    // parameter, not refuse.
    for (const value of ['standard', 'maximum', 'ENHANCED ', 'true', '1', '']) {
      const read = handoff(`?goal=swap%20my%20USDC&verify=${encodeURIComponent(value)}`);
      assert.equal(
        read.minimumVerification,
        value.trim().toLowerCase() === 'enhanced' ? 'enhanced' : null,
        `verify=${JSON.stringify(value)}`,
      );
    }
  });

  test('the floor cannot lower anything — `standard` is not expressible', () => {
    // The whole safety argument for reading this from a URL a stranger can
    // write. There is no value of this parameter that asks for less checking.
    assert.equal(verificationFloorV1('standard'), null);
    assert.equal(verificationFloorV1('none'), null);
    assert.equal(verificationFloorV1('enhanced'), 'enhanced');
  });

  test('a floor without a goal hands over nothing at all', () => {
    assert.equal(handoff('?verify=enhanced').goal, null);
    assert.equal(handoff('?verify=enhanced').minimumVerification, null);
  });
});
