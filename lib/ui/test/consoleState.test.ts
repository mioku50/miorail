import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSOLE_COPY_V1,
  CONSOLE_RAIL_V1,
  CONSOLE_SCREEN_STEP_V1,
  adapterShortfallCopyV1,
  ageLabelV1,
  candidateSummaryV1,
  compactStepLabelV1,
  consoleFailureCopyV1,
  deriveAdapterRowsV1,
  deriveCandidateRowsV1,
  deriveEvidenceRowsV1,
  deriveScoreRowsV1,
  deriveSimulationViewV1,
  deriveStepperV1,
  intelligenceSpendLabelV1,
  quoteFreshnessV1,
  radarGeometryV1,
  scoredCountLabelV1,
  usagePercentV1,
} from '../src/console/consoleState';
import {
  ConsoleStepper,
  RouteGraph,
  ScoreRadar,
  ScoreRows,
  type RouteGraphModelV1,
} from '../src/console/ConsoleCharts';

// ---------------------------------------------------------------------------
// The console's non-negotiable rules, tested rather than trusted:
//   empty is never good · an unscored dimension never glows · freshness is
//   always on screen · nothing is signed on a guess.
// Components are invoked as functions and their element tree inspected — the
// lib/ui convention, so no DOM is needed.
// ---------------------------------------------------------------------------

const scoreSource = [
  { key: 'net_result', label: 'Net result', score: 94, confidence: '2 sources · 8s old' },
  { key: 'safety', label: 'Safety', score: 86, confidence: 'simulation · 3s old' },
  { key: 'liquidity', label: 'Liquidity', score: 96, confidence: 'paid depth · 12s old' },
  { key: 'simplicity', label: 'Simplicity', score: 78, confidence: '2 calls, 1 approval' },
  { key: 'mev', label: 'MEV protection', score: null, confidence: null },
];

describe('stepper — the flow is 8 steps, not tabs', () => {
  test('marks done / now / todo against the active step and never invents a timing', () => {
    const steps = deriveStepperV1(CONSOLE_SCREEN_STEP_V1.route, ['0.2s', '1.2s', '0.4s', '1.9s']);
    assert.equal(steps.length, 8);
    assert.deepEqual(
      steps.map((step) => step.state),
      ['done', 'done', 'done', 'done', 'now', 'todo', 'todo', 'todo'],
    );
    assert.equal(steps[0].timing, '0.2s');
    // Unmeasured steps show an em dash rather than a fabricated duration.
    assert.equal(steps[5].timing, '—');
    assert.deepEqual(steps.map((step) => step.name), [...CONSOLE_RAIL_V1]);
  });

  test('every screen maps onto one rail step, and plan has not started', () => {
    assert.equal(CONSOLE_SCREEN_STEP_V1.plan, 0);
    assert.equal(CONSOLE_SCREEN_STEP_V1.proof, 8);
    assert.deepEqual(deriveStepperV1(0).map((step) => step.state), Array(8).fill('todo'));
  });

  test('the miniapp label compresses the same rail without losing the step', () => {
    assert.equal(compactStepLabelV1(5), 'Step 5 of 8 · Score');
    assert.equal(compactStepLabelV1(8), 'Step 8 of 8 · Proof');
    assert.match(compactStepLabelV1(0), /Not started/);
  });

  test('renders the current step with aria-current', () => {
    const rendered = JSON.stringify(ConsoleStepper({ steps: deriveStepperV1(5) }));
    assert.ok(rendered.includes('"aria-current":"step"'));
    assert.ok(rendered.includes('Score'));
  });
});

