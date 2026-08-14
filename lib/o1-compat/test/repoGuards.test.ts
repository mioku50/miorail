import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// T67D §14 — the prohibitions, checked against the WHOLE repository rather than
// against this package. A gate that only polices its own directory cannot
// notice the thing it exists to prevent: a signing path appearing somewhere
// else because o1 looked close enough to working.
//
// ---------------------------------------------------------------------------
// SUPERSEDED IN PART, and deliberately so.
//
// T67D examined o1's Permit2 flow, found it required `/order/complete` and a
// provider-side broadcast, and recorded the verdict `incompatible`. Four
// assertions here followed from that verdict: no execution flag, no adapter,
// a registry row reading `incompatible_with_base_account_v1`, and a console
// entry hardcoded to `blocked`.
//
// DECISIONS.md §19 replaced the verdict, not the prohibitions. o1 now uses the
// standard `POST /api/v2/order` path, which returns ordinary unsigned Base
// transactions; `831aca7 feat(routes): release pinned o1 exchange swaps`
// shipped it. Those four assertions had been failing ever since, which is
// worse than useless — a red guard tells no one anything, and the whole suite
// stops at it before the ~2,200 tests behind it ever run.
//
// So they are rewritten to hold down what §19 actually promises. Every
// assertion that is still true is untouched: the signing primitives, the
// private key, `/order/complete`, and the absence of a schema change are the
// reason this file exists and none of them moved.
// ---------------------------------------------------------------------------

