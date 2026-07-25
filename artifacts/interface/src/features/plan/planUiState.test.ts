import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { isRoutePlanExpired, routeDisplayLabel, routePlanOutcomeCopy, routePlanSurfaceState } from '@mioagent/ui';
import { commandsForRouteIntelligence, navTabsForRouteIntelligence } from '../../app/routes.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

// The console migration INVERTS the flag: the new interface is the default and
// the seven legacy tabs collapse into two entries — the flow, and proofs. The
// legacy table survives one iteration behind VITE_LEGACY_NAV as the rollback.
test('the console flow is the default navigation; seven tabs collapse into two', () => {
  const tabs = navTabsForRouteIntelligence(true);
  assert.deepEqual(tabs.map((route) => route.path), ['/', '/plan/history']);
  assert.deepEqual(tabs.map((route) => route.label), ['flow', 'proofs']);
  // Rollback path only: with the flag off the legacy cockpit tabs return.
  assert.equal(navTabsForRouteIntelligence(false)[0]?.path, '/');
  assert.equal(navTabsForRouteIntelligence(false).some((route) => route.label === 'cockpit'), true);
});

test('proofs stay reachable, and no command carries an emoji or retired vocabulary', () => {
  const commands = commandsForRouteIntelligence(true);
  assert.equal(commands.some((command) => command.path === '/plan/history'), true);
  assert.equal(commands.length, 2, 'the console exposes exactly two entries');
  for (const command of commands) {
    assert.equal(command.icon, '', 'navigation carries no emoji');
    assert.equal(/\b(scan|cockpit|fuel|kill switch)\b/i.test(command.label), false, command.label);
  }
});

test('T58: RouteHistoryPage is a pure read (no reconcile), PlanPage gates reconciliation on terminal submit + proofId', () => {
  const historySource = readFileSync(path.join(here, 'RouteHistoryPage.tsx'), 'utf8');
  assert.equal(
    /useReconcileRouteProof|useBoundedProofReconciliation/.test(historySource),
    false,
    'the history page must never trigger reconciliation',
  );
  assert.ok(historySource.includes('useRouteHistory'), 'history page must use the shared history hook');
  assert.ok(historySource.includes('ExecutionProofPanel'), 'history page must show the proof panel on selection');

  const planSource = readFileSync(path.join(here, 'PlanPage.tsx'), 'utf8');
  assert.ok(planSource.includes('useBoundedProofReconciliation'), 'PlanPage must use the bounded reconciliation hook');
  assert.ok(/RECONCILABLE_SUBMISSION_STATUSES/.test(planSource), 'reconciliation must be gated on terminal submit statuses');
  assert.ok(/'confirmed', 'failed', 'submitted_unknown'/.test(planSource), 'the terminal statuses must be explicit');
  assert.ok(/submission\.proofId/.test(planSource), 'reconciliation must require a recorded proofId');
  assert.ok(planSource.includes('ExecutionProofPanel'), 'PlanPage must render the proof panel');
});

test('degraded state has no Recommended label and uses honest copy', () => {
  const copy = routePlanOutcomeCopy({ outcome: 'degraded', reason: 'single_provider_available' });
  assert.match(copy.detail, /No comparative recommendation/);
  const label = routeDisplayLabel({ projection: { outcome: 'degraded' }, route: {} as never, expired: false });
  assert.equal(label, 'Available route');
});

test('expired state is derived without automatic refresh', () => {
  assert.equal(isRoutePlanExpired({ expiresAt: '2026-07-15T12:00:00.000Z' }, new Date('2026-07-15T12:00:01.000Z')), true);
  assert.equal(isRoutePlanExpired({ expiresAt: '2026-07-15T12:00:02.000Z' }, new Date('2026-07-15T12:00:01.000Z')), false);
});

test('route plan surface distinguishes idle, loading, clarification and rejection', () => {
  assert.equal(routePlanSurfaceState({ isPending: false, isError: false }), 'idle');
  assert.equal(routePlanSurfaceState({ isPending: true, isError: false }), 'loading');
  assert.equal(routePlanSurfaceState({ isPending: false, isError: true }), 'error');
  assert.equal(routePlanSurfaceState({ isPending: false, isError: false, outcome: 'needs_clarification' }), 'clarification');
  assert.equal(routePlanSurfaceState({ isPending: false, isError: false, outcome: 'rejected' }), 'rejection');
  assert.equal(routePlanSurfaceState({ isPending: false, isError: false, outcome: 'evaluated' }), 'evaluated');
});

test('T59: DeepVerification is gated on a prepared outcome, the paidIntelligence flag, and a server-priced simulationPriceUsdc', () => {
  const planSource = readFileSync(path.join(here, 'PlanPage.tsx'), 'utf8');
  assert.ok(planSource.includes("prepare.data?.outcome === 'prepared'"), 'deepVerification must be gated on a prepared outcome');
  assert.ok(
    planSource.includes('status.data?.productMigration.paidIntelligence'),
    'deepVerification must be gated on the server paidIntelligence flag from useStatus()',
  );
  assert.ok(
    planSource.includes('prepare.data.simulationPriceUsdc'),
    'deepVerification must be gated on a server-priced simulationPriceUsdc (never a client-invented price)',
  );
  assert.ok(planSource.includes('<DeepVerification'), 'PlanPage must render DeepVerification');
  assert.ok(planSource.includes('<SimulateButton'), 'PlanPage must render the paid SimulateButton');
  assert.ok(planSource.includes('deepVerification={deepVerification}'), 'the slot must be threaded into RoutePlanView');
});

test('T59: PlanPage never accepts calldata into the simulate request and only wires the four whitelisted fields', () => {
  const planSource = readFileSync(path.join(here, 'PlanPage.tsx'), 'utf8');
  assert.ok(!/calls\s*:/.test(planSource.split('<SimulateButton')[1]?.split('/>')[0] ?? ''));
  assert.ok(planSource.includes('routeRunId={prepare.data.routeRunId}'));
  assert.ok(planSource.includes('blueprintId={prepare.data.blueprint.id}'));
  assert.ok(planSource.includes('blueprintHash={prepare.data.blueprint.blueprintHash}'));
});
