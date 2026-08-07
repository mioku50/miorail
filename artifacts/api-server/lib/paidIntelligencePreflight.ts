import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';
import { x402ConfigFromEnv } from '@mioagent/x402-gateway';
import type { SimulationProviderConfigV1 } from '@mioagent/paid-intelligence';
import { client } from '@mioagent/db';
import { getMiorailProductMigrationFlags } from './productMigrationConfig.js';
import { paidIntelligenceReadinessV1, type PaidIntelligenceStatusV1 } from './paidIntelligenceReadiness.js';
import {
  resolvePaidSimulationPricingV1,
  resolvePaidSimulationProviderV1,
  type PaidSimulationPricingV1,
} from './paidIntelligenceConfig.js';
import { paidEvidenceTokenV1 } from './spendPermissionVerifier.js';
import { getSubscriptionOwnerWallet } from './subscriptionOwner.js';

// ---------------------------------------------------------------------------
// T71 verification §1 — is this server allowed to offer paid evidence at all?
//
// Every one of these was already enforced somewhere: the flag by a 404, the
// chain by a 409, the storage by a 503, the spender by a 503 at prepare time.
// What did NOT exist was a way to ask all of them at once, BEFORE a user is
// shown a button that opens their wallet. That is the whole job here — the
// answer is computed from the same functions the request path uses, never from
// a second reading of the environment, so a preflight that says `ok` and a
// request that 503s cannot both be right.
//
// It fails CLOSED: `ok` is true only when every prerequisite holds. A missing
// prerequisite is never softened into a warning, because the failure mode this
// exists to prevent is a user signing a Spend Permission on a server that then
// cannot charge it — they would have granted real authority for nothing.
//
// Nothing here prints a credential. The RPC endpoint is reported as configured
// or not; the database URL as present or not; CDP keys only as complete or
// incomplete. The spender IS printed, because it is the address the consent
// copy names to the user and they are entitled to check it.
// ---------------------------------------------------------------------------

export const PAID_INTELLIGENCE_PREREQUISITES_V1 = [
  'route_intelligence_flag',
  'paid_intelligence_flag',
  'chain_env',
  'canonical_usdc',
  'base_rpc',
  'database_url',
  'budget_storage',
  'charge_storage',
  'spender_wallet',
  'x402_settlement',
  'simulation_pricing',
] as const;

export type PaidIntelligencePrerequisiteV1 = (typeof PAID_INTELLIGENCE_PREREQUISITES_V1)[number];

export interface PaidPreflightCheckV1 {
  name: PaidIntelligencePrerequisiteV1;
  ok: boolean;
  /** Safe by construction: a state, never a value. */
  detail: string;
}

export interface PaidIntelligencePreflightV1 {
  ok: boolean;
  checks: PaidPreflightCheckV1[];
  blocking: PaidIntelligencePrerequisiteV1[];
  /** Not blocking, but worth an operator's attention. */
  warnings: string[];
  /** The resolved spender when it resolved. Public — it is the recipient. */
  spender: string | null;
  /** Canonical USDC on Base mainnet, as the server itself resolves it. */
  token: string;
  chainId: 8453;
}

/** The tables paid evidence cannot run without. `spend_permissions` is on the
 * list because `intelligence_budgets.spend_permission_id` is a foreign key into
 * it: a budget cannot exist without the permission row it points at. */
export const PAID_INTELLIGENCE_BUDGET_TABLES_V1 = [
  'intelligence_budgets',
  'intelligence_budget_reservations',
] as const;

export const PAID_INTELLIGENCE_CHARGE_TABLES_V1 = ['intelligence_charges', 'spend_permissions'] as const;

export interface PaidIntelligencePreflightDepsV1 {
  flags: (env: NodeJS.ProcessEnv) => { routeIntelligenceV1: boolean; paidIntelligence: boolean };
  readiness: (env: NodeJS.ProcessEnv) => PaidIntelligenceStatusV1;
  pricing: (env: NodeJS.ProcessEnv) => PaidSimulationPricingV1 | null;
  provider: (env: NodeJS.ProcessEnv) => SimulationProviderConfigV1;
  /** Resolves the SAME wallet the charger later draws with. */
  spender: () => Promise<string>;
  /** name -> present. */
  tables: (names: readonly string[]) => Promise<Record<string, boolean>>;
}

async function tablesPresentV1(names: readonly string[]): Promise<Record<string, boolean>> {
  // Spelled out rather than interpolated, exactly like the migration probes the
  // budget routes already use: `to_regclass` takes a literal, and building that
  // literal from a variable is a habit worth not forming in a file that talks to
  // production.
  const rows = await client`
    SELECT
      to_regclass('public.intelligence_budgets') AS intelligence_budgets,
      to_regclass('public.intelligence_budget_reservations') AS intelligence_budget_reservations,
      to_regclass('public.intelligence_charges') AS intelligence_charges,
      to_regclass('public.spend_permissions') AS spend_permissions
  `;
  const row = rows[0] as Record<string, string | null> | undefined;
  const result: Record<string, boolean> = {};
  for (const name of names) result[name] = Boolean(row?.[name]);
  return result;
}

export const paidIntelligencePreflightRuntime: PaidIntelligencePreflightDepsV1 = {
  flags: (env) => getMiorailProductMigrationFlags(env),
  readiness: (env) =>
    paidIntelligenceReadinessV1(getMiorailProductMigrationFlags(env).paidIntelligence, x402ConfigFromEnv(env)),
  pricing: (env) => resolvePaidSimulationPricingV1(env),
  provider: (env) => resolvePaidSimulationProviderV1(env),
  spender: async () => (await getSubscriptionOwnerWallet()).address,
  tables: tablesPresentV1,
};

