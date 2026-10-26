// What Still reads from Base for one wallet, in two steps:
//
// 1. The universe (cached by the caller for minutes): the spoke's reserve list, the oracle,
//    Morpho market parameters. Every address is checked against the code-owned registry, and a
//    mismatch closes that venue instead of trusting the chain blindly.
// 2. The wallet snapshot: one Multicall3 batch at the latest block (balances, positions, prices,
//    configs, caps), then one batch at that same block for what depends on the first
//    (Morpho interest since the last update, configs an older position is still held under).

import { decodeAbiParameters, type Address, type Hex } from 'viem';
import {
  COINBASE_REGISTRY_SELECTOR,
  aaveHubAbi,
  aaveOracleAbi,
  aaveSpokeAbi,
  chainlinkFeedAbi,
  erc20Abi,
  morphoAbi,
  morphoIrmAbi,
  morphoOracleAbi,
  multicall3Abi,
} from './abi.js';
import type { MorphoMarketTotalsV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { ADDRESSES, CRYPTO, STOCKS, stockByToken, type CryptoAsset, type CryptoId, type StockAsset, type StockId } from './registry.js';
import { Batch, type Outcome, type Provider, type Slot } from './rpc.js';

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface AaveReserveInfo {
  reserveId: number;
  underlying: Address;
  hubAssetId: number;
  decimals: number;
  dynamicConfigKey: number;
  priceSource: Address | null;
  role: { kind: 'stock'; asset: StockAsset } | { kind: 'usdc' } | { kind: 'other' };
}

export interface MorphoParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface MorphoMarketInfo {
  asset: CryptoAsset;
  id: Hex;
  params: MorphoParams;
}

export type AaveUniverse =
  | { ok: true; oracleDecimals: number; reserves: AaveReserveInfo[]; usdc: AaveReserveInfo; noCap: bigint }
  | { ok: false; problem: 'unreadable' | 'oracle_changed' | 'usdc_reserve_missing' };

export type MorphoUniverse =
  | { ok: true; market: MorphoMarketInfo }
  | { ok: false; asset: CryptoAsset; problem: 'unreadable' | 'market_mismatch' };

export interface Universe {
  loadedAt: Date;
  provider: string;
  aave: AaveUniverse;
  morpho: MorphoUniverse[];
}

export async function loadUniverse(providers: readonly Provider[]): Promise<Universe> {
  const first = new Batch();
  const oracle = first.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'ORACLE', []);
  const count = first.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getReserveCount', []);
  const oracleDecimals = first.add(ADDRESSES.aaveOracle, aaveOracleAbi, 'decimals', []);
  const noCap = first.add(ADDRESSES.aaveHub, aaveHubAbi, 'MAX_ALLOWED_SPOKE_CAP', []);
  const params = CRYPTO.map((asset) => ({ asset, slot: first.add(ADDRESSES.morpho, morphoAbi, 'idToMarketParams', [asset.morphoMarket]) }));
  const { provider } = await first.run(providers);

  const morpho: MorphoUniverse[] = params.map(({ asset, slot }) => {
    if (!slot.outcome.ok) return { ok: false, asset, problem: 'unreadable' };
    const [loanToken, collateralToken, oracleAddress, irm, lltv] = slot.outcome.value;
    const matches = same(loanToken, ADDRESSES.usdc) && same(collateralToken, asset.token) && lltv > 0n && !same(oracleAddress, ZERO_ADDRESS);
    if (!matches) return { ok: false, asset, problem: 'market_mismatch' };
    return { ok: true, market: { asset, id: asset.morphoMarket, params: { loanToken, collateralToken, oracle: oracleAddress, irm, lltv } } };
  });

  const base = { loadedAt: new Date(), provider, morpho };
  if (!oracle.outcome.ok || !count.outcome.ok || !oracleDecimals.outcome.ok || !noCap.outcome.ok) {
    return { ...base, aave: { ok: false, problem: 'unreadable' } };
  }
  if (!same(oracle.outcome.value, ADDRESSES.aaveOracle)) return { ...base, aave: { ok: false, problem: 'oracle_changed' } };

  const second = new Batch();
  const n = Number(count.outcome.value);
  const slots = Array.from({ length: n }, (_, i) => ({
    reserve: second.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getReserve', [BigInt(i)]),
    source: second.add(ADDRESSES.aaveOracle, aaveOracleAbi, 'getReserveSource', [BigInt(i)]),
  }));
  if (n > 0) await second.run(providers);

  const reserves: AaveReserveInfo[] = [];
  for (const [reserveId, { reserve, source }] of slots.entries()) {
    if (!reserve.outcome.ok) return { ...base, aave: { ok: false, problem: 'unreadable' } };
    const r = reserve.outcome.value;
    const stock = stockByToken(r.underlying);
    const onOurHub = same(r.hub, ADDRESSES.aaveHub);
    const role: AaveReserveInfo['role'] =
      onOurHub && stock && r.decimals === stock.decimals
        ? { kind: 'stock', asset: stock }
        : onOurHub && same(r.underlying, ADDRESSES.usdc) && r.decimals === 6
          ? { kind: 'usdc' }
          : { kind: 'other' };
    reserves.push({
      reserveId,
      underlying: r.underlying,
      hubAssetId: r.assetId,
      decimals: r.decimals,
      dynamicConfigKey: r.dynamicConfigKey,
      priceSource: source.outcome.ok ? source.outcome.value : null,
      role,
    });
  }
  const usdc = reserves.filter((r) => r.role.kind === 'usdc');
  if (usdc.length !== 1) return { ...base, aave: { ok: false, problem: 'usdc_reserve_missing' } };
  return {
    ...base,
    aave: { ok: true, oracleDecimals: oracleDecimals.outcome.value, reserves, usdc: usdc[0]!, noCap: BigInt(noCap.outcome.value) },
  };
}

