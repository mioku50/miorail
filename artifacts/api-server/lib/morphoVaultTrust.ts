import { BASE_MAINNET_CHAIN_ID, getBaseMainnetUsdcAddress } from '@mioagent/security';

export interface TrustedMorphoVault {
  address: string;
  name: string;
  tvlUsd: number;
  apyPct: number;
  apySource: string;
  feePct: number;
  riskLabel: string;
  verificationRank: number;
}

export interface MorphoVaultTrustConfig {
  minTvlUsd: number;
  maxApyPct: number;
  trustedVaultAddresses: Set<string>;
}

const BLOCKED_NAME_MARKERS = /\b(test|testing|demo|mock|fake|spam|scam|deprecated|honeypot)\b/i;
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

function positiveEnvNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function morphoVaultTrustConfigFromEnv(): MorphoVaultTrustConfig {
  const trustedVaultAddresses = new Set(
    (process.env.MORPHO_TRUSTED_VAULT_ADDRESSES || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => ADDRESS_PATTERN.test(value)),
  );
  return {
    minTvlUsd: positiveEnvNumber('MORPHO_MIN_TVL_USD', 1_000_000),
    maxApyPct: positiveEnvNumber('MORPHO_MAX_APY_PCT', 100),
    trustedVaultAddresses,
  };
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function extractApy(vault: Record<string, any>): { value: number; source: string } | null {
  const apyPct = numeric(vault.apyPct);
  if (apyPct !== null) return { value: apyPct, source: 'Morpho apyPct' };

  const avgNetApy = numeric(vault.avgNetApy);
  if (avgNetApy !== null) {
    return { value: Math.abs(avgNetApy) <= 1 ? avgNetApy * 100 : avgNetApy, source: 'Morpho avgNetApy (net)' };
  }

  const netApy = numeric(vault.netApy);
  if (netApy !== null) {
    return { value: Math.abs(netApy) <= 1 ? netApy * 100 : netApy, source: 'Morpho netApy' };
  }
  return null;
}

function vaultArray(payload: unknown): { chain: unknown; vaults: unknown[] } {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const candidate = Array.isArray(root?.vaults)
    ? root?.vaults
    : Array.isArray(data?.vaults)
      ? data?.vaults
      : [];
  return { chain: root?.chain ?? data?.chain, vaults: candidate };
}

function isBaseMainnet(chain: unknown): boolean {
  const normalized = String(chain ?? '').trim().toLowerCase();
  return normalized === 'base' || normalized === String(BASE_MAINNET_CHAIN_ID) || normalized === `eip155:${BASE_MAINNET_CHAIN_ID}`;
}

export function filterTrustedMorphoVaults(
  payload: unknown,
  config: MorphoVaultTrustConfig = morphoVaultTrustConfigFromEnv(),
): TrustedMorphoVault[] {
  const extracted = vaultArray(payload);
  if (!isBaseMainnet(extracted.chain)) return [];

  const canonicalUsdc = getBaseMainnetUsdcAddress().toLowerCase();
  const trusted: TrustedMorphoVault[] = [];
  for (const raw of extracted.vaults) {
    const vault = asRecord(raw);
    if (!vault) continue;
    const address = String(vault.address || '').toLowerCase();
    const name = String(vault.name || '').trim();
    const asset = asRecord(vault.asset);
    const assetAddress = String(asset?.address || vault.assetAddress || '').toLowerCase();
    const assetSymbol = String(asset?.symbol || vault.assetSymbol || '').toUpperCase();
    const tvlUsd = numeric(vault.tvlUsd ?? vault.tvl?.usd ?? vault.tvl?.valueUsd);
    const apy = extractApy(vault);
    const feePct = numeric(vault.feePct ?? vault.feePercentage ?? vault.fee) ?? 0;

    if (!ADDRESS_PATTERN.test(address) || !name || BLOCKED_NAME_MARKERS.test(name)) continue;
    if (assetAddress !== canonicalUsdc || assetSymbol !== 'USDC') continue;
    if (tvlUsd === null || tvlUsd < config.minTvlUsd) continue;
    if (!apy || apy.value < 0 || apy.value > config.maxApyPct) continue;
    if (feePct < 0 || feePct > 100) continue;

    const allowlisted = config.trustedVaultAddresses.has(address);
    const explicitlyVerified = vault.verified === true || vault.isVerified === true;
    const curated = vault.curated === true || vault.isCurated === true || ADDRESS_PATTERN.test(String(vault.curator || ''));
    if (!allowlisted && !explicitlyVerified && !curated) continue;

    trusted.push({
      address,
      name: name.slice(0, 120),
      tvlUsd,
      apyPct: apy.value,
      apySource: apy.source,
      feePct,
      verificationRank: allowlisted || explicitlyVerified ? 2 : 1,
      riskLabel: allowlisted || explicitlyVerified
        ? 'Verified/allowlisted metadata; protocol risk remains'
        : 'Curated vault; verify curator and allocations',
    });
  }

  return trusted
    .sort((a, b) => b.verificationRank - a.verificationRank || b.tvlUsd - a.tvlUsd)
    .slice(0, 10);
}

function usd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatTrustedMorphoVaults(vaults: TrustedMorphoVault[]): string {
  return vaults.map((vault, index) => [
    `${index + 1}. ${vault.name} (${vault.address})`,
    `TVL: ${usd(vault.tvlUsd)} · APY: ${vault.apyPct.toFixed(2)}% (${vault.apySource}) · Fee: ${vault.feePct.toFixed(2)}%`,
    `Risk: ${vault.riskLabel}`,
  ].join('\n')).join('\n\n');
}
