import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EarnRouteCardView,
  deriveEarnRouteCardViewV1,
  earnUnsupportedReasonLabelV1,
  earnViewMakesUnevidencedRiskClaimV1,
  formatApyBpsV1,
  type EarnComparisonSourceV1,
  type EarnRouteCardSourceV1,
} from '../src/index';

// ---------------------------------------------------------------------------
// T61 §6 — Earn Route Card view model + presentational component. Pure: the
// component is invoked as a function and its element tree JSON-inspected (the
// lib/ui test convention), so there is no DOM/live dependency.
// ---------------------------------------------------------------------------

function comparison(
  protocol: 'moonwell' | 'morpho',
  overrides: Partial<EarnComparisonSourceV1> = {},
): EarnComparisonSourceV1 {
  const netApyBps = protocol === 'morpho' ? 710 : 580;
  const rewardApyBps = protocol === 'moonwell' ? 60 : 0;
  const baseApyBps = protocol === 'morpho' ? 710 : 520;
  const dims = (scoredLiquidity: boolean) => [
    { dimension: 'net_yield', status: 'scored', score: netApyBps / 20, notScoredReason: null, missingEvidence: [] },
    scoredLiquidity
      ? { dimension: 'liquidity', status: 'scored', score: 80, notScoredReason: null, missingEvidence: [] }
      : { dimension: 'liquidity', status: 'not_scored', score: null, notScoredReason: 'insufficient_evidence', missingEvidence: ['liquidity'] },
    { dimension: 'route_simplicity', status: 'scored', score: 90, notScoredReason: null, missingEvidence: [] },
    { dimension: 'transaction_safety', status: 'not_scored', score: null, notScoredReason: 'insufficient_evidence', missingEvidence: ['contract_risk'] },
  ];
  return {
    candidate: {
      candidateHash: `0x${protocol === 'morpho' ? 'b' : 'a'}${'0'.repeat(63)}`,
      protocol,
      venue: {
        identifier: protocol === 'morpho' ? 'Moonwell Flagship USDC (Morpho)' : 'Moonwell USDC',
        address:
          protocol === 'morpho'
            ? '0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca'
            : '0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22',
      },
      withdrawalModel: protocol === 'morpho' ? 'vault_redeem' : 'direct',
      estimatedGas: { estimatedCostUsd: protocol === 'morpho' ? '0.30' : '0.25', gasUnits: '250000' },
      callCount: 2,
      approvalCount: 1,
      // T63A: live provenance travels with every candidate.
      provider: { displayName: protocol === 'morpho' ? 'Morpho API' : 'Moonwell API' },
      observedAt: protocol === 'morpho' ? '2026-07-25T08:45:11.000Z' : '2026-07-25T08:45:16.841Z',
      availableLiquidityAtomic: protocol === 'morpho' ? '9542636897974' : '1214587904145',
      amount: { asset: { symbol: 'USDC', decimals: 6 } },
    },
    apyComposition: { baseApyBps, rewardApyBps, netApyBps },
    liquidityState: protocol === 'morpho' ? 'medium' : 'high',
    freshnessState: 'fresh',
    missingEvidence: ['contract_risk'],
    score: { dimensions: dims(true) },
    ...overrides,
  };
}

const RECOMMENDATION_CARD: EarnRouteCardSourceV1 = {
  optimizationMode: 'best_net_yield',
  amount: { amountDecimal: '500', asset: { symbol: 'USDC' } },
  recommendedCandidateHash: `0x${'b'}${'0'.repeat(63)}`,
  recommendationReason: 'Highest net yield (7.10%) among candidates with fresh yield and scored liquidity.',
  degradedReason: null,
  comparisons: [comparison('moonwell'), comparison('morpho')],
};

const DEGRADED_CARD: EarnRouteCardSourceV1 = {
  optimizationMode: 'lowest_risk',
  amount: { amountDecimal: '500', asset: { symbol: 'USDC' } },
  recommendedCandidateHash: null,
  recommendationReason: null,
  degradedReason: 'Lowest-risk cannot be recommended without contract-risk evidence; transaction safety is Not scored.',
  comparisons: [comparison('moonwell'), comparison('morpho')],
};

