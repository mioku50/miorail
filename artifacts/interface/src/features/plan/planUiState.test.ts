import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { isRoutePlanExpired, routeDisplayLabel, routePlanOutcomeCopy, routePlanSurfaceState } from '@mioagent/ui';
import { CONSOLE_PRIMARY_SECTIONS_V1, CONSOLE_SECTION_TABLE_V1 } from '@mioagent/ui';
import { appCommands, navTabs } from '../../app/routes.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

// T70 §1/§8 — four surfaces, and Opportunities leads.
//
// The order is the claim. Routes answers "how do I do the thing I already
// decided on"; Opportunities answers "what should I look at", which is the
// earlier question and the one a user arrives with. Portfolio came out from
// behind a technical tab called B20 at the same time.
//
// Both tables are DERIVED from the shared section table in lib/ui, so this test
// also pins that the web app has no navigation vocabulary of its own.
test('advanced navigation names the evidence index, B20 controls and Routes AI', () => {
  const tabs = navTabs();
  assert.deepEqual(tabs.map((route) => route.path), [
    '/opportunities',
    '/portfolio',
    '/routes',
  ]);
  // Named for what each surface CONTAINS. "Opportunities" described the shape
  // of a list and "Portfolio" the generic category, and neither told a user
  // which flow they were in — the compact bar had already said "B20" for the
  // second one since it was built.
  //
  // The first is "Discover" rather than "Discover B20" since Phase 6: it opens
  // on the official corpus — assets an issuer publishes — and the B20 launch
  // feed sits a page deeper at /opportunities/launches. Keeping "B20" in the
  // label would name the whole surface after the half that moved.
  //
  // Activity (was Proofs) moved to the drawer: it is a viewer for records this
  // deployment has never produced, and a bar of three working surfaces beats
  // four where one is empty.
  assert.deepEqual(tabs.map((route) => route.label), ['Evidence index', 'B20 controls', 'Routes AI']);
});

test('the web tabs come from the shared table, not from a list typed here', () => {
  // §9.9 — the mechanism, not just the current output. If somebody adds a fifth
  // label by hand, this fails even if the four above still match.
  for (const route of navTabs()) {
    const section = CONSOLE_PRIMARY_SECTIONS_V1.find(
      (id) => CONSOLE_SECTION_TABLE_V1[id].label === route.label,
    );
    assert.ok(section, `${route.label} is not a shared section label`);
    assert.equal(route.path, CONSOLE_SECTION_TABLE_V1[section].path);
  }
});

test('no payment surface became a tab', () => {
  // A user has a budget, not a settlement protocol. Budget & payments is on
  // Settings, which is in the drawer and the palette — never the header.
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
  // Nine: the three primary sections plus Market Reality, Radar, Investigate,
  // Activity, Extensions and Settings, which the palette reaches and the
  // header deliberately does not. None of the five belongs in the tab bar —
  // each is entered with something you already have, an address or a company —
  // and a wider bar would push every label into an ellipsis at 390px to make
  // room for the surfaces used least often.
  assert.equal(commands.length, 9, 'the console exposes exactly nine entries');
  assert.equal(commands.some((command) => command.path === '/plan/history'), true);
  assert.equal(commands.some((command) => command.path === '/portfolio'), true);
  assert.equal(commands.some((command) => command.path === '/opportunities'), true);
  assert.equal(commands.some((command) => command.path === '/market'), true);
  assert.equal(commands.some((command) => command.path === '/radar'), true);
  assert.equal(commands.some((command) => command.path === '/settings'), true);
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
  assert.ok(historySource.includes('ActivityProofCard'), 'history page must show the proof on selection');
  // The page rendered outside ConsoleShell for two releases, so opening the
  // tab removed the tab bar and left one back link as the only way out.
  assert.ok(historySource.includes('ConsoleShell'), 'Activity must render inside the console shell');
  // The paid ledger is the one thing this product has provably completed, and
  // it was invisible while the page showed only unsigned route runs.
  assert.ok(historySource.includes('useX402Ledger'), 'Activity must show what was actually paid');

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
  // user was never quoted. The sentence in its place says the surface was
  // WITHDRAWN, not misconfigured — Miorail stopped charging for swap
  // simulation, and "not configured" would send someone hunting for a fix that
  // does not exist.
  assert.ok(
    /no longer charges for swap simulation/.test(source),
    'an unpriced server must say why, and not imply a broken setup',
  );
  assert.ok(
    !/not configured on this server/.test(source),
    'the withdrawn surface must not be described as a misconfiguration',
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
