import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { ComparingScreen, PlanScreen, type ComparingScreenModelV1, type PlanScreenModelV1 } from '../src/index';

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