export interface AaveReserveSnapshot {
  info: AaveReserveInfo;
  config: Outcome<{ paused: boolean; frozen: boolean; borrowable: boolean }>;
  /** Collateral factor new borrowing is judged by (the reserve's latest dynamic config). */
  factorBps: Outcome<bigint>;
  /** Collateral factor the wallet's existing position is still held under. */
  userFactorBps: Outcome<bigint>;
  price: Outcome<bigint>;
  priceUpdatedAt: Outcome<bigint>;
  supplied: Outcome<bigint>;
  status: Outcome<{ usingAsCollateral: boolean; borrowing: boolean }>;
  spokeConfig: Outcome<{ addCap: bigint; drawCap: bigint; active: boolean; halted: boolean }>;
  spokeAdded: Outcome<bigint>;
}

export interface AaveSnapshot {
  reserves: AaveReserveSnapshot[];
  usdcDebt: Outcome<bigint>;
  usdcLiquidity: Outcome<bigint>;
  usdcDrawnRateRay: Outcome<bigint>;
  usdcSpokeOwed: Outcome<bigint>;
  account: Outcome<{ healthFactor: bigint; borrowCount: bigint }>;
}

export interface MorphoSnapshot {
  info: MorphoMarketInfo;
  /** Market totals as stored at the last update; accrue with borrowRatePerSecond to the block. */
  market: Outcome<MorphoMarketTotalsV1>;
  position: Outcome<{ borrowShares: bigint; collateral: bigint }>;
  /** Collateral price in loan-token units, scaled by 1e36. */
  price: Outcome<bigint>;
  borrowRatePerSecond: Outcome<bigint>;
}

export interface WalletSnapshot {
  provider: string;
  block: { number: bigint; timestamp: bigint };
  nativeEth: Outcome<bigint>;
  balances: Map<string, Outcome<bigint>>;
  coinbase: Map<StockId, Outcome<{ multiplier: bigint; paused: boolean }>>;
  aave: AaveSnapshot | null;
  morpho: Map<CryptoId, MorphoSnapshot | null>;
}

const failed = <T>(reason: 'reverted' | 'undecodable' = 'reverted'): Outcome<T> => ({ ok: false, reason });
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });

function map<T, U>(outcome: Outcome<T>, f: (value: T) => U): Outcome<U> {
  return outcome.ok ? ok(f(outcome.value)) : outcome;
}

function decodeRegistry(data: Hex): { multiplier: bigint; paused: boolean } {
  const [multiplier, paused] = decodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], data);
  return { multiplier, paused };
}

