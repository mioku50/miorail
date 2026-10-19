import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ProofScreen,
  ReviewScreen,
  RouteScreen,
  type ReviewScreenModelV1,
  type RouteScreenModelV1,
} from '../src/console/ConsoleScreens';
import { B20ControlSection, b20ControlSummaryV1, type B20CardLikeV1, type B20WatchLikeV1 } from '../src/console/B20Panels';
import { ActivityProofCard, ActivityRunsCard, mergeActivityRunsV1, type ActivityRunRowV1 } from '../src/console/ActivityPanels';
import { reviewBalanceViewV1, reviewCallRowsV1 } from '../src/console/giftView';

void React;

// ---------------------------------------------------------------------------
// 2026-10-19, two swaps on the web console: «очень много всего показывает у
// нас при свапе и нужно догадываться прокручивать вниз для одобрения и
// подписания». Review and Confirm sat under screens of evidence; the balance
// table said the simulation saw no movement; the approval read "spend exactly
// 7000000"; and in Activity a clicked run opened its proof below the whole
// list, out of sight.
// ---------------------------------------------------------------------------

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const STOCK = `0x${'b2'.repeat(20)}`;

function route(overrides: Partial<RouteScreenModelV1> = {}): RouteScreenModelV1 {
  return {
    steps: [],
    eyebrow: 'Recommended route',
    amount: '7.423228',
    unit: 'USDC',
    usd: '',
    providerLabel: 'KyberSwap',
    freshness: { label: 'quote 0s', tone: 'n' },
    why: 'Highest expected output after network and intelligence costs.',
    kpis: [],
    graph: null,
    graphUnavailableReason: 'no pool breakdown',
    graphLegend: [],
    simulatedPill: { label: 'not simulated yet', tone: 'n' },
    scoreRows: [],
    scoringVersion: 'swap-path-score/v2',
    providerHistory: [],
    candidates: [],
    onReview: () => {},
    onSelectCandidate: () => {},
    reviewDisabledReason: null,
    diagnostics: [],
    claimHeadline: null,
    onCompareAgain: () => {},
    comparePending: false,
    onChangeGoal: () => {},
    ...overrides,
  } as RouteScreenModelV1;
}

