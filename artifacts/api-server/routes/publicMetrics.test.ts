import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';

import { publicMetricsSnapshotFromCountsV1 } from '../lib/publicMetrics.js';
import { clearPublicMetricsCacheForTestsV1, publicMetricsRouter, publicMetricsRuntime } from './publicMetrics.js';

test('public metrics is readable without a tenant session', async (t) => {
  const previousRead = publicMetricsRuntime.read;
  const previousNow = publicMetricsRuntime.now;
  t.after(() => {
    publicMetricsRuntime.read = previousRead;
    publicMetricsRuntime.now = previousNow;
    clearPublicMetricsCacheForTestsV1();
  });
  publicMetricsRuntime.now = () => new Date('2026-08-14T12:00:00.000Z');
  publicMetricsRuntime.read = async (now) => publicMetricsSnapshotFromCountsV1({
    routesEvaluated: 1,
    routesExecuted: 1,
    routeProofsVerified: 1,
    routeProofsCompleted: 1,
    x402SpentUsdc: '0',
    x402IntelligencePurchased: 0,
    x402IntelligenceSold: 0,
    b20LaunchesMeasured: 4,
    uniqueBaseWallets: 1,
  }, now ?? new Date('2026-08-14T12:00:00.000Z'));
  clearPublicMetricsCacheForTestsV1();

  const app = express();
  app.use('/api/public', publicMetricsRouter);
  const response = await request(app).get('/api/public/metrics').expect(200);
  assert.equal(response.body.snapshot.schemaVersion, 'public-metrics/v1');
  assert.equal(response.body.snapshot.metrics.routeProofsVerified.value, 1);
  assert.match(String(response.headers['cache-control']), /max-age=30/);
});
