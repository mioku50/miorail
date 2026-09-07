import {
  callManyV1,
  decodeAddressWordV1,
  decodeStringV1,
  decodeUint8V1,
  decodeUintV1,
  encodeAddressArgV1,
  encodeNoArgsV1,
  selectorV1,
  type B20ReaderV1,
} from '@mioagent/b20-control';
import type { MarketPoolReadingV1, PoolVenueIdV1 } from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// Reading what a pool holds, and deciding which venue it belongs to.
//
// Every fact here comes off the chain at ONE block. Nothing is taken from a
// router's response, an API's label or a list of addresses somebody typed:
// the pool is asked for its own `factory()`, the factory is asked for its own
// `voter()`, and the two answers together name the venue. That matters
// because the published Aerodrome CL factory address is NOT the one most
// tokenized-stock pools sit in — a list would have mislabelled the pool that
// holds nearly all the money.
//
// `balanceOf(pool)` is the measurement. For a concentrated-liquidity pool it
// is every position's tokens, in range or out, plus uncollected fees — which
// is what the contract holds and is NOT what a trade of a given size would
// get. The wording downstream has to keep saying so, because a number that
// looks like depth will be read as depth.
// ---------------------------------------------------------------------------

export const POOL_SELECTORS_V1 = {
  factory: selectorV1('factory()'),
  token0: selectorV1('token0()'),
  token1: selectorV1('token1()'),
  balanceOf: selectorV1('balanceOf(address)'),
  decimals: selectorV1('decimals()'),
  symbol: selectorV1('symbol()'),
  /** Answers on an Aerodrome factory and nowhere else. */
  voter: selectorV1('voter()'),
  // --- protocol discriminators, all read on the FACTORY -------------------
  /** Aerodrome's Slipstream factories enumerate their tick spacings; the v2
   * pool factory does not. Separates concentrated from constant-product
   * without asking a pool. */
  tickSpacings: selectorV1('tickSpacings()'),
  /** PancakeSwap v2's factory publishes the pair init-code hash. Uniswap v2
   * and the plain forks of it do not. */
  initCodePairHash: selectorV1('INIT_CODE_PAIR_HASH()'),
  /** PancakeSwap v3's factory deploys the liquidity-mining pool that its CL
   * pools point back at. Uniswap v3 has no such thing. */
  lmPoolDeployer: selectorV1('lmPoolDeployer()'),
  /** Algebra's plugin architecture. Only Algebra factories answer. */
  defaultPluginFactory: selectorV1('defaultPluginFactory()'),
  /** A v2-style pool factory enumerates its pairs. */
  allPairsLength: selectorV1('allPairsLength()'),
  // --- shape discriminators, read on the POOL ------------------------------
  /** Concentrated liquidity, Uniswap-v3 lineage. */
  slot0: selectorV1('slot0()'),
  /** Constant-product pair. NOTE: an Algebra pool answers this too, so the
   * concentrated check has to come first. */
  getReserves: selectorV1('getReserves()'),
  /** Concentrated liquidity, whatever the lineage. */
  tickSpacing: selectorV1('tickSpacing()'),
} as const;

/**
 * The Aerodrome Voter on Base.
 *
 * This is the ONE address in this file, and it is a discriminator rather than
 * a registry entry: a factory that answers `voter()` with it is an Aerodrome
 * factory, whatever its own address is. Three different Aerodrome factories
 * hold tokenized-stock pools today and all three answer with this.
 */
export const AERODROME_VOTER_V1 = '0x16613524e02ad97edfef371bc883f2f5d6c480a5' as const;

/** Uniswap v3's factory on Base. Named because it answers no discriminator of
 * its own — the address IS the identity, and it is pinned so an unknown
 * factory stays unknown instead of defaulting to the most common answer. */
export const UNISWAP_V3_FACTORY_BASE_V1 = '0x33128a8fc17869897dce68ed026d694621f6fdfd' as const;