function review(overrides: Partial<ReviewScreenModelV1> = {}): ReviewScreenModelV1 {
  return {
    steps: [],
    calls: [],
    simulation: {
      available: true,
      passed: true,
      headline: 'Simulation passed on Base mainnet 8453',
      detail: '',
      subLabel: 'block 52813881 · 2s ago',
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
    signSlot: <button type="button" className="btn lg">Confirm in your wallet</button>,
    ...overrides,
  };
}

const CARD: B20CardLikeV1 = {
  tokenAddress: STOCK,
  displayName: 'Sony Group Corporation',
  displaySymbol: 'SONYc',
  variant: 'asset',
  detectionOutcome: 'b20',
  blockNumber: '52813790',
  blockHash: `0x${'be'.repeat(32)}`,
  observedAt: '2026-10-19T13:36:00.000Z',
  fields: [],
  statements: [
    { key: 'pause', statement: 'Whoever holds PAUSE_ROLE can pause transfers of this token.', observedState: 'unconstrained', evidenceHash: null },
    { key: 'burn', statement: 'Whoever holds BURN_BLOCKED_ROLE can burn a denied balance.', observedState: 'constrained', evidenceHash: null },
    { key: 'policy', statement: 'Transfers can be gated by a policy.', observedState: 'constrained', evidenceHash: null },
    { key: 'mint', statement: 'Whoever holds MINT_ROLE can create new supply.', observedState: 'unconstrained', evidenceHash: null },
    { key: 'meta', statement: 'Whoever holds METADATA_ROLE can rename it.', observedState: 'unknown', evidenceHash: null },
    { key: 'rebase', statement: 'Whoever holds OPERATOR_ROLE can change the multiplier.', observedState: 'unconstrained', evidenceHash: null },
  ],
  unavailable: [],
  boundaries: ['Holders and holder concentration are not read.'],
};

const QUIET: B20WatchLikeV1 = {
  tokenAddress: STOCK,
  fromBlock: '52800152',
  toBlock: '52813790',
  changes: [],
  gaps: [],
  status: 'compared',
  notComparableReason: null,
};

describe('the action stays on screen', () => {
  test('Review and Confirm are docked, on both swap screens', () => {
    const card = renderToStaticMarkup(<RouteScreen {...route()} />);
    assert.match(card, /<div class="ctarow cta-dock"><button type="button" class="btn lg">Review transaction<\/button>/);
    const sign = renderToStaticMarkup(<ReviewScreen {...review()} />);
    assert.match(sign, /<div class="ctarow cta-dock"><button type="button" class="btn lg">Confirm in your wallet<\/button>/);
  });

  test('how the routes were compared folds under what it found, and opens when a provider can be asked again', () => {
    const closed = renderToStaticMarkup(<RouteScreen {...route()} />);
    assert.match(closed, /<details class="evidence-fold"><summary><span class="evidence-fold-k">How the routes were compared<\/span>/);
    assert.match(closed, /0 considered · 0 quotable · path score 0 of 0 dimensions scored/);
    assert.ok(closed.indexOf('Path score') > closed.indexOf('evidence-fold'), 'the score is inside the fold');
    const retry = renderToStaticMarkup(
      <RouteScreen
        {...route({
          diagnostics: [
            { provider: 'Aerodrome', result: 'unavailable', reason: 'unreachable', detail: null, age: '—', output: null, retryable: true },
          ],
        })}
      />,
    );
    assert.match(retry, /<details class="evidence-fold" open="">/);
  });
});

describe('token controls fold to a reading of them', () => {
  test('the line counts the read states and says nothing changed', () => {
    assert.deepEqual(b20ControlSummaryV1(CARD, QUIET), {
      line: 'Sony Group Corporation (SONYc) · asset · 6 controls: 3 currently open, 2 currently constrained, 1 not observed · no change since block 52800152',
      open: false,
    });
  });

  test('a change since the last reading opens the fold rather than being summarised', () => {
    const changed: B20WatchLikeV1 = {
      ...QUIET,
      changes: [{
        kind: 'role_granted', fieldKey: 'pause', label: 'Pause', severity: 'acute', before: 'none', after: 'granted',
        detail: 'A pauser was added.', evidenceBefore: null, evidenceAfter: null,
      }],
    };
    const summary = b20ControlSummaryV1(CARD, changed);
    assert.equal(summary.open, true);
    assert.match(summary.line, /1 changed since block 52800152$/);
    const html = renderToStaticMarkup(<B20ControlSection card={CARD} watch={changed} folded detailed />);
    assert.match(html, /^<details class="evidence-fold" open=""><summary><span class="evidence-fold-k">Token controls<\/span>/);
  });

  test('folded, every panel is still there behind the line', () => {
    const html = renderToStaticMarkup(<B20ControlSection card={CARD} watch={QUIET} folded detailed />);
    assert.match(html, /^<details class="evidence-fold"><summary>/);
    for (const text of ['What these controls permit', 'Control watch', 'What this card does not cover']) {
      assert.ok(html.includes(text), text);
    }
    assert.doesNotMatch(renderToStaticMarkup(<B20ControlSection card={CARD} watch={QUIET} />), /evidence-fold/);
  });
});

describe('the review says what the swap moves', () => {
  const expected = [
    { asset: { symbol: 'USDC', decimals: 6 }, direction: 'debit' as const, amountAtomic: '7000000', minimumAmountAtomic: null },
    {
      asset: { symbol: 'SONYc', decimals: 18 },
      direction: 'credit' as const,
      amountAtomic: '282178560000000000',
      minimumAmountAtomic: '280767670000000000',
    },
  ];

  test('without a paid simulation, the quote’s amounts, and no claim about the simulation', () => {
    const balances = reviewBalanceViewV1({ simulatedChanges: null, expectedChanges: expected, simulationAvailable: true });
    assert.equal(balances.title, 'Balance changes');
    assert.equal(balances.basis, 'from the quote');
    assert.deepEqual(balances.rows.map((row) => row.change), ['−7 USDC', '+0.28217856 SONYc · at least 0.28076767']);
    const html = renderToStaticMarkup(
      <ReviewScreen
        {...review({
          balanceTitle: balances.title,
          balanceBasis: balances.basis,
          balanceChanges: balances.rows,
          balanceUnavailableReason: balances.unavailableReason,
        })}
      />,
    );
    assert.match(html, /<h3>Balance changes<\/h3><span class="sub">from the quote · block 52813881 · 2s ago<\/span>/);
    assert.doesNotMatch(html, /no decodable asset movement|<th>Before<\/th>/);
  });

  test('a paid simulation’s decoded movements still come first', () => {
    const balances = reviewBalanceViewV1({
      simulatedChanges: [{ address: USDC, summary: 'wallet sends 7000000 of 0x8335…2913' }],
      expectedChanges: expected,
      simulationAvailable: true,
    });
    assert.equal(balances.title, 'Simulated balance changes');
    assert.equal(balances.basis, null);
    assert.equal(balances.rows.length, 1);
  });

  test('an approval reads in its token’s units, by its router’s name, with both addresses kept', () => {
    const [approval] = reviewCallRowsV1({
      calls: [{
        callType: 'approval', to: USDC, spender: ROUTER, recipient: null, amountAtomic: '7000000',
        asset: { symbol: 'USDC', decimals: 6 },
      }],
      quoteExpiry: '2026-10-19T13:48:28.000Z',
      spenderName: 'KyberSwap',
    });
    assert.equal(approval!.title, 'Allow KyberSwap to spend exactly 7 USDC');
    assert.equal(approval!.detail, `spender ${ROUTER} · token ${USDC} · exact amount, no unlimited approval`);
  });
});

describe('Activity opens a proof where it was asked for', () => {
  const run = (id: string, createdAt: string, proofFinalStatus: string | null = null): ActivityRunRowV1 => ({
    routeRunId: id,
    createdAt,
    runStatus: 'ready',
    intentSummary: `swap ${id}`,
    provider: 'kyberswap',
    proofId: proofFinalStatus ? `route-proof:${id}` : null,
    proofFinalStatus,
  });

  test('the open run’s proof is under its own row, and its button stays live', () => {
    const runs = [run('a', '2026-10-19T13:38:42Z', 'completed'), run('b', '2026-10-19T13:36:52Z', 'completed'), run('c', '2026-10-19T08:00:00Z')];
    const html = renderToStaticMarkup(
      <ActivityRunsCard
        loading={false}
        runs={runs}
        selectedRunId="b"
        onSelect={() => {}}
        selectedDetail={<p className="lnote">THE PROOF</p>}
        hasMore={false}
        unavailableReason={null}
      />,
    );
    const proofAt = html.indexOf('THE PROOF');
    assert.ok(proofAt > html.indexOf('swap b') && proofAt < html.indexOf('swap c'), 'under b, above c');
    assert.match(html, /<button type="button" class="btn sec" aria-expanded="true">swap b<\/button>/);
    assert.doesNotMatch(html, /disabled/);
  });

  test('a run read again takes its newer reading, and new runs join newest first', () => {
    const before = [run('b', '2026-10-19T13:36:52Z', 'completed'), run('a', '2026-10-19T13:38:42Z', 'pending')];
    const merged = mergeActivityRunsV1(before, [run('new', '2026-10-19T14:00:00Z', 'pending'), run('a', '2026-10-19T13:38:42Z', 'completed')]);
    assert.deepEqual(merged.map((item) => `${item.routeRunId}:${item.proofFinalStatus}`), ['new:pending', 'a:completed', 'b:completed']);
  });

  test('a proof can be saved from Activity and from its own screen, once there is one', () => {
    const card = renderToStaticMarkup(
      <ActivityProofCard
        runLabel="swap a"
        loading={false}
        proof={{
          finalStatus: 'completed',
          reconciliationState: 'matched',
          provider: 'kyberswap',
          expectedOutput: { amountAtomic: '282178560000000000', asset: { symbol: 'SONYc', decimals: 18 } },
          actualOutput: '282178560000000000',
          outputDeviationBps: 0,
          minimumSatisfied: true,
          transactionHashes: [],
          blueprintHash: `0x${'1'.repeat(64)}`,
          approvedCallsHash: `0x${'2'.repeat(64)}`,
        }}
        lifecycle="completed"
        unavailableReason={null}
        onExport={() => {}}
      />,
    );
    assert.match(card, />Export proof<\/button>/);
    const base = {
      steps: [], eyebrow: 'Route proof · reconciling', amount: '—', unit: '', usd: '',
      headlinePill: { label: 'reconciling with the chain', tone: 'n' as const }, why: 'why', kpis: [], timeline: [],
      planVsActual: [], record: [], onNewGoal: () => undefined,
    };
    assert.match(renderToStaticMarkup(<ProofScreen {...base} onExport={null} />), /<button type="button" class="btn sec" disabled="">Export proof<\/button>/);
    assert.match(renderToStaticMarkup(<ProofScreen {...base} onExport={() => undefined} />), /<button type="button" class="btn sec">Export proof<\/button>/);
  });
});
