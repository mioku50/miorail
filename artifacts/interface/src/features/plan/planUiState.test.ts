import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { isRoutePlanExpired, routeDisplayLabel, routePlanOutcomeCopy, routePlanSurfaceState } from '@mioagent/ui';
import { commandsForRouteIntelligence, navTabsForRouteIntelligence } from '../../app/routes.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

test('Plan navigation appears first only while route intelligence is enabled', () => {
  assert.equal(navTabsForRouteIntelligence(true)[0]?.path, '/plan');
  assert.equal(navTabsForRouteIntelligence(false).some((route) => route.path === '/plan'), false);
  assert.equal(navTabsForRouteIntelligence(false)[0]?.path, '/');
});

test('T58: /plan/history nav + command exist only behind the flag; legacy /history stays', () => {
  assert.equal(navTabsForRouteIntelligence(true).some((route) => route.path === '/plan/history'), true);
  assert.equal(navTabsForRouteIntelligence(false).some((route) => route.path === '/plan/history'), false);
  assert.equal(commandsForRouteIntelligence(true).some((command) => command.path === '/plan/history'), true);
  assert.equal(commandsForRouteIntelligence(false).some((command) => command.path === '/plan/history'), false);
  // Legacy /history (chat + inbox) must remain reachable regardless of flag.
  assert.equal(commandsForRouteIntelligence(false).some((command) => command.path === '/history'), true);
  assert.equal(commandsForRouteIntelligence(true).some((command) => command.path === '/history'), true);
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
