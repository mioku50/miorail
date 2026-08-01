import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { isRoutePlanExpired, routeDisplayLabel, routePlanOutcomeCopy, routePlanSurfaceState } from '@mioagent/ui';
import { appCommands, navTabs } from '../../app/routes.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

// The scanner-era cockpit is deleted: seven tabs are now two entries, and there
// is no legacy table left to fall back to.
// T67E — three surfaces now, not two. B20 earned its own place because what a
// held token's controls did is not part of any route's flow. Budget & payments
// deliberately did NOT: it is a drawer you open mid-flow, not a place you go.
test('navigation is exactly Routes, B20 and Proofs', () => {
  const tabs = navTabs();
  assert.deepEqual(tabs.map((route) => route.path), ['/', '/b20', '/plan/history']);
  assert.deepEqual(tabs.map((route) => route.label), ['Routes', 'B20', 'Proofs']);
});

test('no payment surface became a tab', () => {
  // The whole point of §2.1: a user has a budget, not a settlement protocol.
  for (const route of navTabs()) {
    assert.equal(
      /x402|spend permission|fuel|payments|budget/i.test(route.label),
      false,
      route.label,
    );
  }
});

test('no command carries an emoji or the retired vocabulary', () => {
  const commands = appCommands();
  assert.equal(commands.length, 3, 'the console exposes exactly three entries');
  assert.equal(commands.some((command) => command.path === '/plan/history'), true);
  assert.equal(commands.some((command) => command.path === '/b20'), true);
  for (const command of commands) {
    assert.equal(command.icon, '', 'navigation carries no emoji');
    assert.equal(/\b(scan|cockpit|fuel|kill switch)\b/i.test(command.label), false, command.label);
  }
});

// T67X-A4: PlanPage is deleted. Its route already redirected into the flow, so
// these properties were being pinned on a file nobody could reach — they now
// point at the console, which is where they actually have to hold.
const consoleSource = () =>
  readFileSync(path.join(here, '../console/RouteIntelligenceConsole.tsx'), 'utf8');

test('T58: RouteHistoryPage is a pure read (no reconcile), the console gates reconciliation on terminal submit + proofId', () => {
  const historySource = readFileSync(path.join(here, 'RouteHistoryPage.tsx'), 'utf8');
  assert.equal(
    /useReconcileRouteProof|useBoundedProofReconciliation/.test(historySource),
    false,
    'the history page must never trigger reconciliation',
  );
  assert.ok(historySource.includes('useRouteHistory'), 'history page must use the shared history hook');
  assert.ok(historySource.includes('ExecutionProofPanel'), 'history page must show the proof panel on selection');

  const source = consoleSource();
  assert.ok(source.includes('useBoundedProofReconciliation'), 'the console must use the bounded reconciliation hook');
  assert.ok(/RECONCILABLE_SUBMISSION_STATUSES/.test(source), 'reconciliation must be gated on terminal submit statuses');
  assert.ok(/'confirmed', 'failed', 'submitted_unknown'/.test(source), 'the terminal statuses must be explicit');
  assert.ok(/submission\.proofId|submission && submission\.proofId/.test(source), 'reconciliation must require a recorded proofId');
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

test('T59: paid simulation is gated on the paidIntelligence flag and a server-priced simulationPriceUsdc', () => {
  const source = consoleSource();
  assert.ok(
    /flags\?\.paidIntelligence === true/.test(source),
    'paid simulation must be gated on the server paidIntelligence flag',
  );
  assert.ok(
    /prepared\?\.simulationPriceUsdc/.test(source),
    'the price must come from the server, never from a client-invented default',
  );
  assert.ok(source.includes('<SimulateButton'), 'the console must render the paid SimulateButton');
  // No price means no button: an unpriced paid action would be a charge the
  // user was never quoted.
  assert.ok(
    /Paid simulation is not configured on this server/.test(source),
    'an unpriced server must say so rather than offering the action',
  );
});

test('T59: the simulate request never accepts calldata and wires only the whitelisted fields', () => {
  const source = consoleSource();
  const props = source.split('<SimulateButton')[1]?.split('/>')[0] ?? '';
  assert.notEqual(props, '', 'the SimulateButton call site must be findable');
  assert.ok(!/calls\s*:/.test(props), 'calldata must never travel in the simulate request');
  assert.ok(props.includes('routeRunId={prepared.routeRunId}'));
  assert.ok(props.includes('blueprintId={prepared.blueprint.id}'));
  assert.ok(props.includes('blueprintHash={prepared.blueprint.blueprintHash}'));
});
