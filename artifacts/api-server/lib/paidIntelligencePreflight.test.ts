import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  PAID_INTELLIGENCE_BUDGET_TABLES_V1,
  PAID_INTELLIGENCE_CHARGE_TABLES_V1,
  PAID_INTELLIGENCE_PREREQUISITES_V1,
  paidIntelligencePreflightV1,
  type PaidIntelligencePreflightDepsV1,
} from './paidIntelligencePreflight.js';

// ---------------------------------------------------------------------------
// T71 verification §1 — the preflight fails CLOSED.
//
// The property under test is not "does it list the checks". It is that no
// combination of a satisfied prerequisite can make an unsatisfied one pass:
// every check contributes independently, and `ok` is a conjunction. The failure
// this prevents is a user granting a real Spend Permission on a server that
// cannot charge it — authority given away for nothing.
// ---------------------------------------------------------------------------

const CANONICAL_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SPENDER = '0x1234567890123456789012345678901234567890';

function healthyEnv(): NodeJS.ProcessEnv {
  return {
    CHAIN_ENV: 'mainnet',
    BASE_MAINNET_RPC_URL: 'https://rpc.example.invalid/key',
    DATABASE_URL: 'postgres://user:password@host/db',
  };
}

function healthyDeps(overrides: Partial<PaidIntelligencePreflightDepsV1> = {}): PaidIntelligencePreflightDepsV1 {
  return {
    flags: () => ({ routeIntelligenceV1: true, paidIntelligence: true }),
    readiness: () => ({ flagEnabled: true, settleReady: true, readiness: 'ready' }),
    pricing: () => ({
      amountAtomic: '10000',
      decimalUsdc: '0.01',
      price: {
        asset: {
          assetId: `eip155:8453/erc20:${CANONICAL_USDC}`,
          chainId: 8453,
          kind: 'erc20',
          address: CANONICAL_USDC as `0x${string}`,
          symbol: 'USDC',
          decimals: 6,
        },
        amountAtomic: '10000',
        amountDecimal: '0.01',
        usdValue: '0.01',
      },
    }),
    provider: () => ({ configured: true, providerId: 'alchemy-eth-simulate-v1', allowlist: [] }),
    spender: async () => SPENDER,
    gasReadiness: async () => ({ ready: true, deployed: true, nativeBalancePresent: true, gasSponsored: false }),
    tables: async (names) => Object.fromEntries(names.map((name) => [name, true])),
    ...overrides,
  };
}

