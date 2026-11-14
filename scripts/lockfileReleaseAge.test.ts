import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { addedPackagesV1, lockfilePackagesV1, minimumReleaseAgeMinutesV1, packageOfEntryV1, readPublishedAtV1, releaseAgeExceptionsV1,
  releaseAgeFindingsV1 } from './lockfileReleaseAge.js';

// Dependabot's security updates bypass minimumReleaseAge by themselves, and a frozen install never asks a
// version's age, so a version hours old reached a green pull request (audit SUP-1, 2026-11-14).
const lock = (packages: string[]) => ['lockfileVersion: \'9.0\'', '', 'importers:', '', '  .:', '    dependencies:', '      hono:', '        version: 9.9.9', '',
  'packages:', '', ...packages.flatMap((entry) => [`  ${entry.startsWith('@') ? `'${entry}'` : entry}:`, '    resolution: {integrity: sha512-x}', '']),
  'snapshots:', '', '  hono@9.9.9: {}', ''].join('\n');

test('the lockfile\'s packages are read by name and version, scoped names included, and only from its packages section', () => {
  const packages = lockfilePackagesV1(lock(['@scope/name@1.2.3', 'hono@4.12.27', 'next@15.5.28']));
  assert.deepEqual([...packages].sort(), ['@scope/name@1.2.3', 'hono@4.12.27', 'next@15.5.28']);
  // The real lockfile reads too, and every entry names a version.
  const real = lockfilePackagesV1(readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'));
  assert.ok(real.size > 500);
  assert.ok([...real].every((entry) => /@[0-9]/.test(entry)));
});

test('what a change adds is the head\'s versions the base did not resolve', () => {
  assert.deepEqual(addedPackagesV1(lock(['hono@4.12.27', 'axios@1.21.0']), lock(['hono@4.13.16', 'axios@1.21.0', '@x/y@2.0.0'])), ['@x/y@2.0.0', 'hono@4.13.16']);
  assert.deepEqual(addedPackagesV1(lock(['a@1.0.0']), lock(['a@1.0.0'])), []);
});

test('a version younger than the minimum fails, and so does one the registry did not date; an exception passes', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const publishedAt = new Map<string, string | null>([['hono@4.13.16', '2026-11-13T10:00:00Z'], ['old@1.0.0', '2026-10-01T00:00:00Z'],
    ['unknown@1.0.0', null], ['excepted@1.0.0', '2026-11-14T11:00:00Z']]);
  const findings = releaseAgeFindingsV1({ added: ['excepted@1.0.0', 'hono@4.13.16', 'old@1.0.0', 'unknown@1.0.0'], publishedAt, now, minimumMinutes: 10_080,
    exceptions: releaseAgeExceptionsV1('# comment\nexcepted@1.0.0   security fix, the operator decided 2026-11-14\n\n') });
  assert.deepEqual(findings, [
    { entry: 'hono@4.13.16', state: 'too_young', publishedAt: '2026-11-13T10:00:00.000Z', ageMinutes: 1560 },
    { entry: 'unknown@1.0.0', state: 'unread' },
  ]);
});

test('the policy and the exceptions file are read as written, and the file in the repository names no exception', () => {
  assert.equal(minimumReleaseAgeMinutesV1(readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')), 10_080);
  assert.equal(minimumReleaseAgeMinutesV1('packages: []'), null);
  assert.equal(releaseAgeExceptionsV1(readFileSync(new URL('../.github/release-age-exceptions.txt', import.meta.url), 'utf8')).size, 0);
  assert.deepEqual(packageOfEntryV1('@scope/name@1.2.3'), { name: '@scope/name', version: '1.2.3' });
});

test('the registry is asked once per name, and a failed read dates nothing', async () => {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    if (url.endsWith('/broken')) return new Response('no', { status: 500 });
    return new Response(JSON.stringify({ time: { '1.0.0': '2026-01-01T00:00:00Z', '2.0.0': '2026-11-14T00:00:00Z' } }), { status: 200 });
  }) as unknown as typeof fetch;
  const dated = await readPublishedAtV1(['@x/y@1.0.0', '@x/y@2.0.0', 'broken@1.0.0'], fetchImpl, 'https://registry.example');
  assert.deepEqual(asked, ['https://registry.example/@x%2fy', 'https://registry.example/broken']);
  assert.deepEqual([...dated], [['@x/y@1.0.0', '2026-01-01T00:00:00Z'], ['@x/y@2.0.0', '2026-11-14T00:00:00Z'], ['broken@1.0.0', null]]);
});

test('CI runs the check against the change\'s base', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /node --import tsx scripts\/check_lockfile_release_age\.ts --base "\$BASE_SHA"/);
  assert.match(ci, /github\.event\.pull_request\.base\.sha/);
});