describe('unscored dimensions never light up', () => {
  test('a null score stays null: no 0, no green, and the words "not scored"', () => {
    const rows = deriveScoreRowsV1(scoreSource);
    const mev = rows.find((row) => row.key === 'mev')!;
    assert.equal(mev.scored, false);
    assert.equal(mev.score, null);
    assert.equal(mev.width, 0);
    assert.equal(mev.numberLabel, '—');
    assert.equal(mev.confidenceLabel, CONSOLE_COPY_V1.notScored);
    assert.equal(scoredCountLabelV1(rows), '4 of 5 dimensions scored');
  });

  test('the score row for an unscored dimension uses the hatched track, not a filled bar', () => {
    const rendered = JSON.stringify(ScoreRows({ rows: deriveScoreRowsV1(scoreSource) }));
    assert.ok(rendered.includes('"className":"track na"'));
    assert.ok(rendered.includes('scorerow na'));
    assert.ok(rendered.includes(CONSOLE_COPY_V1.notScored));
  });

  test('the radar draws a dashed axis to the centre for an unscored dimension', () => {
    const rows = deriveScoreRowsV1(scoreSource);
    const geometry = radarGeometryV1(rows);
    assert.equal(geometry.unscoredAxes.length, 1);
    assert.equal(geometry.points.filter((point) => !point.scored).length, 1);
    // The unscored vertex sits exactly at the centre and is drawn open.
    const centre = geometry.points.find((point) => !point.scored)!;
    assert.equal(centre.x, 60);
    assert.equal(centre.y, 58);

    const rendered = JSON.stringify(ScoreRadar({ rows, label: 'radar' }));
    assert.ok(rendered.includes('"strokeDasharray":"3 3"'), 'dashed axis');
    assert.ok(rendered.includes('"className":"pt-o"'), 'open point, not a filled vertex');
    assert.ok(rendered.includes(CONSOLE_COPY_V1.dashedAxis));
  });

  test('a fully scored set draws no dashed axis and no legend', () => {
    const rows = deriveScoreRowsV1(scoreSource.map((row) => ({ ...row, score: row.score ?? 50 })));
    const geometry = radarGeometryV1(rows);
    assert.equal(geometry.unscoredAxes.length, 0);
    assert.equal(JSON.stringify(ScoreRadar({ rows, label: 'radar' })).includes(CONSOLE_COPY_V1.dashedAxis), false);
  });
});

describe('empty is never good', () => {
  test('unavailable candidates stay in the table with a reason', () => {
    const rows = deriveCandidateRowsV1([
      { id: 'kyber', name: 'KyberSwap', output: '0.03142', net: '0.03140', scorePercent: 91, why: 'Best net result', state: 'chosen' },
      { id: 'uni', name: 'Uniswap', output: '0.03135', net: '0.03133', scorePercent: 88, why: 'Simpler: one hop', state: 'available' },
      { id: 'aero', name: 'Aerodrome direct', output: null, net: null, scorePercent: null, why: '', state: 'unavailable', reason: 'Adapter in progress' },
      { id: 'cex', name: 'CEX bridge', output: null, net: null, scorePercent: null, why: '', state: 'blocked', reason: 'Out of policy · custody would leave your wallet' },
    ]);
    assert.equal(rows.length, 4, 'no row is dropped');
    const aero = rows.find((row) => row.id === 'aero')!;
    assert.equal(aero.outputLabel, '—');
    assert.equal(aero.why, 'Adapter in progress');
    assert.equal(aero.selectable, false);
    assert.equal(aero.actionLabel, 'Unavailable');
    const cex = rows.find((row) => row.id === 'cex')!;
    assert.equal(cex.actionLabel, 'Blocked');
    assert.match(cex.why, /custody/);
    assert.equal(candidateSummaryV1(rows), '4 considered · 2 quotable');
  });

  test('a source that never answered keeps its row, its cost column and its reason', () => {
    const rows = deriveEvidenceRowsV1([
      { name: 'Uniswap Trade API', kind: 'quote', freshness: '1.2s', cost: 'free', result: 'ok' },
      { name: 'Liquidity depth', kind: 'paid data', freshness: '0.4s', cost: '$0.006', result: 'ok' },
      { name: 'MEV feed', kind: 'mev', freshness: null, cost: null, result: 'unavailable', reason: 'no source' },
    ]);
    assert.equal(rows.length, 3);
    const mev = rows[2];
    assert.equal(mev.available, false);
    assert.equal(mev.freshnessLabel, '—');
    assert.equal(mev.costLabel, '—');
    assert.equal(mev.resultLabel, 'no source');
    // Cost of intelligence is always visible.
    assert.equal(rows[0].costLabel, 'free');
    assert.equal(intelligenceSpendLabelV1([
      { name: 'a', kind: 'quote', freshness: '1s', cost: 'free', result: 'ok' },
      { name: 'b', kind: 'paid', freshness: '1s', cost: '$0.006', result: 'ok' },
    ]), '$0.006 · 1 paid call');
  });

  test('adapter shortfall is stated in terms of what still works', () => {
    assert.equal(
      adapterShortfallCopyV1([
        { name: 'Uniswap', answered: false },
        { name: 'KyberSwap', answered: true },
      ]),
      CONSOLE_COPY_V1.oneAdapterQuoted,
    );
    assert.equal(adapterShortfallCopyV1([{ name: 'Uniswap', answered: true }]), null);
  });

  test('adapter rows never hide a provider that is not built yet', () => {
    const { rows, summary } = deriveAdapterRowsV1([
      { name: 'Uniswap', state: 'live' },
      { name: 'KyberSwap', state: 'live' },
      { name: 'Moonwell', state: 'configured' },
      { name: 'Aerodrome', state: 'preflight_failed' },
      { name: 'o1.exchange', state: 'blocked' },
    ]);
    // Configured counts toward the summary — it is switched on and can answer.
    assert.equal(summary, '3 / 5');
    assert.deepEqual(rows.map((row) => row.label), ['live', 'live', 'configured', 'preflight failed', 'blocked']);
  });

  // T67D — `blocked` is its own state and must not be read as any of the
  // others: not `planned` (which promises the integration is coming), not
  // `disabled` (a switch someone could flip), not `preflight_failed` (a call
  // that might succeed next time).
  test('a gated-incompatible provider is blocked, and never counts as usable', () => {
    const { rows, summary } = deriveAdapterRowsV1([
      { name: 'Uniswap', state: 'live' },
      { name: 'o1.exchange', state: 'blocked' },
    ]);
    assert.equal(summary, '1 / 2');
    const o1 = rows.find((row) => row.name === 'o1.exchange')!;
    assert.equal(o1.label, 'blocked');
    assert.equal(o1.live, false);
    assert.equal(o1.usable, false);
  });

  // T64.3.1 — the distinction the old single `not_connected` bucket destroyed.
  test('a switched-off flag is disabled, and a failed call is not the same thing', () => {
    const { rows } = deriveAdapterRowsV1([
      { name: 'Moonwell', state: 'disabled' },
      { name: 'Morpho', state: 'preflight_failed' },
    ]);
    assert.deepEqual(rows.map((row) => row.label), ['disabled', 'preflight failed']);
    for (const row of rows) {
      assert.equal(row.label.includes('not connected'), false, 'a flag is not a broken connection');
      assert.equal(row.live, false);
      assert.equal(row.usable, false);
    }
  });

  test('only an adapter that answered gets the live tick', () => {
    const { rows } = deriveAdapterRowsV1([
      { name: 'Uniswap', state: 'live' },
      { name: 'Moonwell', state: 'configured' },
    ]);
    assert.deepEqual(rows.map((row) => [row.live, row.usable]), [
      [true, true],
      [false, true],
    ]);
  });
});

