import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PublicMetricsSnapshotV1Schema } from '@mioagent/route-domain';
import { publicMetricsSnapshotFromCountsV1 } from './publicMetrics.js';

test('public metrics exposes only reconciled proofs in its success rate', () => {
  const snapshot = publicMetricsSnapshotFromCountsV1({
    routesEvaluated: 12,
    routesExecuted: 5,
    routeProofsVerified: 4,
    routeProofsCompleted: 3,
    x402SpentUsdc: '0.012000',
    x402IntelligencePurchased: 2,
    x402IntelligenceSold: 7,
    b20LaunchesMeasured: 91,
    uniqueBaseWallets: 9,
  }, new Date('2026-08-14T12:00:00.000Z'));

  assert.equal(snapshot.metrics.executionSuccessRate.valueBps, 7500);
  assert.equal(snapshot.metrics.x402UsdcSpent.value, '0.012');
  assert.equal(snapshot.metrics.uniqueBaseWallets.value, 9);
  assert.equal(PublicMetricsSnapshotV1Schema.safeParse(snapshot).success, true);
});

test('public metrics suppresses a small wallet cohort and never invents an empty rate', () => {
  const snapshot = publicMetricsSnapshotFromCountsV1({
    routesEvaluated: 0,
    routesExecuted: 0,
    routeProofsVerified: 0,
    routeProofsCompleted: 0,
    x402SpentUsdc: '0',
    x402IntelligencePurchased: 0,
    x402IntelligenceSold: 0,
    b20LaunchesMeasured: 0,
    uniqueBaseWallets: 1,
  }, new Date('2026-08-14T12:00:00.000Z'));

  assert.deepEqual(snapshot.metrics.uniqueBaseWallets, { value: null, status: 'suppressed' });
  assert.deepEqual(snapshot.metrics.executionSuccessRate, {
    valueBps: null,
    numerator: 0,
    denominator: 0,
    status: 'not_available',
  });
});

// ---------------------------------------------------------------------------
// The public USDC total, as a ledger rule rather than a sum.
//
// The query is SQL against production tables, so these read its text. Crude,
// and the only thing that catches the defect that was here: the canonical pair
// was checked inside ONE arm of a CASE, so a legacy receipt carrying a decimal
// `cost` was added to a figure labelled Base USDC without its network or its
// asset ever being read — and because that arm came first, it also won over
// the receipt's own atomic amount.
// ---------------------------------------------------------------------------

/** This package declares no `"type"`, so `module: NodeNext` typechecks it as
 * CommonJS and rejects `import.meta` — the same helper every other source-text
 * test in this directory uses. */
function packageFileV1(relative: string): string {
  const cwd = process.cwd();
  return cwd.endsWith(`${path.sep}artifacts${path.sep}api-server`)
    ? path.join(cwd, relative)
    : path.join(cwd, 'artifacts/api-server', relative);
}

const SOURCE_V1 = readFileSync(packageFileV1('lib/publicMetrics.ts'), 'utf8');

function spendCteV1(): { whereClause: string; caseBody: string } {
  const start = SOURCE_V1.indexOf('production_x402_spend AS (');
  assert.ok(start > 0, 'the spend CTE must still be named production_x402_spend');
  const body = SOURCE_V1.slice(start, SOURCE_V1.indexOf('wallets AS (', start));
  const whereAt = body.indexOf('WHERE');
  assert.ok(whereAt > 0, 'the spend CTE must filter its rows');
  return { whereClause: body.slice(whereAt), caseBody: body.slice(0, whereAt) };
}

test('the canonical Base USDC pair binds every branch, not one arm of the CASE', () => {
  const { whereClause } = spendCteV1();
  assert.match(whereClause, /receipt->>'network' = 'eip155:8453'/);
  assert.match(whereClause, /lower\(receipt->>'asset'\) = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'/);
});

test('the facilitator atomic amount is read before a legacy decimal cost', () => {
  const { caseBody } = spendCteV1();
  const atomicAt = caseBody.indexOf("receipt->>'amount' ~ ");
  const costAt = caseBody.indexOf("receipt->>'cost' ~ ");
  assert.ok(atomicAt > 0 && costAt > 0, 'both readings must still exist');
  assert.ok(
    atomicAt < costAt,
    'an unambiguous atomic integer must win over a decimal a legacy path wrote',
  );
  // Anything neither branch can read is worth nothing to a public total.
  assert.match(caseBody, /ELSE 0::numeric/);
});

test('developer smoke traffic and incoming revenue stay out of the spent total', () => {
  const { whereClause } = spendCteV1();
  assert.match(whereClause, /receipt->>'direction' = 'outgoing_buyer_payment'/);
  assert.match(whereClause, /<> 'dev_smoke'/);
  assert.match(whereClause, /receipt->>'status' = 'settled'/);
});

test('a purchased intelligence charge is one that actually delivered evidence', () => {
  // `route_run_id` is NOT NULL on this table, so it distinguishes nothing. The
  // definition claims delivery, and `evidence_id` is what delivery means.
  assert.match(
    SOURCE_V1,
    /FROM intelligence_charges\s*\n?\s*WHERE status = 'settled' AND evidence_id IS NOT NULL/,
  );
});
