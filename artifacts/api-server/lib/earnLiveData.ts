import { createPublicClient, http, type Address } from 'viem';
import { base } from 'viem/chains';
import {
  createCuratedEarnDataSourceV1,
  createLiveEarnDataSourceV1,
  type EarnChainReaderV1,
  type EarnDataSourceV1,
  type EarnMoonwellMarketSnapshotV1,
  type EarnYoVaultSnapshotV1,
} from '@mioagent/earn-engine';
import { baseRpcUrlV1 } from './earnPreflight.js';

// ---------------------------------------------------------------------------
// T63A §1/§5 — production wiring for the live earn data sources.
//
// The engine package owns the parsing, the pinned binding and the cache; this
// module owns only the two things that must not live in a pure package: the
// env-derived configuration and the CONCRETE Base-mainnet chain reader. The
// resulting data source is a process-wide singleton so its short-lived cache is
// actually shared across requests (a per-request source would cache nothing).
//
// Everything here is READ-ONLY: the RPC client is a public client built from
// server env, never from request data, and no key is ever loaded.
// ---------------------------------------------------------------------------

function readBoolean(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return defaultValue;
}

function readDurationMs(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return Math.floor(parsed);
}

export interface EarnLiveDataConfigV1 {
  /** false → fall back to the deterministic curated source (kill switch). */
  liveEnabled: boolean;
  /** false → skip the on-chain anchor; Moonwell liquidity/block stay null. */
  chainReadsEnabled: boolean;
  requestTimeoutMs: number;
  freshnessTtlMs: number;
  cacheTtlMs: number;
  cacheErrorTtlMs: number;
  staleServeMs: number;
}

/** Live data is ON by default: T63A replaces the offline fixtures. The flags
 * exist so an operator can fall back without a deploy, not so the fallback is
 * the normal state. */
export function resolveEarnLiveDataConfigV1(env: NodeJS.ProcessEnv = process.env): EarnLiveDataConfigV1 {
  return {
    liveEnabled: readBoolean(env, 'MIORAIL_EARN_LIVE_DATA', true),
    chainReadsEnabled: readBoolean(env, 'MIORAIL_EARN_LIVE_CHAIN_READS', true),
    requestTimeoutMs: readDurationMs(env, 'EARN_LIVE_REQUEST_TIMEOUT_MS', 6_000),
    freshnessTtlMs: readDurationMs(env, 'EARN_LIVE_FRESHNESS_TTL_MS', 5 * 60_000),
    cacheTtlMs: readDurationMs(env, 'EARN_LIVE_CACHE_TTL_MS', 30_000),
    cacheErrorTtlMs: readDurationMs(env, 'EARN_LIVE_CACHE_ERROR_TTL_MS', 5_000),
    staleServeMs: readDurationMs(env, 'EARN_LIVE_STALE_SERVE_MS', 15 * 60_000),
  };
}