describe('paidIntelligencePreflightV1', () => {
  test('a fully configured server is ready and reports the spender it will name to the user', async () => {
    const report = await paidIntelligencePreflightV1(healthyDeps(), healthyEnv());
    assert.equal(report.ok, true);
    assert.deepEqual(report.blocking, []);
    assert.equal(report.spender, SPENDER);
    assert.equal(report.token, CANONICAL_USDC);
    assert.equal(report.chainId, 8453);
  });

  test('every prerequisite is reported, in a stable order', async () => {
    const report = await paidIntelligencePreflightV1(healthyDeps(), healthyEnv());
    assert.deepEqual(
      report.checks.map((check) => check.name),
      [...PAID_INTELLIGENCE_PREREQUISITES_V1],
    );
  });

  test('the feature flag alone does not make a server ready', async () => {
    const report = await paidIntelligencePreflightV1(
      healthyDeps({ spender: async () => { throw new Error('CDP is not configured'); } }),
      healthyEnv(),
    );
    assert.equal(report.ok, false);
    // The gas check is reported as unmet too, and says WHY it could not run
    // rather than inventing an answer about a wallet that does not exist.
    assert.deepEqual(report.blocking, ['spender_wallet', 'spender_can_pay_gas']);
    const gas = report.checks.find((entry) => entry.name === 'spender_can_pay_gas');
    assert.match(gas?.detail ?? '', /did not resolve/);
  });

  test('a spender that cannot pay its own gas blocks — the user would sign for nothing', async () => {
    const report = await paidIntelligencePreflightV1(
      healthyDeps({
        gasReadiness: async () => ({
          ready: false,
          deployed: true,
          nativeBalancePresent: false,
          gasSponsored: false,
          errorCode: 'subscription_owner_gas_unavailable',
        }),
      }),
      healthyEnv(),
    );
    assert.equal(report.ok, false);
    assert.deepEqual(report.blocking, ['spender_can_pay_gas']);
    const gas = report.checks.find((entry) => entry.name === 'spender_can_pay_gas');
    assert.match(gas?.detail ?? '', /subscription_owner_gas_unavailable/);
    assert.match(gas?.detail ?? '', /PAYMASTER_URL/);
  });

  test('a paymaster satisfies the gas check without any native balance', async () => {
    const report = await paidIntelligencePreflightV1(
      healthyDeps({
        gasReadiness: async () => ({
          ready: true,
          deployed: true,
          nativeBalancePresent: false,
          gasSponsored: true,
        }),
      }),
      healthyEnv(),
    );
    assert.equal(report.ok, true);
    const gas = report.checks.find((entry) => entry.name === 'spender_can_pay_gas');
    assert.match(gas?.detail ?? '', /PAYMASTER_URL sponsors/);
  });

  test('an RPC that cannot be reached does not pass the gas check by default', async () => {
    const report = await paidIntelligencePreflightV1(
      healthyDeps({ gasReadiness: async () => { throw new Error('https://rpc.example.invalid/secret-key timed out'); } }),
      healthyEnv(),
    );
    assert.deepEqual(report.blocking, ['spender_can_pay_gas']);
    const gas = report.checks.find((entry) => entry.name === 'spender_can_pay_gas');
    assert.ok(!gas?.detail.includes('secret-key'));
  });

  test('an unresolvable spender is reported without the CDP error', async () => {
    const report = await paidIntelligencePreflightV1(
      healthyDeps({
        spender: async () => {
          throw new Error('wallet miorail-secret-name failed for key id AKIA-EXAMPLE');
        },
      }),
      healthyEnv(),
    );
    const check = report.checks.find((entry) => entry.name === 'spender_wallet');
    assert.equal(check?.ok, false);
    assert.equal(report.spender, null);
    assert.ok(!check?.detail.includes('AKIA-EXAMPLE'));
    assert.ok(!check?.detail.includes('miorail-secret-name'));
  });

  test('a spender that is not an address is treated as unresolved', async () => {
    const report = await paidIntelligencePreflightV1(healthyDeps({ spender: async () => 'not-an-address' }), healthyEnv());
    assert.equal(report.spender, null);
    assert.ok(report.blocking.includes('spender_wallet'));
  });

  test('settlement that cannot complete blocks onboarding, because Settings hides the button', async () => {
    const report = await paidIntelligencePreflightV1(
      healthyDeps({
        readiness: () => ({
          flagEnabled: true,
          settleReady: false,
          readiness: 'blocked',
          blockedReason: 'facilitator_auth_missing',
        }),
      }),
      healthyEnv(),
    );
    assert.equal(report.ok, false);
    assert.deepEqual(report.blocking, ['x402_settlement']);
    const check = report.checks.find((entry) => entry.name === 'x402_settlement');
    assert.match(check?.detail ?? '', /facilitator_auth_missing/);
  });

  test('a missing budget table blocks, and says which one', async () => {
    const report = await paidIntelligencePreflightV1(
      healthyDeps({
        tables: async (names) =>
          Object.fromEntries(names.map((name) => [name, name !== 'intelligence_budget_reservations'])),
      }),
      healthyEnv(),
    );
    assert.deepEqual(report.blocking, ['budget_storage']);
    const check = report.checks.find((entry) => entry.name === 'budget_storage');
    assert.match(check?.detail ?? '', /intelligence_budget_reservations/);
  });

  test('a missing charge table blocks independently of the budget tables', async () => {
    const report = await paidIntelligencePreflightV1(
      healthyDeps({
        tables: async (names) => Object.fromEntries(names.map((name) => [name, name !== 'spend_permissions'])),
      }),
      healthyEnv(),
    );
    assert.deepEqual(report.blocking, ['charge_storage']);
  });

  test('an unreadable database blocks both storage checks and leaks no DSN', async () => {
    const report = await paidIntelligencePreflightV1(
      healthyDeps({
        tables: async () => {
          throw new Error('connection to postgres://user:hunter2@db.example/miorail refused');
        },
      }),
      healthyEnv(),
    );
    assert.deepEqual(report.blocking, ['budget_storage', 'charge_storage']);
    for (const check of report.checks) assert.ok(!check.detail.includes('hunter2'));
  });

  test('the two storage groups cover exactly the tables paid evidence writes to', () => {
    assert.deepEqual([...PAID_INTELLIGENCE_BUDGET_TABLES_V1], [
      'intelligence_budgets',
      'intelligence_budget_reservations',
    ]);
    // spend_permissions is on the list because intelligence_budgets has a
    // foreign key into it: a budget cannot exist without the permission row.
    assert.deepEqual([...PAID_INTELLIGENCE_CHARGE_TABLES_V1], ['intelligence_charges', 'spend_permissions']);
  });

  test('a testnet chain env blocks, because the budget routes answer 409', async () => {
    const report = await paidIntelligencePreflightV1(healthyDeps(), { ...healthyEnv(), CHAIN_ENV: 'sepolia' });
    assert.deepEqual(report.blocking, ['chain_env']);
  });

  test('an unset CHAIN_ENV blocks rather than defaulting to mainnet', async () => {
    const env = healthyEnv();
    delete env.CHAIN_ENV;
    const report = await paidIntelligencePreflightV1(healthyDeps(), env);
    assert.deepEqual(report.blocking, ['chain_env']);
  });

  test('mainnet-readonly is allowed but warned about', async () => {
    const report = await paidIntelligencePreflightV1(healthyDeps(), {
      ...healthyEnv(),
      CHAIN_ENV: 'mainnet-readonly',
    });
    assert.equal(report.ok, true);
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /readonly/);
  });

  test('an RPC endpoint nobody chose blocks — verification runs while a wallet is open', async () => {
    const env = healthyEnv();
    delete env.BASE_MAINNET_RPC_URL;
    const report = await paidIntelligencePreflightV1(healthyDeps(), env);
    assert.deepEqual(report.blocking, ['base_rpc']);
  });

  test('BASE_RPC_URL satisfies the RPC check on its own', async () => {
    const env = healthyEnv();
    delete env.BASE_MAINNET_RPC_URL;
    env.BASE_RPC_URL = 'https://rpc.example.invalid/key';
    const report = await paidIntelligencePreflightV1(healthyDeps(), env);
    assert.equal(report.ok, true);
  });

  test('the RPC check never echoes the endpoint, which carries the key', async () => {
    const report = await paidIntelligencePreflightV1(healthyDeps(), healthyEnv());
    const check = report.checks.find((entry) => entry.name === 'base_rpc');
    assert.equal(check?.detail, 'configured');
  });

  test('a missing DATABASE_URL blocks', async () => {
    const env = healthyEnv();
    delete env.DATABASE_URL;
    const report = await paidIntelligencePreflightV1(healthyDeps(), env);
    assert.ok(report.blocking.includes('database_url'));
  });

  test('an invalid simulation price blocks — a paid check that cannot be priced cannot be sold', async () => {
    const report = await paidIntelligencePreflightV1(healthyDeps({ pricing: () => null }), healthyEnv());
    assert.deepEqual(report.blocking, ['simulation_pricing']);
  });

  test('an unconfigured provider blocks and names the reason', async () => {
    const report = await paidIntelligencePreflightV1(
      healthyDeps({
        provider: () => ({
          configured: false,
          providerId: 'alchemy-eth-simulate-v1',
          allowlist: [],
          missingReason: 'missing_api_key',
        }),
      }),
      healthyEnv(),
    );
    assert.deepEqual(report.blocking, ['simulation_pricing']);
    const check = report.checks.find((entry) => entry.name === 'simulation_pricing');
    assert.match(check?.detail ?? '', /missing_api_key/);
  });

  test('both flags are required, and each is reported separately', async () => {
    const off = await paidIntelligencePreflightV1(
      healthyDeps({ flags: () => ({ routeIntelligenceV1: false, paidIntelligence: false }) }),
      healthyEnv(),
    );
    assert.deepEqual(off.blocking, ['route_intelligence_flag', 'paid_intelligence_flag']);

    const half = await paidIntelligencePreflightV1(
      healthyDeps({ flags: () => ({ routeIntelligenceV1: true, paidIntelligence: false }) }),
      healthyEnv(),
    );
    assert.deepEqual(half.blocking, ['paid_intelligence_flag']);
  });

  test('several missing prerequisites are all reported, not just the first', async () => {
    const env = healthyEnv();
    delete env.DATABASE_URL;
    delete env.BASE_MAINNET_RPC_URL;
    const report = await paidIntelligencePreflightV1(
      healthyDeps({
        flags: () => ({ routeIntelligenceV1: true, paidIntelligence: false }),
        spender: async () => { throw new Error('nope'); },
      }),
      env,
    );
    assert.deepEqual(report.blocking, [
      'paid_intelligence_flag',
      'base_rpc',
      'database_url',
      'spender_wallet',
      'spender_can_pay_gas',
    ]);
  });
});
