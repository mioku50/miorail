import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PUBLIC_METRICS_DEFINITIONS_VERSION_V1,
  PublicMetricsSnapshotV1Schema,
  hashPublicMetricsSnapshotV1,
  sealPublicMetricsSnapshotV1,
} from '../src/index.js';

function draft() {
  return {
    schemaVersion: 'public-metrics/v1' as const,
    definitionsVersion: PUBLIC_METRICS_DEFINITIONS_VERSION_V1,
    chainId: 8453 as const,
    window: { kind: 'all_time' as const, through: '2026-08-14T00:00:00.000Z' },
    metrics: {
      routesEvaluated: { value: 33, status: 'measured' as const },
      routesExecuted: { value: 3, status: 'measured' as const },
      routeProofsVerified: { value: 2, status: 'measured' as const },
      x402UsdcSpent: { value: null, status: 'not_available' as const },
      x402IntelligencePurchased: { value: 0, status: 'zero' as const },
      x402IntelligenceSold: { value: 0, status: 'zero' as const },
      b20LaunchesMeasured: { value: 3981, status: 'measured' as const },
      uniqueBaseWallets: { value: null, status: 'suppressed' as const },
      executionSuccessRate: { valueBps: 10_000, numerator: 2, denominator: 2, status: 'measured' as const },
    },
    definitions: {
      routesEvaluated: 'a',
      routesExecuted: 'b',
      routeProofsVerified: 'c',
      x402UsdcSpent: 'd',
      x402IntelligencePurchased: 'e',
      x402IntelligenceSold: 'f',
      b20LaunchesMeasured: 'g',
      uniqueBaseWallets: 'h',
      executionSuccessRate: 'i',
    },
    caveats: ['Counts are database-backed and carry named definitions.'],
  };
}

test('public metrics snapshot has a deterministic stable hash and serialization', () => {
  const first = sealPublicMetricsSnapshotV1(draft());
  const second = sealPublicMetricsSnapshotV1(JSON.parse(JSON.stringify(draft())));
  assert.deepEqual(first, second);
  assert.equal(first.snapshotHash, hashPublicMetricsSnapshotV1(first));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('public metrics refuses a rate that does not match its evidence counts', () => {
  const value = sealPublicMetricsSnapshotV1(draft());
  const broken = {
    ...value,
    metrics: { ...value.metrics, executionSuccessRate: { ...value.metrics.executionSuccessRate, valueBps: 5000 } },
  };
  assert.equal(PublicMetricsSnapshotV1Schema.safeParse(broken).success, false);
});