describe('freshness is always on screen', () => {
  test('a quote older than the threshold turns amber', () => {
    assert.deepEqual(quoteFreshnessV1(8), { label: 'quote 8s', tone: 'n', stale: false });
    assert.deepEqual(quoteFreshnessV1(45), { label: 'quote 45s', tone: 'n', stale: false });
    assert.deepEqual(quoteFreshnessV1(46), { label: 'quote 46s', tone: 'a', stale: true });
  });

  test('an unknown age is treated as stale, never as fresh', () => {
    const unknown = quoteFreshnessV1(null);
    assert.equal(unknown.tone, 'a');
    assert.equal(unknown.stale, true);
    assert.equal(ageLabelV1(null), '—');
    assert.equal(ageLabelV1(90), '1m 30s');
  });
});

describe('nothing is signed on a guess', () => {
  test('a missing simulation keeps the block, states why, and disables signing', () => {
    const view = deriveSimulationViewV1(null);
    assert.equal(view.available, false);
    assert.equal(view.passed, false);
    assert.equal(view.canSign, false);
    assert.equal(view.headline, 'Simulation not available');
    assert.match(view.detail, /Route comparison and the calls above are unchanged/);
    assert.equal(view.disabledReason, CONSOLE_COPY_V1.simulationUnavailable);
  });

  test('a reverted simulation also blocks signing and says what to do next', () => {
    const view = deriveSimulationViewV1({ status: 'failed', provider: 'Alchemy', blockNumber: '1', ageSeconds: 3, gasUsed: '21000' });
    assert.equal(view.canSign, false);
    assert.match(view.detail, /Nothing was signed/);
    assert.match(view.detail, /change the route or the amount/);
  });

  test('only a passed simulation unlocks the signing CTA', () => {
    const view = deriveSimulationViewV1({ status: 'passed', provider: 'Alchemy', blockNumber: '49089882', ageSeconds: 3, gasUsed: '184000' });
    assert.equal(view.canSign, true);
    assert.equal(view.disabledReason, null);
    assert.match(view.subLabel, /Alchemy · 3s ago/);
  });
});

