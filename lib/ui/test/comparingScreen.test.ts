import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ComparingScreen,
  PlanScreen,
  ReviewScreen,
  RouteScreen,
  type ComparingScreenModelV1,
  type PlanScreenModelV1,
  type ReviewScreenModelV1,
} from '../src/index';

// ---------------------------------------------------------------------------
// T64.3.1 §4 — Comparing must END.
//
// The defect: an intent that came back `needs_clarification` left the screen
// spinning forever. The stepper stayed on Candidates, "updating live" kept
// promising rows that would never arrive, and there was no way back to the
// goal except the browser. A screen that cannot finish is worse than a screen
// that reports a failure, because the user waits instead of acting.
//
// Pure, per the lib/ui convention: the component is called as a function and
// its element tree inspected — no DOM.
// ---------------------------------------------------------------------------

function comparing(overrides: Partial<ComparingScreenModelV1> = {}): ComparingScreenModelV1 {
  return {
    steps: [],
    goalLabel: 'Buy a $5 Steam card',
    optimisingFor: 'commerce route',
    elapsedLabel: 'done',
    progress: [
      { label: 'Intent extraction', state: 'failed', value: 'commerce', latencyPercent: 8 },
      { label: 'Bitrefill catalogue', state: 'failed', value: 'not reached', latencyPercent: 0 },
    ],
    candidates: [],
    sources: [],
    shortfallNotice: null,
    failure: null,
    onEditGoal: () => {},
    onCancel: () => {},
    ...overrides,
  };
}

function plan(overrides: Partial<PlanScreenModelV1> = {}): PlanScreenModelV1 {
  return {
    goal: 'Earn yield on 5 USDC',
    onGoalChange: () => {},
    onCompare: () => {},
    comparePending: false,
    compareDisabledReason: null,
    starters: [],
    onStarter: () => {},
    walletLabel: '0x4de2…0d70',
    balances: [],
    balancesUnavailableReason: null,
    coverage: [],
    chainKpis: [],
    gasPoints: [],
    chainNote: '',
    ...overrides,
  };
}

describe('Comparing ends instead of spinning', () => {
  test('a terminal failure names the reason and offers a way back', () => {
    const rendered = JSON.stringify(
      ComparingScreen(
        comparing({
          failure: {
            title: 'This goal needs one more detail',
            detail: 'Say the card value, for example “$5”.',
          },
        }),
      ),
    );
    assert.match(rendered, /This goal needs one more detail/);
    assert.match(rendered, /Say the card value/);
    assert.match(rendered, /Edit goal/);
    // "updating live" while nothing is updating is the lie this replaces.
    assert.equal(rendered.includes('updating live'), false);
    assert.match(rendered, /finished — no candidates/);
  });

  test('the Edit goal button is wired to the handler, not decorative', () => {
    let clicked = 0;
    const model = comparing({
      failure: { title: 'Blocked', detail: 'Commerce routing is off on this server.' },
      onEditGoal: () => {
        clicked += 1;
      },
    });
    const tree = ComparingScreen(model) as unknown as { props: unknown };
    const found = findButtonByLabel(tree, 'Edit goal');
    assert.ok(found, 'no Edit goal button was rendered');
    found();
    assert.equal(clicked, 1);
  });

  test('a question can be answered where it is asked', () => {
    // The defect this closes: the console asked "which exact Base token should
    // be swapped?" and offered only Edit goal, so the only way to reply was to
    // retype the sentence the question was about.
    let answered: string | null = null;
    const model = comparing({
      failure: {
        title: 'This goal needs one more detail',
        detail: 'Which exact Base token should be swapped?',
        answerable: true,
      },
      answerValue: '  USDC  ',
      onAnswer: (value) => {
        answered = value;
      },
    });
    const rendered = JSON.stringify(ComparingScreen(model));
    assert.match(rendered, /Which exact Base token should be swapped\?/);
    assert.match(rendered, /mio-clarification-answer/);
    // Reuses console.css classes; a new class name would ship unstyled.
    assert.match(rendered, /goalinput/);

    const submit = findButtonByLabel(ComparingScreen(model) as unknown as { props: unknown }, 'Answer');
    assert.ok(submit, 'no Answer button was rendered');
    submit();
    assert.equal(answered, 'USDC');
  });

  test('a rejection offers no answer field, because it asked nothing', () => {
    const rendered = JSON.stringify(
      ComparingScreen(
        comparing({
          failure: { title: 'Miorail cannot route this swap', detail: 'Sending is not a swap.' },
          onAnswer: () => {},
        }),
      ),
    );
    assert.equal(rendered.includes('mio-clarification-answer'), false);
    assert.match(rendered, /Edit goal/);
  });

  test('an empty answer cannot be submitted', () => {
    let answered = 0;
    const model = comparing({
      failure: { title: 'Needs detail', detail: 'Which token?', answerable: true },
      answerValue: '   ',
      onAnswer: () => {
        answered += 1;
      },
    });
    const submit = findButtonByLabel(ComparingScreen(model) as unknown as { props: unknown }, 'Answer');
    assert.ok(submit, 'no Answer button was rendered');
    submit();
    assert.equal(answered, 0);
  });

  test('a run still in flight keeps its live wording and shows no failure block', () => {
    const rendered = JSON.stringify(
      ComparingScreen(
        comparing({
          elapsedLabel: 'running',
          progress: [{ label: 'Bitrefill catalogue', state: 'running', value: '', latencyPercent: 0 }],
        }),
      ),
    );
    assert.match(rendered, /updating live/);
    assert.equal(rendered.includes('Edit goal'), false);
  });
});

