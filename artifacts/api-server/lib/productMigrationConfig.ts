export interface MiorailProductMigrationFlags {
  routeIntelligenceV1: boolean;
  legacyTerminal: boolean;
  paidIntelligence: boolean;
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
  });
}
