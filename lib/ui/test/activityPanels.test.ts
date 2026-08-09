import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  activityDeviationLabelV1,
  activityRunStageCopyV1,
  activityRunToneV1,
  activityRunUnsignedV1,
  activityRunsSummaryV1,
  activityShortHashV1,
  activitySpendLabelV1,
  activitySpendSummaryCopyV1,
  type ActivityRunRowV1,
} from '../src/console/ActivityPanels';

const run = (overrides: Partial<ActivityRunRowV1> = {}): ActivityRunRowV1 => ({
  routeRunId: 'run-1',
  createdAt: '2026-08-09T12:00:00.000Z',
  runStatus: 'ready',
  intentSummary: 'Swap 100 USDC to ETH',
  provider: 'uniswap',
  proofId: null,
  proofFinalStatus: null,
  ...overrides,
});

describe('a run says where it stopped, not what column it is in', () => {
  test('`ready` is spelled out as prepared and never signed', () => {
    // This is the whole reason the surface was renamed. Twenty-five runs sat
    // at `ready` and the page showed the word, which reads like a state of
    // readiness rather than "this never happened".
    const copy = activityRunStageCopyV1('ready');
    assert.match(copy, /never signed/i);
    assert.match(copy, /no proof/i);
  });

  test('every stored status has words, and an unknown one says so', () => {
    for (const status of [
      'draft', 'needs_clarification', 'collecting_candidates', 'collecting_evidence',
      'scoring', 'ready', 'card_ready', 'blueprint_ready', 'awaiting_approval',
      'executing', 'reconciling', 'completed', 'partial_failure', 'failed',
      'cancelled', 'rejected',
    ]) {
      assert.ok(activityRunStageCopyV1(status).length > 0, status);
      assert.doesNotMatch(activityRunStageCopyV1(status), /does not have words/, status);
    }
    // An unrecognised status must not silently borrow another one's sentence.
    assert.match(activityRunStageCopyV1('teleported'), /does not have words/);
  });

  test('a submitted run is not counted as unsigned', () => {
    assert.equal(activityRunUnsignedV1('ready'), true);
    assert.equal(activityRunUnsignedV1('awaiting_approval'), true);
    assert.equal(activityRunUnsignedV1('executing'), false);
    assert.equal(activityRunUnsignedV1('completed'), false);
  });

  test('tones come from the four console.css pill tones', () => {
    for (const status of ['ready', 'completed', 'executing', 'failed', 'nonsense']) {
      assert.ok(['br', 'g', 'a', 'n'].includes(activityRunToneV1(status)), status);
    }
    assert.equal(activityRunToneV1('completed'), 'g');
    // A failure must not share the tone of a success.
    assert.notEqual(activityRunToneV1('failed'), activityRunToneV1('completed'));
  });
});

describe('the summary is honest about a list of things that did not happen', () => {
  test('with no proofs it says so and says why there are none', () => {
    const summary = activityRunsSummaryV1([run(), run({ routeRunId: 'run-2' })]);
    assert.match(summary, /2 runs/);
    assert.match(summary, /2 of them never signed/);
    assert.match(summary, /No proofs yet/);
  });

  test('with proofs it counts them instead', () => {
    const summary = activityRunsSummaryV1([
      run({ proofId: 'p1', runStatus: 'completed' }),
      run({ routeRunId: 'run-2' }),
    ]);
    assert.match(summary, /1 with an execution proof/);
    assert.doesNotMatch(summary, /No proofs yet/);
  });

  test('an empty history is empty, not a claim', () => {
    assert.equal(activityRunsSummaryV1([]), 'No route runs yet.');
  });
});

describe('a small charge is not rounded to nothing', () => {
  test('the B20 exit proof price survives formatting', () => {
    // `toFixed(2)` would render every 0.0002 USDC charge as $0.00, which is a
    // ledger claiming the user was not charged.
    assert.equal(activitySpendLabelV1('0.0002'), '$0.0002');
    assert.equal(activitySpendLabelV1('0.001'), '$0.001');
  });

  test('ordinary amounts keep two decimals', () => {
    assert.equal(activitySpendLabelV1('1.5'), '$1.50');
    assert.equal(activitySpendLabelV1(12), '$12.00');
  });

  test('absent and unparseable are shown as unknown, never as zero', () => {
    assert.equal(activitySpendLabelV1(null), '—');
    assert.equal(activitySpendLabelV1('not a number'), '—');
    assert.equal(activitySpendLabelV1('0'), '$0');
  });
});

describe('development smoke payments are not dressed up as usage', () => {
  test('the smoke share of the total is named', () => {
    const copy = activitySpendSummaryCopyV1({
      totalSpentUsdc: '0.013',
      devSmokeSpentUsdc: '0.013',
      devSmokeCallsCount: 13,
    });
    assert.match(copy, /13 development smoke payments/);
    assert.match(copy, /not a purchase anybody made/i);
  });

  test('failed and pending attempts are excluded from the total, and said to be', () => {
    const copy = activitySpendSummaryCopyV1({
      totalSpentUsdc: '0',
      failedBuyerAttemptsCount: 2,
      pendingBuyerAttemptsCount: 1,
    });
    assert.match(copy, /2 attempt\(s\) failed and are not counted/);
    assert.match(copy, /1 still pending/);
  });

  test('no ledger at all is stated as no record, not as zero spend', () => {
    assert.match(activitySpendSummaryCopyV1(null), /No paid intelligence has been recorded/);
  });
});

describe('proof details', () => {
  test('a deviation carries its sign', () => {
    assert.equal(activityDeviationLabelV1(12), '+0.12%');
    assert.equal(activityDeviationLabelV1(-40), '-0.40%');
  });

  test('a deviation that was never computed is null, not zero', () => {
    // Zero deviation means "matched exactly", which is a finding. Not having
    // measured is not.
    assert.equal(activityDeviationLabelV1(null), null);
    assert.equal(activityDeviationLabelV1(0), '0.00%');
  });

  test('a hash is shortened but stays recognisable, and absence shows as a dash', () => {
    assert.equal(activityShortHashV1(null), '—');
    const short = activityShortHashV1(`0x${'a'.repeat(64)}`);
    assert.ok(short.startsWith('0xaaaaaaaa'));
    assert.ok(short.includes('…'));
  });
});
