import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { describeErrorV1 } from '@mioagent/utils';

import { addedPackagesV1, minimumReleaseAgeMinutesV1, readPublishedAtV1, releaseAgeExceptionsV1, releaseAgeFindingsV1 } from './lockfileReleaseAge.js';

// The versions a change adds to pnpm-lock.yaml must each be at least as old as
// pnpm-workspace.yaml's minimumReleaseAge (audit SUP-1, scripts/lockfileReleaseAge.ts).
//
//   node --import tsx scripts/check_lockfile_release_age.ts --base <commit>
//
// CI runs it against the pull request's base, or the commit before a push. It
// asks the npm registry when each added version was published, and fails while
// any is younger than the minimum, or could not be read. The one way past it is
// a line in .github/release-age-exceptions.txt: `name@version  reason, date`.

const EXCEPTIONS_PATH_V1 = '.github/release-age-exceptions.txt';

async function main(): Promise<void> {
  const at = process.argv.indexOf('--base');
  const base = at >= 0 ? process.argv[at + 1] : undefined;
  if (!base || !/^[0-9a-f]{7,40}$/i.test(base)) throw new Error('usage: --base <commit>');
  const minimum = minimumReleaseAgeMinutesV1(readFileSync('pnpm-workspace.yaml', 'utf8'));
  if (minimum === null) throw new Error('pnpm-workspace.yaml sets no minimumReleaseAge');
  const head = readFileSync('pnpm-lock.yaml', 'utf8');
  let before: string;
  try {
    before = execFileSync('git', ['show', `${base}:pnpm-lock.yaml`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch {
    throw new Error(`the base commit's pnpm-lock.yaml could not be read (fetch ${base} first)`);
  }
  const added = addedPackagesV1(before, head);
  console.log(`added to the lockfile: ${added.length} version(s); minimum age ${minimum} minutes`);
  if (added.length === 0) return;
  const exceptions = releaseAgeExceptionsV1(existsSync(EXCEPTIONS_PATH_V1) ? readFileSync(EXCEPTIONS_PATH_V1, 'utf8') : '');
  const findings = releaseAgeFindingsV1({ added, publishedAt: await readPublishedAtV1(added), now: new Date(), minimumMinutes: minimum, exceptions });
  for (const entry of added) console.log(`  ${entry}${exceptions.has(entry) ? '  (excepted)' : ''}`);
  if (findings.length === 0) { console.log('every added version is old enough'); return; }
  for (const finding of findings) {
    console.error(finding.state === 'too_young'
      ? `TOO YOUNG: ${finding.entry} was published ${finding.publishedAt}, ${Math.floor(finding.ageMinutes / 60)} h ago`
      : `UNREAD: the registry did not say when ${finding.entry} was published`);
  }
  console.error(`Wait until each is ${minimum / 1440} days old, or add it to ${EXCEPTIONS_PATH_V1} with a reason in a reviewed commit.`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('FAILED —', describeErrorV1(error));
  process.exitCode = 1;
});