export async function readWallet(providers: readonly Provider[], universe: Universe, user: Address): Promise<WalletSnapshot> {
  const batch = new Batch();
  const blockNumber = batch.add(ADDRESSES.multicall3, multicall3Abi, 'getBlockNumber', []);
  const blockTime = batch.add(ADDRESSES.multicall3, multicall3Abi, 'getCurrentBlockTimestamp', []);
  const nativeEth = batch.add(ADDRESSES.multicall3, multicall3Abi, 'getEthBalance', [user]);

  const tokens = [...STOCKS.map((s) => s.token), ...CRYPTO.map((c) => c.token)];
  const balanceSlots = tokens.map((token) => [token.toLowerCase(), batch.add(token, erc20Abi, 'balanceOf', [user])] as const);
  const registrySlots = STOCKS.map((s) => {
    const callData = `${COINBASE_REGISTRY_SELECTOR}${s.token.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
    return [s.id, batch.raw(ADDRESSES.coinbaseStockRegistry, callData, decodeRegistry)] as const;
  });

  type AavePlan = {
    info: AaveReserveInfo;
    reserve: Slot<{ dynamicConfigKey: number }>;
    config: Slot<{ paused: boolean; frozen: boolean; borrowable: boolean }>;
    dynamic: Slot<{ collateralFactor: number }>;
    price: Slot<bigint>;
    source: Slot<Address>;
    feed: Slot<readonly [bigint, bigint, bigint, bigint, bigint]> | null;
    supplied: Slot<bigint>;
    status: Slot<readonly [boolean, boolean]>;
    position: Slot<{ dynamicConfigKey: number }>;
    spokeConfig: Slot<{ addCap: number; drawCap: number; active: boolean; halted: boolean }>;
    spokeAdded: Slot<bigint>;
  };
  let aavePlan: { reserves: AavePlan[]; usdc: AaveReserveInfo; debt: Slot<bigint>; liquidity: Slot<bigint>; rate: Slot<bigint>; owed: Slot<bigint>; account: Slot<{ healthFactor: bigint; borrowCount: bigint }> } | null = null;
  if (universe.aave.ok) {
    const { reserves, usdc } = universe.aave;
    aavePlan = {
      usdc,
      reserves: reserves.map((info) => {
        const id = BigInt(info.reserveId);
        return {
          info,
          reserve: batch.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getReserve', [id]),
          config: batch.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getReserveConfig', [id]),
          dynamic: batch.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getDynamicReserveConfig', [id, info.dynamicConfigKey]),
          price: batch.add(ADDRESSES.aaveOracle, aaveOracleAbi, 'getReservePrice', [id]),
          source: batch.add(ADDRESSES.aaveOracle, aaveOracleAbi, 'getReserveSource', [id]),
          feed: info.role.kind === 'stock' && info.priceSource ? batch.add(info.priceSource, chainlinkFeedAbi, 'latestRoundData', []) : null,
          supplied: batch.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getUserSuppliedAssets', [id, user]),
          status: batch.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getUserReserveStatus', [id, user]),
          position: batch.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getUserPosition', [id, user]),
          spokeConfig: batch.add(ADDRESSES.aaveHub, aaveHubAbi, 'getSpokeConfig', [BigInt(info.hubAssetId), ADDRESSES.aaveSpoke]),
          spokeAdded: batch.add(ADDRESSES.aaveHub, aaveHubAbi, 'getSpokeAddedAssets', [BigInt(info.hubAssetId), ADDRESSES.aaveSpoke]),
        };
      }),
      debt: batch.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getUserTotalDebt', [BigInt(usdc.reserveId), user]),
      liquidity: batch.add(ADDRESSES.aaveHub, aaveHubAbi, 'getAssetLiquidity', [BigInt(usdc.hubAssetId)]),
      rate: batch.add(ADDRESSES.aaveHub, aaveHubAbi, 'getAssetDrawnRate', [BigInt(usdc.hubAssetId)]),
      owed: batch.add(ADDRESSES.aaveHub, aaveHubAbi, 'getSpokeTotalOwed', [BigInt(usdc.hubAssetId), ADDRESSES.aaveSpoke]),
      account: batch.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getUserAccountData', [user]),
    };
  }

  const morphoPlans = universe.morpho.map((entry) => {
    if (!entry.ok) return { asset: entry.asset, plan: null };
    const { market } = entry;
    return {
      asset: entry.market.asset,
      plan: {
        info: market,
        market: batch.add(ADDRESSES.morpho, morphoAbi, 'market', [market.id]),
        position: batch.add(ADDRESSES.morpho, morphoAbi, 'position', [market.id, user]),
        price: batch.add(market.params.oracle, morphoOracleAbi, 'price', []),
      },
    };
  });

  const { provider } = await batch.run(providers);
  if (!blockNumber.outcome.ok || !blockTime.outcome.ok) throw new Error('multicall answered without its own block number');
  const block = { number: blockNumber.outcome.value, timestamp: blockTime.outcome.value };
  // The follow-up runs on the provider that answered first when it can, at the same block.
  const ordered = [...providers].sort((a, b) => Number(b.label === provider) - Number(a.label === provider));

  // Follow-up batch: interest since the last Morpho update, and old configs the wallet is held under.
  const follow = new Batch();
  const morphoFollow = morphoPlans.map(({ asset, plan }) => {
    if (!plan || !plan.market.outcome.ok) return { asset, plan, rate: null };
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = plan.market.outcome.value;
    const state = { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee };
    const rate = same(plan.info.params.irm, ZERO_ADDRESS)
      ? null
      : follow.add(plan.info.params.irm, morphoIrmAbi, 'borrowRateView', [plan.info.params, state]);
    return { asset, plan, rate };
  });
  const userConfigs = new Map<number, Slot<{ collateralFactor: number }>>();
  if (aavePlan) {
    for (const r of aavePlan.reserves) {
      const userKey = r.position.outcome.ok ? r.position.outcome.value.dynamicConfigKey : null;
      const latestKey = r.reserve.outcome.ok ? r.reserve.outcome.value.dynamicConfigKey : null;
      // A key that moved since the universe was loaded is read again, so the factor is current.
      for (const key of [userKey, latestKey]) {
        if (key !== null && key !== r.info.dynamicConfigKey && !userConfigs.has(key * 1_000 + r.info.reserveId)) {
          userConfigs.set(key * 1_000 + r.info.reserveId, follow.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getDynamicReserveConfig', [BigInt(r.info.reserveId), key]));
        }
      }
    }
  }
  if (follow.size > 0) await follow.run(ordered, block.number);

  const factorAt = (r: AavePlan, key: number | null): Outcome<bigint> => {
    if (key === null) return failed();
    const slot = key === r.info.dynamicConfigKey ? r.dynamic : userConfigs.get(key * 1_000 + r.info.reserveId);
    return slot ? map(slot.outcome, (c) => BigInt(c.collateralFactor)) : failed();
  };

  let aave: AaveSnapshot | null = null;
  if (aavePlan) {
    aave = {
      reserves: aavePlan.reserves.map((r) => {
        const latestKey = r.reserve.outcome.ok ? r.reserve.outcome.value.dynamicConfigKey : null;
        const userKey = r.position.outcome.ok ? r.position.outcome.value.dynamicConfigKey : null;
        // The feed's clock is only trusted while the oracle still points at the feed we asked.
        const sourceUnchanged = r.source.outcome.ok && r.info.priceSource !== null && same(r.source.outcome.value, r.info.priceSource);
        return {
          info: r.info,
          config: map(r.config.outcome, (c) => ({ paused: c.paused, frozen: c.frozen, borrowable: c.borrowable })),
          factorBps: factorAt(r, latestKey),
          userFactorBps: factorAt(r, userKey),
          price: r.price.outcome,
          priceUpdatedAt: r.feed && sourceUnchanged ? map(r.feed.outcome, (round) => round[3]) : failed(),
          supplied: r.supplied.outcome,
          status: map(r.status.outcome, ([usingAsCollateral, borrowing]) => ({ usingAsCollateral, borrowing })),
          spokeConfig: map(r.spokeConfig.outcome, (c) => ({ addCap: BigInt(c.addCap), drawCap: BigInt(c.drawCap), active: c.active, halted: c.halted })),
          spokeAdded: r.spokeAdded.outcome,
        };
      }),
      usdcDebt: aavePlan.debt.outcome,
      usdcLiquidity: aavePlan.liquidity.outcome,
      usdcDrawnRateRay: aavePlan.rate.outcome,
      usdcSpokeOwed: aavePlan.owed.outcome,
      account: map(aavePlan.account.outcome, (a) => ({ healthFactor: a.healthFactor, borrowCount: a.borrowCount })),
    };
  }

  const morpho = new Map<CryptoId, MorphoSnapshot | null>();
  for (const { asset, plan, rate } of morphoFollow) {
    if (!plan) {
      morpho.set(asset.id, null);
      continue;
    }
    const rateOutcome: Outcome<bigint> = rate ? rate.outcome : ok(0n);
    morpho.set(asset.id, {
      info: plan.info,
      market: map(plan.market.outcome, ([totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee]) => ({
        totalSupplyAssets,
        totalSupplyShares,
        totalBorrowAssets,
        totalBorrowShares,
        lastUpdate,
        fee,
      })),
      position: map(plan.position.outcome, ([, borrowShares, collateral]) => ({ borrowShares, collateral })),
      price: plan.price.outcome,
      borrowRatePerSecond: rateOutcome,
    });
  }

  return {
    provider,
    block,
    nativeEth: nativeEth.outcome,
    balances: new Map(balanceSlots.map(([token, slot]) => [token, slot.outcome])),
    coinbase: new Map(registrySlots.map(([id, slot]) => [id, slot.outcome])),
    aave,
    morpho,
  };
}