describe('the Compare button cannot lie about being clickable', () => {
  test('a blocked route family disables the button rather than ignoring the click', () => {
    const rendered = JSON.stringify(
      PlanScreen(plan({ compareDisabledReason: 'Earn routing is off on this server. Swap routes still compare normally.' })),
    );
    assert.match(rendered, /"disabled":true/);
    assert.match(rendered, /Earn routing is off on this server/);
  });

  test('with no reason the button stays enabled', () => {
    const rendered = JSON.stringify(PlanScreen(plan()));
    assert.match(rendered, /"disabled":false/);
  });
});

/** Walks a React element tree for a button whose child text matches, and
 * returns its onClick. Kept local — the lib/ui tests deliberately avoid a DOM. */
function findButtonByLabel(node: unknown, label: string): (() => void) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButtonByLabel(child, label);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  const props = element.props ?? {};
  if (element.type === 'button' && JSON.stringify(props.children ?? '').includes(label)) {
    return typeof props.onClick === 'function' ? (props.onClick as () => void) : null;
  }
  return findButtonByLabel(props.children, label);
}

describe('Review says why there is nothing to sign', () => {
  function review(overrides: Partial<ReviewScreenModelV1> = {}): ReviewScreenModelV1 {
    return {
      steps: [],
      calls: [],
      simulation: {
        available: false,
        passed: false,
        headline: 'Simulation not available',
        detail: 'No simulation provider answered.',
        subLabel: 'not available',
        canSign: false,
        disabledReason: 'Simulation is not available yet, so nothing is signed from a guess.',
      },
      balanceChanges: [],
      balanceUnavailableReason: null,
      checks: [{ label: 'Chain is Base mainnet', passed: false }],
      limits: [],
      onLimitChange: () => {},
      onApprove: () => {},
      onBack: () => {},
      approvePending: false,
      ...overrides,
    };
  }

  test('a refused prepare states the server’s reason instead of blaming simulation', () => {
    // What the user saw: zero calls, every check "not confirmed", a disabled
    // button, and the only sentence on screen was about simulation — which was
    // not the reason for any of it.
    const rendered = JSON.stringify(
      ReviewScreen(
        review({
          notice: {
            title: 'This route needs comparing again',
            detail: 'The quote behind this Route Card expired.',
          },
        }),
      ),
    );
    assert.match(rendered, /This route needs comparing again/);
    assert.match(rendered, /The quote behind this Route Card expired/);
  });

  test('a prepared route carries no notice at all', () => {
    const rendered = JSON.stringify(ReviewScreen(review()));
    assert.equal(rendered.includes('needs comparing again'), false);
  });

  test('an expired comparison offers a new comparison, not just the way back', () => {
    // The loop this closes: a Route Card expires with the shortest quote it
    // displays — measured at ~22 seconds in production — and "Back to routes"
    // returned the user to that same expired card, which refused again on the
    // next click. Reported as "I went back, picked another route, same error".
    let compared = 0;
    const model = review({
      notice: {
        title: 'This route needs comparing again',
        detail: 'Route Card quote comparison has expired',
        canCompareAgain: true,
      },
      onCompareAgain: () => {
        compared += 1;
      },
    });
    const found = findButtonByLabel(ReviewScreen(model) as unknown as { props: unknown }, 'Compare again');
    assert.ok(found, 'no way to compare again was rendered');
    found();
    assert.equal(compared, 1);
  });

  test('a refusal a new comparison cannot fix does not offer one', () => {
    // Comparing again cannot change an unsupported pair or a Safety Kernel
    // verdict; a button that promises it would be a lie about what happens.
    const rendered = JSON.stringify(
      ReviewScreen(
        review({
          notice: { title: 'The Safety Kernel refused this transaction', detail: 'Recipient is not your wallet.' },
          onCompareAgain: () => {},
        }),
      ),
    );
    assert.equal(rendered.includes('Compare again'), false);
    assert.match(rendered, /Back to routes/);
  });

  test('a comparison already running says so instead of accepting a second click', () => {
    const rendered = JSON.stringify(
      ReviewScreen(
        review({
          notice: { title: 'This route needs comparing again', detail: 'expired', canCompareAgain: true },
          onCompareAgain: () => {},
          comparePending: true,
        }),
      ),
    );
    assert.match(rendered, /Comparing…/);
    assert.match(rendered, /"disabled":true/);
  });

  test('the notice offers the way back, so the screen is never a dead end', () => {
    let backs = 0;
    const model = review({
      notice: { title: 'The Safety Kernel refused this transaction', detail: 'Recipient is not your wallet.' },
      onBack: () => {
        backs += 1;
      },
    });
    const found = findButtonByLabel(ReviewScreen(model) as unknown as { props: unknown }, 'Back to routes');
    assert.ok(found, 'no way back was rendered');
    found();
    assert.equal(backs, 1);
  });
});

