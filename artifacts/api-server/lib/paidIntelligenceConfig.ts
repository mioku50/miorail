import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';
import {
  resolveSimulationProviderConfigV1,
  type SimulationProviderConfigV1,
} from '@mioagent/paid-intelligence';
import type { AssetRefV1, MoneyV1 } from '@mioagent/route-domain';

const DEFAULT_SIMULATION_PRICE_USDC = '0.01';

function usdcAssetRefV1(): AssetRefV1 {
  const address = canonicalUsdcForBaseChain(8453).toLowerCase() as `0x${string}`;
  return {
    assetId: `eip155:8453/erc20:${address}`,
    chainId: 8453,
    kind: 'erc20',
    address,
    symbol: 'USDC',
    decimals: 6,
  };
}

/** Decimal USDC string ("0.01") -> atomic (base-unit, 6-decimal) string
 * ("10000"). Returns null for anything that isn't a positive decimal with at
 * most 6 fraction digits — an invalid price fails the feature CLOSED rather
 * than silently rounding or charging $0. */
export function decimalUsdcToAtomicV1(decimal: string): string | null {
  const trimmed = decimal.trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const padded = `${fraction}000000`.slice(0, 6);
  const atomic = BigInt(whole) * 1_000_000n + BigInt(padded || '0');
  if (atomic <= 0n) return null;
  return atomic.toString();
}

export interface PaidSimulationPricingV1 {
  /** Atomic USDC amount, for the x402 route's amountAtomicOverride. */
  amountAtomic: string;
  /** The exact same amount as a MoneyV1, for IntelligenceChargeV1's
   * quotedCost/maxAuthorizedCost. */
  price: MoneyV1;
  /** The raw decimal string surfaced to the client in the prepare response
   * (simulationPriceUsdc) and used as the x402 price label pre-payment. */
  decimalUsdc: string;
}

/** Resolves the paid-simulation USDC price strictly from env. Returns null
 * (fail closed — 503 simulation_provider_unavailable, decision 4) when
 * MIORAIL_SIMULATION_PRICE_USDC is set but not a valid positive decimal. */
export function resolvePaidSimulationPricingV1(
  env: NodeJS.ProcessEnv = process.env,
): PaidSimulationPricingV1 | null {
  const decimalUsdc = (env.MIORAIL_SIMULATION_PRICE_USDC ?? DEFAULT_SIMULATION_PRICE_USDC).trim();
  const amountAtomic = decimalUsdcToAtomicV1(decimalUsdc);
  if (!amountAtomic) return null;
  const asset = usdcAssetRefV1();
  return {
    amountAtomic,
    decimalUsdc,
    price: {
      asset,
      amountAtomic,
      amountDecimal: decimalUsdc,
      usdValue: decimalUsdc,
    },
  };
}

export function resolvePaidSimulationProviderV1(env: NodeJS.ProcessEnv = process.env): SimulationProviderConfigV1 {
  return resolveSimulationProviderConfigV1(env);
}

/** Convenience surfaced to /swap/prepare: the decimal USDC price if (and
 * only if) BOTH the price and the provider are validly configured — null
 * otherwise, so the client never advertises a price the feature can't honor. */
export function simulationPriceUsdcForPrepareResponseV1(env: NodeJS.ProcessEnv = process.env): string | null {
  const pricing = resolvePaidSimulationPricingV1(env);
  const provider = resolvePaidSimulationProviderV1(env);
  if (!pricing || !provider.configured) return null;
  return pricing.decimalUsdc;
}