export interface PoolIdentityV1 {
  factory: string | null;
  /** Present only for an Aerodrome factory. */
  voter: string | null;
  /** True when the factory exposes `tickSpacing`-style concentrated liquidity.
   * Decided by the caller from the pool, not guessed here. */
  concentrated: boolean;
  /** PancakeSwap v2: the factory answers `INIT_CODE_PAIR_HASH()`. */
  initCodePairHash: boolean;
  /** PancakeSwap v3: the factory answers `lmPoolDeployer()`. */
  lmPoolDeployer: boolean;
  /** Algebra: the factory answers `defaultPluginFactory()`. */
  defaultPluginFactory: boolean;
  /** A v2-style pool factory: it enumerates its pairs. */
  enumeratesPairs: boolean;
}

/**
 * What a POOL says about its own shape, read only when its factory said
 * nothing. One factory serves many pools, so the factory answers first and
 * this is the fallback for the handful it cannot cover — today, pools deployed
 * as minimal-proxy clones behind a factory with no public ABI at all.
 */
export interface PoolShapeV1 {
  /** Answers `slot0()` or `tickSpacing()`. */
  concentrated: boolean;
  /** Answers `getReserves()`. */
  pair: boolean;
}

/**
 * Which venue a factory belongs to, from what the chain said about it.
 *
 * Returns null for a factory that answered and is not one we can name.
 * Unidentified is a state: a pool holding real money must not vanish from the
 * answer because we could not label it.
 */
export function poolVenueFromIdentityV1(
  identity: PoolIdentityV1,
  shape?: PoolShapeV1,
): PoolVenueIdV1 | null {
  if (!identity.factory) return null;
  // Named venues first, each by a method only that protocol publishes.
  if (identity.voter && identity.voter.toLowerCase() === AERODROME_VOTER_V1) {
    return identity.concentrated ? 'aerodrome_cl' : 'aerodrome_v2';
  }
  if (identity.factory.toLowerCase() === UNISWAP_V3_FACTORY_BASE_V1) return 'uniswap_v3';
  if (identity.defaultPluginFactory) return 'algebra_cl';
  if (identity.lmPoolDeployer) return 'pancakeswap_v3';
  if (identity.initCodePairHash) return 'pancakeswap_v2';
  // Then the shape, which says less but is still an answer. Concentrated is
  // tested before pair: an Algebra pool answers `getReserves()` as well, and a
  // concentrated pool called a pair would misdescribe how its liquidity sits.
  if (identity.concentrated) return 'unnamed_cl';
  if (identity.enumeratesPairs) return 'unnamed_pair';
  if (shape?.concentrated) return 'unnamed_cl';
  if (shape?.pair) return 'unnamed_pair';
  return null;
}

export interface PoolMeasurementInputV1 {
  reader: B20ReaderV1;
  chainId: 8453;
  /** The token the readings are about. */
  tokenAddress: string;
  tokenDecimals: number;
  pools: readonly string[];
  blockNumber: number;
  blockTag: string;
  readAt: string;
  /** Venue identity per factory, read once and reused — a factory serves many
   * pools and asking it once per pool would pay for the same answer thirty
   * times. */
  factoryIdentity: ReadonlyMap<string, PoolIdentityV1>;
  /** Shape per pool, for the pools whose factory placed them nowhere. Optional:
   * a caller that has not read shapes gets exactly the venues the factories
   * prove, never a guess. */
  poolShapes?: ReadonlyMap<string, PoolShapeV1>;
}

export interface PoolMeasurementOutcomeV1 {
  readings: MarketPoolReadingV1[];
  /** Addresses that answered no `factory()`. Kept as a count, never silently
   * folded into the readings: "not a pool" is an answer about the address. */
  notPools: string[];
  /** Pools whose own token balance could not be read at all. A pool we failed
   * to read is not a pool holding nothing. */
  unread: string[];
}

const lower = (value: string) => value.toLowerCase();

/**
 * Measure a token's balance in each pool, plus the other side of each pair.
 *
 * Every call is made at the SAME block tag. A pool read at block N against a
 * pair read at block N+3 is two facts about two markets presented as one, and
 * the difference shows up exactly when the market is moving.
 */
