import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import {
  PROVIDER_HISTORY_UNCALIBRATED_NOTE_V1,
  providerHistoryViewV1,
  providerHistoryViewsV1,
  scoringVersionLabelV1,
  type RoutePlanRouteV1,
} from '../src/console/consoleAdapters';

// T67C.1 Part 2 §7 — what the two surfaces say. Both call these helpers, so a
// difference between the web console and the miniapp would have to come from
// here, and here is where it is pinned.

const here = path.dirname(url.fileURLToPath(import.meta.url));

function route(overrides: Partial<RoutePlanRouteV1> = {}): RoutePlanRouteV1 {
  return {
    candidateHash: '0xabc',
    provider: { displayName: 'Uniswap' },
    expectedOutput: { amountDecimal: '1.0', asset: { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006' } },
    minimumOutput: { amountDecimal: '0.99' },
    estimatedGas: { gasUnits: '200000', estimatedCostUsd: '0.01' },
    priceImpact: { percent: '0.1' },
    slippage: { percent: '0.5' },
    quoteAgeSeconds: 3,
    callCount: 2,
    approvalCount: 1,
    pathScore: { scoringVersion: 'swap-path-score/v2', dimensions: [] } as unknown as RoutePlanRouteV1['pathScore'],
    evidence: {},
    ...overrides,
  };
}

const ELIGIBLE_HISTORY: NonNullable<RoutePlanRouteV1['providerHistory']> = {
  status: 'eligible',
  scope: 'personal',
  notScoredReason: null,
  sampleSize: 14,
  requiredSampleSize: 10,
  uniqueWalletCount: 1,
  completedCount: 13,
  failedCount: 1,
  partialFailureCount: 0,
  successRateBps: 9_286,
  medianAdverseShortfallBps: 4,
  p90AdverseShortfallBps: 11,
  floorBreachRateBps: 0,
  medianGasErrorBps: null,
  p90ConfirmationMs: 6_400,
  cutoffAt: '2026-07-27T12:00:00.000Z',
  snapshotHash: `0x${'a'.repeat(64)}`,
  aggregationVersion: 'provider-reliability/v1:w90:p10:n30:u3',
};

describe('the Provider history block', () => {
  test('an eligible personal history reads as separate measurements', () => {
    const view = providerHistoryViewV1(
      route({ providerHistory: ELIGIBLE_HISTORY, calibrationApplied: true, rawNetResult: '1000', historyAdjustedNetResult: '996' }),
    );
    assert.ok(view);
    assert.equal(view.headline, 'Personal history · 14 verified routes');
    const labels = view.rows.map((row) => row.label);
    assert.deepEqual(labels, ['Completed', 'Median shortfall', 'P90 shortfall', 'Floor breaches', 'P90 confirmation', 'Cutoff']);
    assert.equal(view.rows.find((row) => row.label === 'Completed')?.value, '13 / 14');
    assert.equal(view.rows.find((row) => row.label === 'Median shortfall')?.value, '4 bps');
    assert.equal(view.rows.find((row) => row.label === 'P90 shortfall')?.value, '11 bps');
    assert.equal(view.quotedResult, '1000');
    assert.equal(view.historyAdjustedResult, '996');
    assert.equal(view.uncalibratedNote, null);
  });

  test('an insufficient history says how many more routes are needed', () => {
    const view = providerHistoryViewV1(
      route({
        providerHistory: {
          ...ELIGIBLE_HISTORY,
          status: 'not_scored',
          scope: null,
          notScoredReason: 'insufficient_history',
          sampleSize: 8,
          completedCount: null,
          successRateBps: null,
          medianAdverseShortfallBps: null,
          p90AdverseShortfallBps: null,
          floorBreachRateBps: null,
          p90ConfirmationMs: null,
          cutoffAt: null,
          snapshotHash: null,
          aggregationVersion: null,
        },
        calibrationApplied: false,
        rawNetResult: '1000',
      }),
    );
    assert.ok(view);
    assert.equal(view.headline, 'Provider history · Not scored');
    assert.equal(view.rows[0]?.value, '8 · 10 required for personal calibration');
    // The absence is stated, not left blank.
    assert.equal(view.historyAdjustedResult, null);
    assert.equal(view.uncalibratedNote, PROVIDER_HISTORY_UNCALIBRATED_NOTE_V1);
  });

  test('a v1 route produces no block at all', () => {
    // Not an empty history — no history section, because v1 never asked.
    assert.equal(providerHistoryViewV1(route()), null);
    assert.deepEqual(
      providerHistoryViewsV1({ availableRoutes: [route()] } as never),
      [],
    );
  });

  test('nothing in the block is a composite score', () => {
    const view = providerHistoryViewV1(route({ providerHistory: ELIGIBLE_HISTORY, calibrationApplied: true }));
    const rendered = JSON.stringify(view);
    for (const banned of ['/100', 'Reliability 9', 'Safe provider', 'Guaranteed', 'High confidence']) {
      assert.equal(rendered.includes(banned), false, `the history block must not say ${banned}`);
    }
  });
});

describe('the scoring line', () => {
  test('v2 says deterministic scoring, not weighted', () => {
    // Nothing in v2 is weighted: it is one comparison on one figure, or a
    // lexicographic order over separate measurements.
    assert.equal(
      scoringVersionLabelV1({ scoringVersion: 'swap-path-score/v2' } as never),
      'Deterministic scoring · swap-path-score/v2',
    );
  });

  test('v1 keeps its old line, because that is what v1 did', () => {
    assert.equal(
      scoringVersionLabelV1({ scoringVersion: 'swap-path-score/v1' } as never),
      'swap-path-score/v1 · weighted to your goal',
    );
  });
});

describe('both surfaces read the same helper', () => {
  test('the web console and the miniapp call providerHistoryViewsV1', () => {
    for (const file of [
      '../../../artifacts/interface/src/features/console/RouteIntelligenceConsole.tsx',
      '../../../artifacts/miniapp/app/components/MiniConsole.tsx',
    ]) {
      const source = readFileSync(path.join(here, file), 'utf8');
      assert.match(source, /providerHistoryViewsV1\(projection\)/, `${file} must use the shared projection`);
    }
  });

  test('neither surface computes a history figure of its own', () => {
    for (const file of [
      '../../../artifacts/interface/src/features/console/RouteIntelligenceConsole.tsx',
      '../../../artifacts/miniapp/app/components/MiniConsole.tsx',
    ]) {
      const source = readFileSync(path.join(here, file), 'utf8');
      assert.equal(
        /medianAdverseShortfallBps|successRateBps|p90AdverseShortfallBps/.test(source),
        false,
        `${file} must not reach into snapshot statistics directly`,
      );
    }
  });
});