describe('T61 Earn Route Card view model', () => {
  test('formatApyBpsV1 renders integer bps as x.xx% and null as an em dash', () => {
    assert.equal(formatApyBpsV1(710), '7.10%');
    assert.equal(formatApyBpsV1(580), '5.80%');
    assert.equal(formatApyBpsV1(0), '0.00%');
    assert.equal(formatApyBpsV1(null), '—');
  });

  test('a recommendation card surfaces the recommended protocol, APY composition, liquidity, withdrawal, gas', () => {
    const view = deriveEarnRouteCardViewV1(RECOMMENDATION_CARD);
    assert.equal(view.status, 'recommendation');
    assert.equal(view.amountLabel, '500 USDC');
    assert.equal(view.optimizationLabel, 'Best net yield');
    assert.equal(view.recommendation?.protocolLabel, 'Morpho');
    assert.equal(view.rows.length, 2);

    const morpho = view.rows.find((r) => r.protocolLabel === 'Morpho')!;
    assert.equal(morpho.isRecommended, true);
    assert.equal(morpho.netApyLabel, '7.10%');
    assert.equal(morpho.baseApyLabel, '7.10%');
    assert.equal(morpho.rewardApyLabel, 'none');
    assert.equal(morpho.liquidityLabel, 'Medium');
    assert.equal(morpho.withdrawalLabel, 'Vault redeem');
    assert.equal(morpho.callsLabel, 'Approve + Deposit');
    assert.equal(morpho.gasLabel, '$0.30');

    const moonwell = view.rows.find((r) => r.protocolLabel === 'Moonwell')!;
    assert.equal(moonwell.isRecommended, false);
    assert.equal(moonwell.rewardApyLabel, '+0.60%');
    assert.equal(moonwell.liquidityLabel, 'High');
    assert.equal(moonwell.withdrawalLabel, 'Direct');
    assert.equal(moonwell.callsLabel, 'Approve + Supply');
  });

  test('transaction_safety is always surfaced as Not scored with its missing evidence', () => {
    const view = deriveEarnRouteCardViewV1(RECOMMENDATION_CARD);
    for (const row of view.rows) {
      const safety = row.dimensions.find((d) => d.key === 'transaction_safety')!;
      assert.equal(safety.scored, false);
      assert.equal(safety.scoreLabel, 'Not scored');
      assert.match(safety.note ?? '', /Contract risk/);
      assert.ok(row.missingEvidenceLabels.includes('Contract risk'));
    }
  });

  test('a card with no recommended candidate is an honest degraded state (no route recommended)', () => {
    const view = deriveEarnRouteCardViewV1(DEGRADED_CARD);
    assert.equal(view.status, 'degraded');
    assert.equal(view.recommendation, null);
    assert.match(view.degradedReason ?? '', /without contract-risk evidence/);
    assert.equal(view.rows.every((r) => r.isRecommended === false), true);
  });

  test('unscored liquidity renders Not scored, never a fabricated value', () => {
    const view = deriveEarnRouteCardViewV1({
      ...RECOMMENDATION_CARD,
      comparisons: [comparison('moonwell', { liquidityState: 'not_scored' }), comparison('morpho')],
    });
    const moonwell = view.rows.find((r) => r.protocolLabel === 'Moonwell')!;
    assert.equal(moonwell.liquidityLabel, 'Not scored');
  });

  test('T63A: each row names its live source, observation time, contract and exact liquidity', () => {
    const view = deriveEarnRouteCardViewV1(RECOMMENDATION_CARD);
    const moonwell = view.rows.find((r) => r.protocolLabel === 'Moonwell')!;
    const morpho = view.rows.find((r) => r.protocolLabel === 'Morpho')!;

    assert.equal(moonwell.sourceLabel, 'Moonwell API');
    assert.equal(moonwell.observedAtLabel, '2026-07-25 08:45 UTC');
    assert.equal(moonwell.contractLabel, '0xedc8…6c22');
    assert.equal(moonwell.liquidityAmountLabel, '1.21M USDC');
    assert.equal(moonwell.isStale, false);
    assert.equal(moonwell.dataWarning, null);

    assert.equal(morpho.sourceLabel, 'Morpho API');
    assert.equal(morpho.liquidityAmountLabel, '9.54M USDC');

    // Card level: both providers named, and the OLDEST reading quoted so the
    // card never looks fresher than its weakest leg.
    assert.equal(view.dataSourceLabel, 'Moonwell API · Morpho API');
    assert.equal(view.lastUpdatedLabel, '2026-07-25 08:45 UTC');
    assert.equal(view.staleWarning, null);
  });

  test('T63A: a stale reading is shown with a warning and never silently dropped', () => {
    const view = deriveEarnRouteCardViewV1({
      ...RECOMMENDATION_CARD,
      comparisons: [comparison('moonwell', { freshnessState: 'stale' }), comparison('morpho')],
    });
    const moonwell = view.rows.find((r) => r.protocolLabel === 'Moonwell')!;
    assert.equal(moonwell.isStale, true);
    assert.equal(moonwell.freshnessLabel, 'Stale');
    assert.match(moonwell.dataWarning ?? '', /excluded from ranking/);
    // The APY it reported is still displayed — stale is not the same as unknown.
    assert.equal(moonwell.netApyLabel, '5.80%');
    assert.match(view.staleWarning ?? '', /Moonwell/);
    assert.match(view.staleWarning ?? '', /excluded from ranking/);
  });

  test('T63A: a missing liquidity datum renders as an em dash, never as zero', () => {
    const view = deriveEarnRouteCardViewV1({
      ...RECOMMENDATION_CARD,
      comparisons: [
        comparison('moonwell', {
          liquidityState: 'not_scored',
          candidate: { ...comparison('moonwell').candidate, availableLiquidityAtomic: null },
        }),
        comparison('morpho'),
      ],
    });
    const moonwell = view.rows.find((r) => r.protocolLabel === 'Moonwell')!;
    assert.equal(moonwell.liquidityAmountLabel, '—');
    assert.equal(moonwell.liquidityLabel, 'Not scored');
  });

  test('T63A: an unsupported reason code is explained, never shown as a bare token', () => {
    assert.match(earnUnsupportedReasonLabelV1('all_providers_unavailable'), /Neither Moonwell nor Morpho/);
    assert.match(earnUnsupportedReasonLabelV1('all_providers_unavailable'), /nothing to compare/);
    // Unknown codes are humanized rather than dropped or invented.
    assert.equal(earnUnsupportedReasonLabelV1('unsupported_earn_request'), 'Unsupported Earn Request');
  });

  test('the honesty guard flags a recommendation that claims low risk while safety is Not scored', () => {
    const view = deriveEarnRouteCardViewV1(RECOMMENDATION_CARD);
    assert.equal(earnViewMakesUnevidencedRiskClaimV1(view), false);

    const spoofed = deriveEarnRouteCardViewV1({
      ...RECOMMENDATION_CARD,
      recommendationReason: 'This is the lowest risk option.',
    });
    assert.equal(earnViewMakesUnevidencedRiskClaimV1(spoofed), true);

    const degraded = deriveEarnRouteCardViewV1(DEGRADED_CARD);
    assert.equal(earnViewMakesUnevidencedRiskClaimV1(degraded), false);
  });
});

