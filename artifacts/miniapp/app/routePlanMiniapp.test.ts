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
