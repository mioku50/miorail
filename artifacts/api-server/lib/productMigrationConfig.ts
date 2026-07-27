export interface MiorailProductMigrationFlags {
  routeIntelligenceV1: boolean;
  legacyTerminal: boolean;
  paidIntelligence: boolean;
  earnRouteV1: boolean;
  /** T64: commerce COMPARISON (read-only catalogue reads and scoring). */
  commerceRouteV1: boolean;
  /** T64: commerce CHECKOUT. Separate from the comparison gate on purpose —
   * a digital good is irreversible, so opening a checkout is enabled
   * independently of being able to compare one. */
  commerceExecutionV1: boolean;
  /** T65: NFT COMPARISON — reading a listing and scoring it. */
  nftRouteV1: boolean;
  /** T65: NFT PURCHASE. Separate from the comparison gate: an NFT bought is
   * an NFT bought, so signing is enabled independently of looking. */
  nftExecutionV1: boolean;
  /** T66: Private AI COMPARISON — reading the Venice catalogue and scoring it. */
  privateAiRouteV1: boolean;
  /** T66: Private AI EXECUTION. Separate from the comparison gate: comparing
   * models sends nothing anywhere, and running one sends the user's prompt to
   * a third party. Those are not the same decision. */
  privateAiExecutionV1: boolean;
  /** T67B.1: Aerodrome EXECUTION — selecting the route, building calldata and
   * signing it. Comparison is not gated by this: quoting Aerodrome alongside
   * Uniswap and KyberSwap sends nothing and signs nothing, and stays on
   * whenever route intelligence is on. */
  aerodromeExecutionV1: boolean;
}

function readBooleanFlag(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return defaultValue;
}

/**
 * Typed server-side source of truth for the route-intelligence migration.
 * Invalid or missing values preserve the T49 compatibility baseline: the
 * legacy terminal stays on while both new product capabilities stay off.
 */
export function getMiorailProductMigrationFlags(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<MiorailProductMigrationFlags> {
  return Object.freeze({
    routeIntelligenceV1: readBooleanFlag(env, 'MIORAIL_ROUTE_INTELLIGENCE_V1', false),
    legacyTerminal: readBooleanFlag(env, 'MIORAIL_LEGACY_TERMINAL', true),
    paidIntelligence: readBooleanFlag(env, 'MIORAIL_PAID_INTELLIGENCE', false),
    earnRouteV1: readBooleanFlag(env, 'MIORAIL_EARN_ROUTE_V1', false),
    commerceRouteV1: readBooleanFlag(env, 'MIORAIL_COMMERCE_ROUTE_V1', false),
    commerceExecutionV1: readBooleanFlag(env, 'MIORAIL_COMMERCE_EXECUTION_V1', false),
    nftRouteV1: readBooleanFlag(env, 'MIORAIL_NFT_ROUTE_V1', false),
    nftExecutionV1: readBooleanFlag(env, 'MIORAIL_NFT_EXECUTION_V1', false),
    privateAiRouteV1: readBooleanFlag(env, 'MIORAIL_PRIVATE_AI_ROUTE_V1', false),
    privateAiExecutionV1: readBooleanFlag(env, 'MIORAIL_PRIVATE_AI_EXECUTION_V1', false),
    aerodromeExecutionV1: readBooleanFlag(env, 'MIORAIL_AERODROME_EXECUTION_V1', false),
  });
}
