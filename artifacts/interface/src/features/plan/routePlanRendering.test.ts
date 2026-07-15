import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverlapNotice, RoutePlanView } from '@mioagent/ui';

type Projection = Parameters<typeof RoutePlanView>[0]['projection'];
const hash = `0x${'1'.repeat(64)}`;
const asset = {
  assetId: 'eip155:8453/erc20:usdc', chainId: 8453, kind: 'erc20',
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6,
};
const confidence = { policyVersion: 'path-score-confidence/v1', label: 'high', value: 0.9, reasons: ['quote'] };
const evidence = {
  recordCount: 2, freeEvidenceCount: 2, paidEvidenceCount: 0, paidCostUsd: '0',
  missingEvidence: ['simulation', 'contract_risk'], evidenceTypes: ['quote', 'gas_estimate'],
  status: 'complete', sourceIndependence: 'independent',
};
const pathScore = {
  schemaVersion: 'path-score/v1', id: 'score-ui', tenantId: 'tenant-ui',
  walletAddress: '0x1111111111111111111111111111111111111111', chainId: 8453,
  createdAt: '2026-07-15T12:00:00.000Z', updatedAt: '2026-07-15T12:00:00.000Z', status: 'partially_scored',
  intentHash: hash, candidateHash: hash, evidenceSetHash: hash, pathScoreHash: hash,
  dimensions: [
    { dimension: 'net_result', score: 96, status: 'scored', confidence, sources: [hash], freshness: 'fresh', scoringVersion: 'path-score-v1', missingEvidence: [], notScoredReason: null },
    { dimension: 'quote_freshness', score: 88, status: 'scored', confidence, sources: [hash], freshness: 'fresh', scoringVersion: 'path-score-v1', missingEvidence: [], notScoredReason: null },
    { dimension: 'route_simplicity', score: 92, status: 'scored', confidence, sources: [hash], freshness: 'fresh', scoringVersion: 'path-score-v1', missingEvidence: [], notScoredReason: null },
    { dimension: 'transaction_safety', score: null, status: 'not_scored', confidence: null, sources: [], freshness: 'unknown', scoringVersion: 'path-score-v1', missingEvidence: ['simulation', 'contract_risk'], notScoredReason: 'missing_evidence' },
  ],
};
const route = {
  candidateHash: hash,
  provider: { id: 'kyberswap', displayName: 'KyberSwap', kind: 'aggregator', operator: 'Kyber Network' },
  expectedOutput: { asset, amountAtomic: '251000000', amountDecimal: '251' },
  minimumOutput: { asset, amountAtomic: '249745000', amountDecimal: '249.745' },
  estimatedGas: { gasUnits: '180000', maxFeePerGasWei: '1500000000', estimatedCostNative: '0.00027', estimatedCostUsd: '0.50' },
  priceImpact: { bps: 10, percent: '0.1' }, slippage: { bps: 50, percent: '0.5' },
  quoteObservedAt: '2026-07-15T12:00:00.000Z', quoteExpiresAt: '2026-07-15T12:03:00.000Z', quoteAgeSeconds: 30,
  callCount: 1, approvalCount: 0, pathScore, evidence,
};

function projection(outcome: 'ready' | 'degraded'): Projection {
  return {
    schemaVersion: 'route-plan-projection/v1', projectionHash: hash, evaluationHash: hash,
    routeCardHash: outcome === 'ready' ? hash : null, routeRunId: 'run-ui', outcome,
    reason: outcome === 'ready' ? 'multiple_routes_compared' : 'single_provider_available',
    goalSummary: 'Swap 100 USDC to ETH', optimizationMode: 'best_net_result',
    recommendedRoute: outcome === 'ready' ? route : null,
    availableRoutes: [route], alternatives: [], pathScore: outcome === 'ready' ? pathScore : null,
    comparisonConfidence: { policyVersion: 'swap-route-confidence/v1', label: outcome === 'ready' ? 'high' : 'low', value: outcome === 'ready' ? 0.9 : 0.5, reasons: outcome === 'ready' ? [] : ['single_candidate'] },
    evidenceSummary: evidence, crossCandidateOverlaps: [], providerFailures: outcome === 'ready' ? [] : [{ outcome: 'unavailable', provider: 'uniswap', errorCode: 'uniswap_unavailable', retryable: false }],
    expiresAt: '2026-07-15T12:03:00.000Z', readOnly: true,
  } as unknown as Projection;
}

test('ready Route Card renders canonical dimensions, Not scored, and no overall score', () => {
  const html = renderToStaticMarkup(createElement(RoutePlanView, {
    projection: projection('ready'), now: new Date('2026-07-15T12:00:30.000Z'),
  }));
  for (const label of ['Net result', 'Quote freshness', 'Route simplicity', 'Transaction safety']) assert.match(html, new RegExp(label));
  assert.match(html, /Recommended route/);
  assert.match(html, /Not scored/);
  assert.match(html, /No overall score/);
  assert.match(html, /Read-only route comparison/);
});

test('overlap warning explicitly rejects independent-confirmation wording', () => {
  const html = renderToStaticMarkup(createElement(OverlapNotice, {
    overlaps: [{ sourceKey: 'shared-pool', candidateHashes: [], providerIds: [] }] as never,
  }));
  assert.match(html, /Shared liquidity detected/);
  assert.match(html, /not independent liquidity confirmations/);
});

test('degraded and expired states never render a live recommendation or execution action', () => {
  const degradedHtml = renderToStaticMarkup(createElement(RoutePlanView, {
    projection: projection('degraded'), now: new Date('2026-07-15T12:00:30.000Z'),
  }));
  assert.match(degradedHtml, /No comparative recommendation was made/);
  assert.doesNotMatch(degradedHtml, /Recommended route/);

  const expiredHtml = renderToStaticMarkup(createElement(RoutePlanView, {
    projection: projection('ready'), now: new Date('2026-07-15T12:05:00.000Z'), onRefresh: () => undefined,
  }));
  assert.match(expiredHtml, /Comparison expired/);
  assert.match(expiredHtml, /Stale route/);
  assert.match(expiredHtml, /Refresh routes/);
  assert.doesNotMatch(expiredHtml, /Recommended route/);
  assert.doesNotMatch(expiredHtml, />(Confirm|Execute|Swap|Approve|Review transaction)</);
});
