import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ROUTE_PROOF_EXPORT_SCHEMA_V1, routeProofExportV1 } from './exportProof';

const here = path.dirname(fileURLToPath(import.meta.url));

test('a proof is exported as what the server returned, under the name its screen gives it', () => {
  const proof = { proofId: 'route-proof:0d4c1b2243cf2c10', finalStatus: 'completed' };
  const events = [{ eventType: 'submitted' }, { eventType: 'completed' }];
  const file = routeProofExportV1({ proof, lifecycle: 'completed', events, now: new Date('2026-10-19T14:00:00.000Z') });
  assert.equal(file.fileName, 'miorail-proof-1b2243cf2c10.json');
  assert.deepEqual(JSON.parse(file.json), {
    schemaVersion: ROUTE_PROOF_EXPORT_SCHEMA_V1,
    exportedAt: '2026-10-19T14:00:00.000Z',
    proof,
    lifecycle: 'completed',
    events,
  });
});

test('"Export proof" saves the proof on both pages instead of leaving for Activity', () => {
  // 2026-10-19: the proof screen's Export opened Activity, and Activity
  // exported nothing either.
  const console = readFileSync(path.join(here, '../console/RouteIntelligenceConsole.tsx'), 'utf8');
  assert.doesNotMatch(console, /onExport=\{\(\) => consoleNav\.navigate\('activity'\)\}/);
  assert.match(console, /downloadRouteProofV1\(routeProofExportV1\(/);
  const activity = readFileSync(path.join(here, '../plan/RouteHistoryPage.tsx'), 'utf8');
  assert.match(activity, /downloadRouteProofV1\(\s*routeProofExportV1\(/);
  // A proof clicked in the rail is the proof Activity opens on.
  assert.match(console, /onSelectProof=\{\(routeRunId\) => consoleNav\.openActivityRun\(routeRunId\)\}/);
  assert.match(activity, /onSelectProof=\{openRun\}/);
  assert.match(activity, /useHistoryState<ActivityNavStateV1 \| null>\(\)/);
});
