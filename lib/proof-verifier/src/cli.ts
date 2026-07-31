import { readFileSync } from 'node:fs';

import { verifyPublicProofBundleV1 } from './verify.js';

// ---------------------------------------------------------------------------
// T67C.2 — `pnpm proof:verify -- ./miorail-proof-<id>.json`
//
// Reads a file and checks it. That is all it does — it opens no socket, needs
// no running Miorail API, and holds no key. Somebody who was sent a bundle can
// check it on a laptop with no relationship to Miorail at all, which is the
// only version of "verifiable" worth the word.
//
// It does NOT read Base. The transaction hashes it prints can be checked on a
// block explorer, and that is a genuinely stronger check — so the CLI names it
// rather than implying it has already been done.
//
// Exit codes:
//   0 — the bundle is internally consistent
//   1 — invalid or tampered with
//   2 — the file could not be read or parsed, or the arguments were wrong
// ---------------------------------------------------------------------------

export const CLI_USAGE_V1 = 'usage: proof:verify -- <path-to-bundle.json>';

export interface CliOutcomeV1 {
  exitCode: 0 | 1 | 2;
  lines: string[];
}

/** The whole CLI as a pure function of its arguments and a file reader, so it
 * can be tested without spawning a process. */
export function runProofVerifyCliV1(
  argv: readonly string[],
  readFile: (path: string) => string,
): CliOutcomeV1 {
  const path = argv.find((argument) => !argument.startsWith('-'));
  if (!path) return { exitCode: 2, lines: [CLI_USAGE_V1] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(path));
  } catch (error) {
    // A missing file and malformed JSON are both usage problems, not verdicts
    // about a bundle — hence 2 rather than 1. Reporting "invalid proof" for a
    // typo in a filename would be a lie about somebody's proof.
    const detail = error instanceof Error ? error.message : 'unreadable';
    return { exitCode: 2, lines: [`could not read ${path}: ${detail}`] };
  }

  const result = verifyPublicProofBundleV1(parsed);
  const lines = [
    `bundle:  ${result.bundleHash ?? '—'}`,
    `proof:   ${result.proofHash ?? '—'}`,
    `family:  ${result.proofFamily ?? '—'}`,
    '',
    ...result.checks.map((check) => {
      const mark = check.outcome === 'passed' ? 'ok  ' : check.outcome === 'failed' ? 'FAIL' : 'skip';
      return `${mark} ${check.label}${check.detail ? ` — ${check.detail}` : ''}`;
    }),
    '',
    result.valid
      ? 'VALID — canonical hash integrity verified locally.'
      : 'INVALID — this bundle is invalid or has been modified.',
    'This verifies canonical bundle integrity. It is not a Miorail server',
    'signature and is not an onchain anchor. The transaction hashes above can',
    'be checked independently on a Base block explorer.',
  ];
  return { exitCode: result.valid ? 0 : 1, lines };
}

export function mainV1(argv: readonly string[]): number {
  const outcome = runProofVerifyCliV1(argv, (path) => readFileSync(path, 'utf8'));
  for (const line of outcome.lines) console.log(line);
  return outcome.exitCode;
}

// Only when executed directly, so importing this module in a test runs nothing.
if (process.argv[1] && /proof-verifier[/\\]src[/\\]cli\.ts$/.test(process.argv[1])) {
  process.exitCode = mainV1(process.argv.slice(2));
}