export async function measurePoolsV1(
  input: PoolMeasurementInputV1,
): Promise<PoolMeasurementOutcomeV1> {
  const token = lower(input.tokenAddress);
  const pools = [...new Set(input.pools.map(lower))];
  if (pools.length === 0) return { readings: [], notPools: [], unread: [] };

  // Pass one: what each pool is, and what it holds of the token we asked about.
  const shape = await callManyV1(
    input.reader,
    pools.flatMap((pool) => [
      { to: pool, data: encodeNoArgsV1(POOL_SELECTORS_V1.factory), blockTag: input.blockTag },
      { to: pool, data: encodeNoArgsV1(POOL_SELECTORS_V1.token0), blockTag: input.blockTag },
      { to: pool, data: encodeNoArgsV1(POOL_SELECTORS_V1.token1), blockTag: input.blockTag },
      {
        to: token,
        data: encodeAddressArgV1(POOL_SELECTORS_V1.balanceOf, pool),
        blockTag: input.blockTag,
      },
    ]),
  );

  const notPools: string[] = [];
  const unread: string[] = [];
  const pending: {
    pool: string;
    factory: string | null;
    paired: string | null;
    balance: bigint;
  }[] = [];

  for (const [index, pool] of pools.entries()) {
    const at = index * 4;
    const factoryResult = shape[at];
    const token0Result = shape[at + 1];
    const token1Result = shape[at + 2];
    const balanceResult = shape[at + 3];

    const factory = factoryResult?.ok ? decodeAddressWordV1(factoryResult.value) : null;
    const token0 = token0Result?.ok ? decodeAddressWordV1(token0Result.value) : null;
    const token1 = token1Result?.ok ? decodeAddressWordV1(token1Result.value) : null;
    const balance = balanceResult?.ok ? decodeUintV1(balanceResult.value) : null;

    if (balance === null) {
      // The token itself refused to say what this address holds. That is a
      // failed read, not a zero: storing zero would report an unmeasured pool
      // as an empty one, which is the exact lie this product refuses.
      unread.push(pool);
      continue;
    }
    if (factory === null) notPools.push(pool);

    const other = token0 && lower(token0) !== token ? token0 : token1 && lower(token1) !== token ? token1 : null;
    pending.push({ pool, factory: factory ? lower(factory) : null, paired: other ? lower(other) : null, balance });
  }

  // Pass two: the other side of each pair, valued in its own units. Read once
  // per distinct token rather than once per pool.
  const pairedTokens = [...new Set(pending.map((row) => row.paired).filter((v): v is string => v !== null))];
  const pairedMeta = await callManyV1(
    input.reader,
    pairedTokens.flatMap((paired) => [
      { to: paired, data: encodeNoArgsV1(POOL_SELECTORS_V1.decimals), blockTag: input.blockTag },
      { to: paired, data: encodeNoArgsV1(POOL_SELECTORS_V1.symbol), blockTag: input.blockTag },
    ]),
  );
  const pairedInfo = new Map<string, { decimals: number | null; symbol: string | null }>();
  for (const [index, paired] of pairedTokens.entries()) {
    const decimalsResult = pairedMeta[index * 2];
    const symbolResult = pairedMeta[index * 2 + 1];
    pairedInfo.set(paired, {
      decimals: decimalsResult?.ok ? decodeUint8V1(decimalsResult.value) : null,
      symbol: symbolResult?.ok ? decodeStringV1(symbolResult.value) : null,
    });
  }

  const pairedBalances = await callManyV1(
    input.reader,
    pending
      .filter((row) => row.paired !== null)
      .map((row) => ({
        to: row.paired as string,
        data: encodeAddressArgV1(POOL_SELECTORS_V1.balanceOf, row.pool),
        blockTag: input.blockTag,
      })),
  );

  const readings: MarketPoolReadingV1[] = [];
  let pairedCursor = 0;
  for (const row of pending) {
    let pairedBalance: bigint | null = null;
    if (row.paired !== null) {
      const result = pairedBalances[pairedCursor];
      pairedCursor += 1;
      pairedBalance = result?.ok ? decodeUintV1(result.value) : null;
    }
    const info = row.paired ? pairedInfo.get(row.paired) : undefined;
    const decimals = info?.decimals ?? null;
    // All-or-nothing, and decided here rather than by the store: a pair whose
    // decimals we could not read cannot be rendered as an amount at all.
    const pairedComplete = row.paired !== null && pairedBalance !== null && decimals !== null;

    const identity = row.factory ? input.factoryIdentity.get(row.factory) : undefined;
    const venueId = identity
      ? poolVenueFromIdentityV1(identity, input.poolShapes?.get(row.pool))
      : null;

    readings.push({
      chainId: input.chainId,
      poolAddress: row.pool,
      tokenAddress: token,
      venueId,
      factoryAddress: row.factory,
      tokenBalanceAtomic: row.balance.toString(),
      tokenDecimals: input.tokenDecimals,
      pairedTokenAddress: pairedComplete ? row.paired : null,
      pairedBalanceAtomic: pairedComplete ? (pairedBalance as bigint).toString() : null,
      pairedDecimals: pairedComplete ? decimals : null,
      // The symbol is a label, not a fact the row depends on: a pair with an
      // unreadable symbol still renders by address.
      pairedSymbol: pairedComplete ? (info?.symbol ?? null) : null,
      blockNumber: input.blockNumber,
      readAt: input.readAt,
    });
  }

  return { readings, notPools, unread };
}