describe('T61 EarnRouteCardView component', () => {
  test('recommendation variant renders the recommended banner and both candidates', () => {
    const view = deriveEarnRouteCardViewV1(RECOMMENDATION_CARD);
    const rendered = JSON.stringify(EarnRouteCardView({ view }));
    assert.ok(rendered.includes('"data-earn-card-status":"recommendation"'));
    assert.ok(rendered.includes('Recommended: '));
    assert.ok(rendered.includes('Moonwell'));
    assert.ok(rendered.includes('Morpho'));
    assert.ok(rendered.includes('7.10%')); // recommended net APY, via the row prop
    assert.ok(rendered.includes('Not scored')); // transaction_safety dimension label, via the row prop
    assert.ok(rendered.includes('500 USDC')); // amount label in the header
    // T63A: live provenance is on the card, not just in the payload.
    assert.ok(rendered.includes('Moonwell API · Morpho API'));
    assert.ok(rendered.includes('2026-07-25 08:45 UTC'));
    assert.ok(rendered.includes('1.21M USDC'));
  });

  test('T63A: a stale reading renders its warning banner on the card and the row', () => {
    const view = deriveEarnRouteCardViewV1({
      ...RECOMMENDATION_CARD,
      comparisons: [comparison('moonwell', { freshnessState: 'stale' }), comparison('morpho')],
    });
    const rendered = JSON.stringify(EarnRouteCardView({ view }));
    assert.ok(rendered.includes('"data-earn-stale-warning":"true"'));
    assert.ok(rendered.includes('Some readings are not fresh'));
    // The stale row reaches its candidate card through the row prop.
    assert.ok(rendered.includes('"isStale":true'));
    assert.ok(rendered.includes('excluded from ranking'));
  });

  test('degraded variant renders the honest degraded notice and no recommended banner', () => {
    const view = deriveEarnRouteCardViewV1(DEGRADED_CARD);
    const rendered = JSON.stringify(EarnRouteCardView({ view }));
    assert.ok(rendered.includes('"data-earn-card-status":"degraded"'));
    assert.ok(rendered.includes('"data-earn-degraded":"true"'));
    assert.ok(rendered.includes('No confident recommendation'));
    assert.ok(rendered.includes('without contract-risk evidence'));
    assert.equal(rendered.includes('Recommended: '), false);
  });
});
