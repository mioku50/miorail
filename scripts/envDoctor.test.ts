import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// T67X-A1 / T67X-B2 — the two production gates, exercised through the real
// script. The contract env-doctor has with a deploy is its EXIT CODE, and an
// exit code cannot be unit-tested out of a pure function: it is the wiring.

/** CommonJS output here, so no `import.meta` — see loadEnvFile.ts. */
function repoRoot(): string {
  let current = resolve(process.cwd());
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(process.cwd());
}

const ROOT = repoRoot();
const SCRIPT = resolve(ROOT, 'scripts', 'env-doctor.mjs');

interface Run {
  code: number;
  output: string;
}

function runDoctor(env: Record<string, string>, args: string[] = []): Run {
  const directory = mkdtempSync(join(tmpdir(), 'env-doctor-'));
  const path = join(directory, '.env');
  writeFileSync(
    path,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
  try {
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', SCRIPT, ...args],
      {
        cwd: ROOT,
        env: { ...process.env, ENV_DOCTOR_ENV_PATH: path },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

/** A mainnet .env that passes every pre-existing check, so each test below
 * changes exactly one thing. */
function mainnetBase(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://user:pw@localhost:5432/mio',
    SESSION_SECRET: 'x'.repeat(32),
    LLM_PROVIDER: 'openai',
    CHAIN_ENV: 'mainnet',
    BASE_MAINNET_RPC_URL: 'https://mainnet.base.org',
    MORALIS_API_KEY: 'test',
    TOKEN_BALANCES_PROVIDER: 'moralis',
    PRICE_PROVIDER: 'coingecko',
    TOKEN_SECURITY_PROVIDER: 'goplus',
    APPROVAL_PROVIDER: 'moralis',
    MAINNET_EXECUTION_ENABLED: 'false',
    MCP_SERVER_URL: 'https://mcp.example.com',
    X402_FACILITATOR_URL: 'https://facilitator.example.com',
    X402_PAYTO_ADDRESS: '0x8e525BfCe1eF40Aa8075ef64E45421b5855C8909',
    X402_NETWORK: 'eip155:8453',
    BASE_BUILDER_CODE: 'bc_a1b2c3d4',
    ...overrides,
  };
}

describe('paid intelligence requires a settlement path', () => {
  test('a facilitator URL with no authorization fails the check', () => {
    // This is the shape that used to pass: everything "configured", and the
    // first real payment failing at settle — after the user had signed.
    const run = runDoctor(mainnetBase({ MIORAIL_PAID_INTELLIGENCE: 'true' }));
    assert.equal(run.code, 1);
    assert.match(run.output, /MIORAIL_PAID_INTELLIGENCE=true but x402 settlement is not ready/);
    assert.match(run.output, /X402_FACILITATOR_AUTH_TOKEN/);
    // And it says what still works, because this must not read as an outage.
    assert.match(run.output, /free route comparison still works/);
  });

  test('a bearer token satisfies it', () => {
    const run = runDoctor(
      mainnetBase({ MIORAIL_PAID_INTELLIGENCE: 'true', X402_FACILITATOR_AUTH_TOKEN: 'test-token' }),
    );
    assert.equal(run.code, 0);
    assert.match(run.output, /settlement path configured \(auth via bearer_token\)/);
  });

  test('a complete CDP key pair satisfies it', () => {
    const run = runDoctor(
      mainnetBase({
        MIORAIL_PAID_INTELLIGENCE: 'true',
        CDP_API_KEY_ID: 'key-id',
        CDP_API_KEY_SECRET: 'key-secret',
      }),
    );
    assert.equal(run.code, 0);
    assert.match(run.output, /auth via cdp_api_key_pair/);
  });

  test('half a CDP key pair does NOT satisfy it', () => {
    // An incomplete pair reads as "configured" to a naive presence check and
    // cannot sign a single request.
    const run = runDoctor(
      mainnetBase({ MIORAIL_PAID_INTELLIGENCE: 'true', CDP_API_KEY_ID: 'key-id' }),
    );
    assert.equal(run.code, 1);
    assert.match(run.output, /cdp_api_key_pair_incomplete/);
  });

  test('the flag being off makes settlement irrelevant', () => {
    const run = runDoctor(mainnetBase());
    assert.equal(run.code, 0);
    assert.match(run.output, /MIORAIL_PAID_INTELLIGENCE is off/);
  });
});

describe('mainnet execution requires a Builder Code', () => {
  test('execution enabled with no code fails, and says read-only is unaffected', () => {
    const run = runDoctor(
      mainnetBase({ MAINNET_EXECUTION_ENABLED: 'true', BASE_BUILDER_CODE: '' }),
    );
    assert.equal(run.code, 1);
    assert.match(run.output, /mainnet execution is enabled but no usable Builder Code/);
    assert.match(run.output, /quotes, comparison, evidence, scoring/);
  });

  test('canonical and deprecated keys disagreeing fails closed', () => {
    const run = runDoctor(
      mainnetBase({
        MAINNET_EXECUTION_ENABLED: 'true',
        BASE_BUILDER_CODE: 'bc_a1b2c3d4',
        BUILDER_CODE: 'bc_deadbeef',
      }),
    );
    assert.equal(run.code, 1);
    assert.match(run.output, /different values/);
  });

  test('the deprecated alias alone still passes, with a rename note', () => {
    const run = runDoctor(
      mainnetBase({
        MAINNET_EXECUTION_ENABLED: 'true',
        BASE_BUILDER_CODE: '',
        BUILDER_CODE: 'miorail',
      }),
    );
    assert.equal(run.code, 0);
    assert.match(run.output, /Builder Code resolved from BUILDER_CODE/);
    assert.match(run.output, /deprecated/);
  });

  test('execution disabled downgrades a missing code to a warning', () => {
    // Nothing is attributed because nothing is executed. Failing here would
    // block read-only deployments over an identifier they never use.
    const run = runDoctor(mainnetBase({ BASE_BUILDER_CODE: '' }));
    assert.equal(run.code, 0);
    assert.match(run.output, /attributed to nobody/);
  });
});

describe('boolean flags must be exactly true or false', () => {
  test('a stray character that reads as true is caught and shown', () => {
    // The real incident: a Cyrillic `я` from a keyboard layout. The line looked
    // correct in an editor, `readBooleanFlag` fell back to false, and the
    // console reported a gate the operator believed was open.
    const run = runDoctor(mainnetBase({ MIORAIL_PAID_INTELLIGENCE: 'trueя' }));
    assert.equal(run.code, 1);
    assert.match(run.output, /neither `true` nor `false`/);
    // The value is printed, uniquely among all checks: naming only the key
    // would not have revealed the problem, because the key was never wrong.
    assert.match(run.output, /MIORAIL_PAID_INTELLIGENCE="trueя"/);
    assert.match(run.output, /silently fall back to their default/);
  });

  test('common near-misses are caught too', () => {
    for (const value of ['True', 'TRUE', '1', 'yes', 'enabled', 'true#comment']) {
      const run = runDoctor(mainnetBase({ MIORAIL_EARN_ROUTE_V1: value }));
      assert.equal(run.code, 1, `${JSON.stringify(value)} must not pass as a boolean`);
    }
  });

  test('trailing whitespace is NOT flagged, because every loader trims it', () => {
    // `node --env-file`, dotenv and systemd's EnvironmentFile all trim the
    // value. Flagging `true ` would be this check disagreeing with the runtime
    // it exists to describe.
    assert.equal(runDoctor(mainnetBase({ MIORAIL_EARN_ROUTE_V1: 'true  ' })).code, 0);
  });

  test('true, false and empty all pass', () => {
    // Empty is a legitimate "unset"; the required-variable check owns that case.
    for (const value of ['true', 'false', '']) {
      const run = runDoctor(mainnetBase({ MIORAIL_EARN_ROUTE_V1: value }));
      assert.equal(run.code, 0, `${JSON.stringify(value)} must pass`);
    }
  });

  test('a non-flag variable is not policed as a boolean', () => {
    const run = runDoctor(mainnetBase({ PRICE_PROVIDER: 'coingecko' }));
    assert.equal(run.code, 0);
  });
});

describe('the check itself', () => {
  test('the pnpm `--` separator is not an argument', () => {
    assert.equal(runDoctor(mainnetBase(), ['--']).code, 0);
  });

  test('an unknown argument stops the run rather than being ignored', () => {
    const run = runDoctor(mainnetBase(), ['--proble']);
    assert.equal(run.code, 2);
    assert.match(run.output, /unrecognised argument/);
  });

  test('no value is ever printed', () => {
    const secret = 'super-secret-session-value-do-not-print';
    const run = runDoctor(
      mainnetBase({ SESSION_SECRET: secret, MIORAIL_PAID_INTELLIGENCE: 'true' }),
    );
    assert.equal(run.output.includes(secret), false, 'env-doctor must never print a value');
    // The Builder Code is the documented exception: it is a public identifier,
    // and naming its key is how a conflict gets resolved.
    assert.match(run.output, /BASE_BUILDER_CODE/);
  });
});
