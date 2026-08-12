import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { routePlanMiniappState } from './components/RoutePlanHome.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

test('miniapp route plan requires the current Base wallet to match the signed session', () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  assert.equal(routePlanMiniappState.routeSessionMatches(wallet, wallet, 8453), true);
  assert.equal(routePlanMiniappState.routeSessionMatches(wallet, wallet, 84532), false);
  assert.equal(
    routePlanMiniappState.routeSessionMatches(wallet, '0x2222222222222222222222222222222222222222', 8453),
    false,
  );
});

test('T58: miniapp history page is a flag+session-gated pure read; RoutePlanHome wires bounded reconciliation', () => {
  const historySource = readFileSync(path.join(here, 'history', 'page.tsx'), 'utf8');
  assert.ok(historySource.includes('routeIntelligenceV1'), 'history page must gate on the server-derived flag');
  assert.ok(historySource.includes('useSession'), 'history page must require a signed session');
  assert.ok(historySource.includes('useRouteHistory'), 'history page must use the shared history hook');
  assert.ok(historySource.includes('ExecutionProofPanel'), 'history page must show the proof panel on selection');
  assert.equal(
    /useReconcileRouteProof|useBoundedProofReconciliation/.test(historySource),
    false,
    'the history page must never trigger reconciliation',
  );

  const homeSource = readFileSync(path.join(here, 'components', 'RoutePlanHome.tsx'), 'utf8');
  assert.ok(homeSource.includes('useBoundedProofReconciliation'), 'RoutePlanHome must use the bounded hook');
  assert.ok(/RECONCILABLE_SUBMISSION_STATUSES/.test(homeSource), 'reconciliation must be gated on terminal statuses');
  assert.ok(/submission\.proofId/.test(homeSource), 'reconciliation must require a recorded proofId');
  assert.ok(homeSource.includes('href="/history"'), 'RoutePlanHome must link to the history page');
});

test('T59: RoutePlanHome gates DeepVerification on sessionReady + prepared + paidIntelligence + a server-priced simulationPriceUsdc', () => {
  const homeSource = readFileSync(path.join(here, 'components', 'RoutePlanHome.tsx'), 'utf8');
  assert.ok(homeSource.includes('sessionReady && prepare.data?.outcome === "prepared"'), 'deepVerification must require this surface\'s own session gate AND a prepared outcome');
  assert.ok(
    homeSource.includes('status.data?.productMigration.paidIntelligence'),
    'deepVerification must be gated on the server paidIntelligence flag from useStatus()',
  );
  assert.ok(
    homeSource.includes('prepare.data.simulationPriceUsdc'),
    'deepVerification must be gated on a server-priced simulationPriceUsdc (never a client-invented price)',
  );
  assert.ok(homeSource.includes('<DeepVerification'), 'RoutePlanHome must render DeepVerification');
  assert.ok(homeSource.includes('<SimulateButton'), 'RoutePlanHome must render the paid SimulateButton');
  assert.ok(homeSource.includes('deepVerification={deepVerification}'), 'the slot must be threaded into RoutePlanView');
});

test('T59: miniapp SimulateButton wiring never sends calldata and only wires the four whitelisted fields', () => {
  const homeSource = readFileSync(path.join(here, 'components', 'RoutePlanHome.tsx'), 'utf8');
  const simulateBlock = homeSource.split('<SimulateButton')[1]?.split('/>')[0] ?? '';
  assert.ok(!/calls\s*:/.test(simulateBlock));
  assert.ok(homeSource.includes('routeRunId={prepare.data.routeRunId}'));
  assert.ok(homeSource.includes('blueprintId={prepare.data.blueprint.id}'));
  assert.ok(homeSource.includes('blueprintHash={prepare.data.blueprint.blueprintHash}'));
});

test('B20 entry in Base App uses the shared proof flow and exact atomic Base Account calls', () => {
  const source = readFileSync(path.join(here, 'components', 'MiniConsole.tsx'), 'utf8');
  assert.ok(source.includes('useB20PrepareEntry'));
  assert.ok(source.includes('useB20BeginEntrySubmission'));
  assert.ok(source.includes('useB20ReconcileEntrySubmission'));
  assert.ok(source.includes('<B20EntryReviewCard'));
  assert.ok(source.includes('calls: begun.payload.calls'));
  assert.ok(source.includes('forceAtomic: begun.payload.atomicRequired'));
  assert.ok(source.includes('transactionHashesFromReceipts'));
  assert.ok(source.includes('onBuildEntryPlan={buildB20EntryPlan}'));
});