describe('the signing button is the real one', () => {
  function review(overrides: Partial<ReviewScreenModelV1> = {}): ReviewScreenModelV1 {
    return {
      steps: [],
      calls: [],
      simulation: {
        available: false,
        passed: false,
        headline: 'Simulation not available',
        detail: 'No simulation provider answered.',
        subLabel: 'not available',
        canSign: true,
        disabledReason: null,
      },
      balanceChanges: [],
      balanceUnavailableReason: null,
      checks: [],
      limits: [],
      onLimitChange: () => {},
      onApprove: () => {},
      onBack: () => {},
      approvePending: false,
      ...overrides,
    };
  }

  test('a supplied sign slot replaces the placeholder CTA', () => {
    // The defect: the CTA row held a large primary "Approve in Base Account"
    // wired to `() => undefined`, while the control that actually reaches the
    // wallet sat in a panel below the fold. People pressed the visible one and
    // nothing happened.
    const rendered = JSON.stringify(
      ReviewScreen(review({ signSlot: { type: 'button', props: { children: 'Sign with Base Account' } } as never })),
    );
    assert.match(rendered, /Sign with Base Account/);
    assert.equal(rendered.includes('Approve in Base Account'), false);
  });

  test('with no slot the built-in button still renders, so the row is never empty', () => {
    const rendered = JSON.stringify(ReviewScreen(review({ simulation: { ...review().simulation, canSign: false, disabledReason: 'x' } })));
    assert.match(rendered, /Approve in Base Account/);
    assert.match(rendered, /"disabled":true/);
  });
});

describe('a route cannot be chosen when no Route Card exists', () => {
  test('Use this is disabled with the same reason that disables Review', () => {
    // Reported: "Uniswap was unavailable, I tried to pick another provider
    // with Use this, and the buttons did nothing." A degraded run yields
    // candidates with real numbers and NO signable Route Card, so selecting
    // one only reached a console.warn. Review already said so and disabled
    // itself; the table did not.
    const reason = 'This comparison finished without a signable Route Card, so there is nothing to review.';
    const rendered = JSON.stringify(
      RouteScreen({
        steps: [],
        eyebrow: 'Recommended route',
        amount: '0.1',
        unit: 'USDC',
        usd: '$0.10',
        providerLabel: 'Aerodrome',
        freshness: { label: 'fresh', tone: 'g' },
        why: 'best net result',
        kpis: [],
        graph: null,
        graphUnavailableReason: 'no graph',
        graphLegend: [],
        simulatedPill: { label: 'not simulated', tone: 'n' },
        scoreRows: [],
        scoringVersion: 'swap-path-score/v1',
        candidates: [
          {
            id: 'aerodrome',
            name: 'Aerodrome',
            outputLabel: '0.000053',
            netLabel: '0.000052',
            scorePercent: 50,
            scoreDim: false,
            why: 'Alternative route',
            state: 'alternative',
            stateLabel: 'alternative',
            actionLabel: 'Use this',
            selectable: true,
          },
        ],
        onSelectCandidate: () => {},
        onReview: () => {},
        onChangeGoal: () => {},
        reviewDisabledReason: reason,
      } as never),
    );
    // The row keeps its numbers rather than hiding, and the SAME reason that
    // disables Review is handed to the table, which disables every Use this.
    // (React does not expand a child component here, so the assertion is on
    // the prop crossing the boundary — the table's own behaviour is the one
    // line `disabled={Boolean(selectBlockedReason)}`.)
    assert.match(rendered, /Aerodrome/);
    assert.match(rendered, /"selectBlockedReason":"This comparison finished without a signable Route Card/);
    // And Review itself stays disabled, as it already was.
    assert.match(rendered, /"disabled":true/);
  });
});