function missingTablesV1(present: Record<string, boolean>, wanted: readonly string[]): string[] {
  return wanted.filter((name) => present[name] !== true);
}

export async function paidIntelligencePreflightV1(
  deps: PaidIntelligencePreflightDepsV1 = paidIntelligencePreflightRuntime,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PaidIntelligencePreflightV1> {
  const checks: PaidPreflightCheckV1[] = [];
  const warnings: string[] = [];
  const add = (name: PaidIntelligencePrerequisiteV1, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  const flags = deps.flags(env);
  add(
    'route_intelligence_flag',
    flags.routeIntelligenceV1,
    flags.routeIntelligenceV1 ? 'MIORAIL_ROUTE_INTELLIGENCE_V1=true' : 'MIORAIL_ROUTE_INTELLIGENCE_V1 is not true',
  );
  add(
    'paid_intelligence_flag',
    flags.paidIntelligence,
    flags.paidIntelligence ? 'MIORAIL_PAID_INTELLIGENCE=true' : 'MIORAIL_PAID_INTELLIGENCE is not true',
  );

  const chainEnv = (env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  const chainOk = chainEnv === 'mainnet' || chainEnv === 'mainnet-readonly';
  add('chain_env', chainOk, chainOk ? `CHAIN_ENV=${chainEnv}` : `CHAIN_ENV=${chainEnv} — the budget routes answer 409`);
  if (chainEnv === 'mainnet-readonly') {
    warnings.push('CHAIN_ENV=mainnet-readonly — onboarding works, but nothing this server does may broadcast.');
  }

  // Not "is a USDC address configured" but "is the address the server will bind
  // the permission to the canonical one". A permission bound to any other token
  // is unusable and the user cannot tell by looking at their wallet.
  const token = paidEvidenceTokenV1().toLowerCase();
  const canonical = canonicalUsdcForBaseChain(8453).toLowerCase();
  add(
    'canonical_usdc',
    token === canonical,
    token === canonical ? `canonical Base USDC ${canonical}` : `paid evidence would bind ${token}, not ${canonical}`,
  );

  // `rpcUrlForNetwork` falls back to the public endpoint, so "resolves" is not
  // the question — "did an operator choose one" is. The public endpoint meters
  // per call, and permission verification is exactly the moment a throttled read
  // turns into "Miorail could not reach Base" in front of a user who has already
  // opened their wallet.
  const explicitRpc = Boolean((env.BASE_MAINNET_RPC_URL ?? env.BASE_RPC_URL ?? '').trim());
  add('base_rpc', explicitRpc, explicitRpc ? 'configured' : 'BASE_MAINNET_RPC_URL / BASE_RPC_URL are unset');

  const databaseUrl = Boolean((env.DATABASE_URL ?? '').trim());
  add('database_url', databaseUrl, databaseUrl ? 'configured' : 'DATABASE_URL is unset');

  let present: Record<string, boolean> = {};
  let storageReadable = true;
  try {
    present = await deps.tables([...PAID_INTELLIGENCE_BUDGET_TABLES_V1, ...PAID_INTELLIGENCE_CHARGE_TABLES_V1]);
  } catch {
    // Never the cause: a connection error carries the DSN, and the DSN carries
    // the password.
    storageReadable = false;
  }
  if (!storageReadable) {
    add('budget_storage', false, 'the database could not be read');
    add('charge_storage', false, 'the database could not be read');
  } else {
    const missingBudget = missingTablesV1(present, PAID_INTELLIGENCE_BUDGET_TABLES_V1);
    add(
      'budget_storage',
      missingBudget.length === 0,
      missingBudget.length === 0 ? 'migration 0013 applied' : `missing: ${missingBudget.join(', ')}`,
    );
    const missingCharge = missingTablesV1(present, PAID_INTELLIGENCE_CHARGE_TABLES_V1);
    add(
      'charge_storage',
      missingCharge.length === 0,
      missingCharge.length === 0 ? 'migration 0012 applied' : `missing: ${missingCharge.join(', ')}`,
    );
  }

  // The CDP error names a wallet and sometimes a key id, so it is discarded
  // rather than reported: this detail reaches an operator's terminal and their
  // scrollback.
  const resolved = await deps.spender().catch(() => '');
  const spender = /^0x[0-9a-fA-F]{40}$/.test(resolved) ? resolved : null;
  add(
    'spender_wallet',
    spender !== null,
    spender !== null ? spender : 'the subscription owner wallet did not resolve (CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET)',
  );

  // Blocking, and deliberately so. `paidIntelligenceStateV1` returns
  // `settlement_unavailable` when settlement is not ready, and that state offers
  // the user NO action — the enable button is not rendered at all. A server in
  // that condition cannot onboard anyone, whatever else is configured.
  const readiness = deps.readiness(env);
  add(
    'x402_settlement',
    readiness.readiness === 'ready',
    readiness.readiness === 'ready'
      ? 'facilitator can settle'
      : `${readiness.readiness}${readiness.blockedReason ? `: ${readiness.blockedReason}` : ''}`,
  );

  const pricing = deps.pricing(env);
  const provider = deps.provider(env);
  const pricingOk = pricing !== null && provider.configured;
  add(
    'simulation_pricing',
    pricingOk,
    pricing === null
      ? 'MIORAIL_SIMULATION_PRICE_USDC is not a positive USDC decimal'
      : provider.configured
        ? `${pricing.decimalUsdc} USDC per paid check via ${provider.providerId}`
        : `provider ${provider.providerId} is not configured (${provider.missingReason ?? 'unknown'})`,
  );

  const blocking = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    ok: blocking.length === 0,
    checks,
    blocking,
    warnings,
    spender,
    token,
    chainId: 8453,
  };
}