/**
 * Ask each factory who it answers to, once.
 *
 * `concentrated` is decided by whether the factory exposes a tick spacing
 * enumerator — the shape that separates Aerodrome's Slipstream factories from
 * its v2 pool factory. A factory that answers neither is still recorded, with
 * its identity unknown, because dropping it would drop its pools.
 */
const FACTORY_PROBES_V1 = [
  POOL_SELECTORS_V1.voter,
  POOL_SELECTORS_V1.tickSpacings,
  POOL_SELECTORS_V1.initCodePairHash,
  POOL_SELECTORS_V1.lmPoolDeployer,
  POOL_SELECTORS_V1.defaultPluginFactory,
  POOL_SELECTORS_V1.allPairsLength,
] as const;

export async function readFactoryIdentityV1(input: {
  reader: B20ReaderV1;
  factories: readonly string[];
  blockTag: string;
}): Promise<Map<string, PoolIdentityV1>> {
  const factories = [...new Set(input.factories.map(lower))];
  if (factories.length === 0) return new Map();
  const width = FACTORY_PROBES_V1.length;
  const results = await callManyV1(
    input.reader,
    factories.flatMap((factory) =>
      FACTORY_PROBES_V1.map((selector) => ({
        to: factory,
        data: encodeNoArgsV1(selector),
        blockTag: input.blockTag,
      })),
    ),
  );
  const identity = new Map<string, PoolIdentityV1>();
  for (const [index, factory] of factories.entries()) {
    const base = index * width;
    const voterResult = results[base];
    const voter = voterResult?.ok ? decodeAddressWordV1(voterResult.value) : null;
    identity.set(factory, {
      factory,
      voter: voter ? lower(voter) : null,
      concentrated: Boolean(results[base + 1]?.ok),
      initCodePairHash: Boolean(results[base + 2]?.ok),
      lmPoolDeployer: Boolean(results[base + 3]?.ok),
      defaultPluginFactory: Boolean(results[base + 4]?.ok),
      enumeratesPairs: Boolean(results[base + 5]?.ok),
    });
  }
  return identity;
}

/**
 * Ask the pools their own shape — only the ones their factory could not place.
 *
 * A factory answer covers every pool it made, so this runs on the remainder:
 * three pools today, deployed as minimal-proxy clones behind a factory that
 * publishes no method at all. Reading every pool would pay nine calls per pool
 * for an answer six of them already have.
 */
export async function readPoolShapesV1(input: {
  reader: B20ReaderV1;
  pools: readonly string[];
  blockTag: string;
}): Promise<Map<string, PoolShapeV1>> {
  const pools = [...new Set(input.pools.map(lower))];
  if (pools.length === 0) return new Map();
  const results = await callManyV1(
    input.reader,
    pools.flatMap((pool) => [
      { to: pool, data: encodeNoArgsV1(POOL_SELECTORS_V1.slot0), blockTag: input.blockTag },
      { to: pool, data: encodeNoArgsV1(POOL_SELECTORS_V1.tickSpacing), blockTag: input.blockTag },
      { to: pool, data: encodeNoArgsV1(POOL_SELECTORS_V1.getReserves), blockTag: input.blockTag },
    ]),
  );
  const shapes = new Map<string, PoolShapeV1>();
  for (const [index, pool] of pools.entries()) {
    const base = index * 3;
    shapes.set(pool, {
      concentrated: Boolean(results[base]?.ok) || Boolean(results[base + 1]?.ok),
      pair: Boolean(results[base + 2]?.ok),
    });
  }
  return shapes;
}