function repoRoot(): string {
  let current = resolve(process.cwd());
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

const ROOT = repoRoot();
const SKIP = new Set(['.git', 'node_modules', 'dist', '.next', 'coverage', 'screen', 'scratchpad']);

function sourceFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(ROOT)
  .map((path) => ({
    path: path.slice(ROOT.length + 1),
    text: readFileSync(path, 'utf8'),
  }))
  // This file names every banned identifier in order to search for it.
  .filter((file) => file.path !== 'lib/o1-compat/test/repoGuards.test.ts');

const PRODUCTION = FILES.filter((file) => !/\.test\.(ts|tsx)$/.test(file.path));

/** Comments and string literals removed — quoting a requirement in a finding is
 * the gate's job; holding the capability is what is banned. */
function executableCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('T67D §14 — no signing path was introduced anywhere', () => {
  test('nothing in the repository calls signTransaction', () => {
    // The single most important assertion in this file. `signTransaction` is
    // the primitive a Base Account does not have and Miorail must never want.
    const offenders = FILES.filter((file) => /\.signTransaction\s*\(/.test(executableCode(file.text)));
    assert.deepEqual(offenders.map((file) => file.path), []);
  });

  test('no production code reads a private-key environment variable', () => {
    // Scoped to production on purpose. Two test files touch the identifier and
    // both are the opposite of a leak: `lib/data-providers/test/real.test.ts`
    // SETS a fake `PRIVATE_KEY` to prove the redactor removes it, and
    // `artifacts/api-server/routes/autonomy.test.ts` sets a fake
    // `TESTNET_PRIVATE_KEY` that no source file reads. Failing on those would
    // punish the test that guards the behaviour.
    const offenders = PRODUCTION.filter((file) =>
      /process\.env\.[A-Z_]*PRIVATE_KEY|env\.[A-Z_]*PRIVATE_KEY/.test(executableCode(file.text)),
    );
    assert.deepEqual(offenders.map((file) => file.path), []);
  });

  test('no production code holds a signer or a raw signed transaction', () => {
    const offenders = PRODUCTION.filter((file) =>
      /\bnew\s+Wallet\s*\(|\bsignedRawTransaction\b/.test(executableCode(file.text)),
    );
    assert.deepEqual(offenders.map((file) => file.path), []);
  });

  test('/order/complete is never called', () => {
    const offenders = FILES.filter((file) => /order\/complete/.test(executableCode(file.text)));
    assert.deepEqual(offenders.map((file) => file.path), []);
  });

  test('o1 execution is behind a flag, and that flag defaults off', () => {
    // The original assertion was that no such flag existed at all. §19 allows
    // one; what it does not allow is a flag that is on because nobody chose.
    // An adapter is a decision, and a default-true flag is how one gets made
    // quietly.
    const config = readFileSync(
      resolve(ROOT, 'artifacts/api-server/lib/productMigrationConfig.ts'),
      'utf8',
    );
    assert.match(config, /o1ExecutionV1:\s*readBooleanFlag\(env,\s*'MIORAIL_O1_EXECUTION_V1',\s*false\)/);
  });

  test('the o1 credential §19 refuses is requested nowhere', () => {
    // §19: "it does not require a per-user O1_AGGREGATOR_API_KEY". The legacy
    // DEX Aggregator product is a different service, and reading its key would
    // be the first step back toward the flow this gate rejected.
    const offenders = FILES.filter((file) => /O1_AGGREGATOR_API_KEY/.test(executableCode(file.text)));
    assert.deepEqual(offenders.map((file) => file.path), []);
  });

  test('the o1 adapter refuses the Permit2 relay path outright', () => {
    // The adapter now exists — that is §19. What must not exist is the branch
    // T67D actually objected to: Permit2, which is completed by o1 broadcasting
    // through its own relay, outside the non-custodial boundary. It is refused
    // by error code rather than merely unused, so a provider response that
    // offers one cannot be silently followed.
    const order = readFileSync(resolve(ROOT, 'lib/swap-adapters/src/o1-order.ts'), 'utf8');
    assert.match(order, /entry\.permit2 !== undefined/);
    assert.match(order, /o1_permit2_relay_unsupported/);
  });

  test('no migration was added for this task', () => {
    // §14: no new DB tables. The gate is a report, not a schema change.
    const migrations = readdirSync(resolve(ROOT, 'lib/db/drizzle')).filter((name) => name.endsWith('.sql'));
    assert.deepEqual(migrations.filter((name) => /o1/i.test(name)), []);
  });
});

describe('T67D §13 — the registry and the rail agree', () => {
  test('the registry still separates the two o1 products', () => {
    // The separation is the part §19 did not change, and the part that matters:
    // the released adapter follows the standard-order specification, while the
    // older DEX Aggregator product — the one whose key Miorail refuses — stays
    // `documented` and disabled. Collapsing the two rows would let the second
    // inherit the first's release.
    const registry = readFileSync(resolve(ROOT, 'docs/PLUGIN_REGISTRY.md'), 'utf8');
    assert.match(registry, /DEX Aggregator API/);
    assert.match(registry, /o1\.exchange legacy DEX Aggregator API[^|]*\|[^|]*\|\s*`documented`/);
    // `scored` is where §19 leaves it. `proven` requires a real reconciled
    // Route Proof, which no o1 route has produced.
    assert.equal(/o1\.exchange[^|]*\|[^|]*\|\s*`proven`/.test(registry), false);
  });

  test('o1 visibility rides the routing gate, never a hardcoded live', () => {
    // It may appear as a measured candidate — that is comparison, which spends
    // and signs nothing. What it must never be is asserted live by the client
    // independently of the server's gate.
    const flow = readFileSync(resolve(ROOT, 'lib/ui/src/console/consoleFlow.ts'), 'utf8');
    assert.match(flow, /\{ name: 'o1\.exchange', state: gate\(routing\) \}/);
    assert.equal(/\{ name: 'o1\.exchange', state: '(live|configured)' \}/.test(flow), false);
  });
});

describe('the gate is reachable the way the task specifies', () => {
  test('pnpm o1:compat is registered', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['o1:compat'], 'tsx scripts/o1_compat.ts');
  });

  test('the default run needs no network and reaches the verdict', () => {
    // Run the real command. If it needed a token or a vendor, this fails here
    // rather than in CI on a day the vendor is down.
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/o1_compat.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, O1_TRADING_API_TOKEN: '', O1_TRADING_COMPAT_LIVE: 'false' },
    });
    assert.match(output, /VERDICT: incompatible/);
    assert.match(output, /Hard blockers:/);
    assert.match(output, /requires_raw_transaction_signing/);
  });

  test('--live refuses without the flag, and sends nothing', () => {
    let output = '';
    try {
      execFileSync(process.execPath, ['--import', 'tsx', 'scripts/o1_compat.ts', '--', '--live'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, O1_TRADING_COMPAT_LIVE: 'false', O1_TRADING_API_TOKEN: 'x' },
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    assert.match(output, /requires O1_TRADING_COMPAT_LIVE=true/);
  });
});
