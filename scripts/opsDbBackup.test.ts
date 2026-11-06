import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The nightly dump is three files and one line of the deploy (2026-11-06).
// These are the parts that, missing, would leave the host with no backup and
// no alert saying so.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('every deploy installs and enables the nightly dump with the other timers', () => {
  const loop = read('ops/deploy.sh').match(/^for stem in ([^;]+); do$/m)?.[1]?.split(' ') ?? [];
  assert.ok(loop.includes('db-backup'));
  assert.match(read('ops/systemd/miorail-db-backup.service'), /^ExecStart=\/bin\/bash \/home\/miorail\/mioagent\/ops\/backup\/miorail-db-backup\.sh$/m);
});

test('it runs every night and makes up a night the host was down', () => {
  const timer = read('ops/systemd/miorail-db-backup.timer');
  assert.match(timer, /^OnCalendar=\*-\*-\* \d{2}:\d{2}:00 UTC$/m);
  assert.match(timer, /^Persistent=true$/m);
});

test('a dump is kept only after both checks, and a week and a month of them are kept', () => {
  const script = read('ops/backup/miorail-db-backup.sh');
  const order = ['pg_dump', 'TABLE DATA', 'pg_restore -f /dev/null', 'mv "$part" "$dump"'].map((step) => script.indexOf(step));
  assert.ok(order.every((at) => at > 0), 'every step is there');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order: dump, coverage, read back, keep');
  assert.match(script, /^KEEP_DAILY=7$/m);
  assert.match(script, /^KEEP_WEEKLY=4$/m);
  assert.match(script, /^set -euo pipefail$/m);
});