describe('microcopy', () => {
  test('the replaced strings are exactly the approved wording', () => {
    assert.equal(CONSOLE_COPY_V1.oneAdapterQuoted, "Uniswap didn't answer. Comparing 1 of 2 routes.");
    assert.equal(CONSOLE_COPY_V1.walletDisconnected, 'Connect your wallet to prepare this swap. Miorail can compare routes without it.');
    assert.equal(CONSOLE_COPY_V1.limitsMissing, 'Set a spending limit to continue — it takes one field.');
    assert.equal(CONSOLE_COPY_V1.recipientMissing, 'Miorail will only send to your own wallet unless you add another address.');
    assert.equal(CONSOLE_COPY_V1.portfolioUnavailable, 'Balances didn’t load. Route comparison still works.');
    assert.equal(CONSOLE_COPY_V1.readOnly, 'Read-only until you approve');
    assert.equal(CONSOLE_COPY_V1.nothingSigned, 'Still nothing signed.');
    assert.equal(CONSOLE_COPY_V1.prepared, 'Miorail prepared these calls. Base Account executes them.');
  });

  test('no console copy uses the retired scanner vocabulary or the blocked-until phrasing', () => {
    const banned = /\b(scan|scans|scanning|cockpit|fuel|kill switch|readiness checks)\b/i;
    for (const [key, value] of Object.entries(CONSOLE_COPY_V1)) {
      assert.equal(banned.test(value), false, `${key} must not use retired vocabulary: ${value}`);
    }
  });

  test('a raw failure reason becomes a sentence that says what still works', () => {
    assert.match(consoleFailureCopyV1('no_adapter'), /not built yet/);
    assert.match(consoleFailureCopyV1('provider_not_configured'), /Route comparison still works/);
    assert.equal(consoleFailureCopyV1('some_new_reason'), 'Some new reason');
    assert.equal(consoleFailureCopyV1(null), 'No reason reported.');
  });
});

describe('route graph', () => {
  const model: RouteGraphModelV1 = {
    input: { id: 'in', title: '100 USDC', subtitle: 'your wallet', kind: 'input' },
    pools: [
      { id: 'p1', title: 'Aerodrome USDC/WETH', subtitle: '62% · $4.2M depth', kind: 'pool-a' },
      { id: 'p2', title: 'Uniswap v3 USDC/WETH', subtitle: '38% · $9.8M depth', kind: 'pool-b' },
    ],
    output: { id: 'out', title: '0.03142 ETH', subtitle: 'back to your wallet', kind: 'output' },
    description: 'Route path: 100 USDC splits through two pools into 0.03142 ETH',
  };

  test('describes the data in words for screen readers, in both orientations', () => {
    for (const orientation of ['horizontal', 'vertical'] as const) {
      const rendered = JSON.stringify(RouteGraph({ model, orientation }));
      assert.ok(rendered.includes('"role":"img"'));
      assert.ok(rendered.includes(model.description));
      assert.ok(rendered.includes('Aerodrome USDC/WETH'));
      assert.ok(rendered.includes('0.03142 ETH'));
    }
  });

  test('paints nodes through theme classes, never a hardcoded colour', () => {
    const rendered = JSON.stringify(RouteGraph({ model }));
    assert.ok(rendered.includes('"className":"n-neutral"'));
    assert.ok(rendered.includes('"className":"n-a"'));
    assert.ok(rendered.includes('"className":"n-o"'));
    assert.equal(/#[0-9a-fA-F]{6}/.test(rendered), false, 'no hex colour may appear in the graph markup');
  });
});

describe('limits', () => {
  test('usage percent is clamped and safe against a zero limit', () => {
    assert.equal(usagePercentV1(118, 1000), 12);
    assert.equal(usagePercentV1(2000, 1000), 100);
    assert.equal(usagePercentV1(5, 0), 0);
    assert.equal(usagePercentV1(Number.NaN, 100), 0);
  });
});