// Moonwell markets are Compound-v2 mTokens: `getCash()` is the underlying the
// market holds — exactly what a supplier can withdraw right now — and
// `underlying()` re-confirms the accepted ERC-20 against the pinned asset.
const MOONWELL_MARKET_ABI = [
  { name: 'getCash', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'underlying', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
const YO_VAULT_ABI = [
  { name: 'asset', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'totalAssets', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'convertToShares', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const;

/** The minimal read surface the live anchor needs. A viem PublicClient
 * satisfies it structurally; tests inject a fake so no live RPC is ever made. */
export interface EarnLiveRpcClientV1 {
  getBlockNumber(): Promise<bigint>;
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

/** Concrete Base-mainnet chain reader. Throws on any unreadable value rather
 * than returning a partial snapshot — the caller degrades the liquidity/block
 * fields to null, which reads downstream as "no data, no score". */
export function createViemEarnChainReaderV1(client: EarnLiveRpcClientV1): EarnChainReaderV1 {
  return {
    async readMoonwellMarketSnapshot({ market }): Promise<EarnMoonwellMarketSnapshotV1> {
      const [blockNumber, cash, underlying] = await Promise.all([
        client.getBlockNumber(),
        client.readContract({ address: market as Address, abi: MOONWELL_MARKET_ABI, functionName: 'getCash' }),
        client.readContract({ address: market as Address, abi: MOONWELL_MARKET_ABI, functionName: 'underlying' }),
      ]);
      if (typeof cash !== 'bigint' || cash < 0n) throw new TypeError('moonwell_cash_unreadable');
      if (typeof underlying !== 'string') throw new TypeError('moonwell_underlying_unreadable');
      return {
        blockNumber: blockNumber.toString(),
        underlyingAsset: underlying.toLowerCase() as `0x${string}`,
        availableLiquidityAtomic: cash.toString(),
      };
    },
    async readYoVaultSnapshot({ vault, amountAtomic }): Promise<EarnYoVaultSnapshotV1> {
      const amount = BigInt(amountAtomic);
      const [blockNumber, underlying, totalAssets, totalSupply, expectedShares] = await Promise.all([
        client.getBlockNumber(),
        client.readContract({ address: vault as Address, abi: YO_VAULT_ABI, functionName: 'asset' }),
        client.readContract({ address: vault as Address, abi: YO_VAULT_ABI, functionName: 'totalAssets' }),
        client.readContract({ address: vault as Address, abi: YO_VAULT_ABI, functionName: 'totalSupply' }),
        client.readContract({ address: vault as Address, abi: YO_VAULT_ABI, functionName: 'convertToShares', args: [amount] }),
      ]);
      if (
        typeof underlying !== 'string' || typeof totalAssets !== 'bigint' ||
        typeof totalSupply !== 'bigint' || typeof expectedShares !== 'bigint' ||
        totalAssets < 0n || totalSupply < 0n || expectedShares <= 0n
      ) throw new TypeError('yo_vault_snapshot_unreadable');
      return {
        blockNumber: blockNumber.toString(),
        underlyingAsset: underlying.toLowerCase() as `0x${string}`,
        totalAssetsAtomic: totalAssets.toString(),
        totalSupplyAtomic: totalSupply.toString(),
        expectedSharesAtomic: expectedShares.toString(),
      };
    },
  };
}

export interface EarnDataSourceDepsV1 {
  env?: NodeJS.ProcessEnv;
  createRpcClient?: () => EarnLiveRpcClientV1;
  fetchImpl?: typeof fetch;
}

let cachedSource: EarnDataSourceV1 | null = null;

/** Test hook only — drops the process-wide source (and therefore its cache). */
export function resetEarnDataSourceV1(): void {
  cachedSource = null;
}

/**
 * The earn data source the compare route runs on. Built once per process so
 * the observation cache and its single-flight coalescing are shared by every
 * request, which is what keeps a burst of comparisons down to one upstream call
 * per provider.
 */
export function resolveEarnDataSourceV1(deps: EarnDataSourceDepsV1 = {}): EarnDataSourceV1 {
  if (cachedSource) return cachedSource;
  const env = deps.env ?? process.env;
  const config = resolveEarnLiveDataConfigV1(env);

  if (!config.liveEnabled) {
    cachedSource = createCuratedEarnDataSourceV1({ freshnessWindowMs: config.freshnessTtlMs });
    return cachedSource;
  }

  const chainReader = config.chainReadsEnabled
    ? createViemEarnChainReaderV1(
        deps.createRpcClient?.() ??
          (createPublicClient({ chain: base, transport: http(baseRpcUrlV1(env)) }) as unknown as EarnLiveRpcClientV1),
      )
    : null;

  cachedSource = createLiveEarnDataSourceV1({
    fetchImpl: deps.fetchImpl,
    chainReader,
    timeoutMs: config.requestTimeoutMs,
    freshnessTtlMs: config.freshnessTtlMs,
    cache: {
      ttlMs: config.cacheTtlMs,
      errorTtlMs: config.cacheErrorTtlMs,
      staleServeMs: config.staleServeMs,
    },
  });
  return cachedSource;
}
