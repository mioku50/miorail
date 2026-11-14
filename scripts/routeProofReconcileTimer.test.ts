import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// A Route Proof whose reconcile failed stayed pending for good: only the page reconciled it, once
// (audit OPS-1, 2026-11-14). These are the parts that, missing, would leave it so again.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('every deploy installs and enables the pending proof reconcile with the other timers', () => {
  const loop = read('ops/deploy.sh').match(/^for stem in ([^;]+); do$/m)?.[1]?.split(' ') ?? [];
  assert.ok(loop.includes('route-proofs'));
  const unit = read('ops/systemd/miorail-route-proofs.service');
  assert.match(unit, /^ExecStart=\/home\/miorail\/\.nvm\/versions\/node\/v22\.23\.1\/bin\/node --import tsx scripts\/reconcile_pending_route_proofs\.ts$/m);
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^User=miorail$/m);
  // Receipts on the operator-reviewed RPC, as the API reads them.
  assert.match(unit, /^EnvironmentFile=\/etc\/miorail\/api-rpc\.env$/m);
});

test('it runs every hour and makes up an hour the host was down', () => {
  const timer = read('ops/systemd/miorail-route-proofs.timer');
  assert.match(timer, /^OnUnitActiveSec=1h$/m);
  assert.match(timer, /^Persistent=true$/m);
});

test('a pass leaves alone a proof a page may still be reconciling, and proofs with no transaction', () => {
  const script = read('scripts/reconcile_pending_route_proofs.ts');
  assert.match(script, /p\.status = 'pending'/);
  assert.match(script, /jsonb_array_length\(COALESCE\(p\.payload->'transactionHashes', '\[\]'::jsonb\)\) > 0/);
  assert.match(script, /p\.updated_at < now\(\) - interval '10 minutes'/);
  assert.match(script, /LIMIT 50/);
  // An error is told by name and status, never its raw text with the RPC URL in it.
  assert.doesNotMatch(script, /error\.message/);
});
