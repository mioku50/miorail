// Hand-built universe and snapshot in the exact shapes read.ts produces, for the example
// portfolio in docs/DESIGN.md: 4.2 NVDAc (3.4 pledged on Aave), 1.5 AAPLc, 0.8 TSLAc and
// 0.012 cbBTC, $240.17 owed. Prices are the ones the design was drawn with.

import type { Address } from 'viem';
import type { CalendarRead } from '../src/calendar.js';
import type { AaveReserveInfo, AaveReserveSnapshot, MorphoSnapshot, Universe, WalletSnapshot } from '../src/read.js';
import { ADDRESSES, CRYPTO, STOCKS, type StockId } from '../src/registry.js';
import type { Outcome } from '../src/rpc.js';

export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const reverted = <T>(): Outcome<T> => ({ ok: false, reason: 'reverted' });

export const NO_CAP = 1_099_511_627_775n;
const E8 = 10n ** 8n;

/** Price per whole token in the Aave oracle's 8 decimals. */
export const STOCK_PRICES: Record<StockId, bigint> = {
  AAPLc: 34_625_000_000n,
  AMZNc: 24_835_000_000n,
  GOOGLc: 32_077_000_000n,
  METAc: 64_056_000_000n,
  MSFTc: 52_258_000_000n,
  NVDAc: 21_190_700_000n,
  TSLAc: 37_080_000_000n,
};

export const FACTORS: Record<StockId, bigint> = {
  AAPLc: 7_800n,
  AMZNc: 7_300n,
  GOOGLc: 7_600n,
  METAc: 6_500n,
  MSFTc: 7_900n,
  NVDAc: 7_000n,
  TSLAc: 6_500n,
};

/** USDC per whole cbBTC is 80,300.25: Morpho prices 1 raw unit of collateral in raw USDC, × 1e36. */
export const CBBTC_PRICE = 80_300_250_000n * 10n ** 28n;
export const WETH_PRICE = 2_330_250_000n * 10n ** 18n;
export const LLTV = 860_000_000_000_000_000n;

export function universe(): Universe {
  const reserves: AaveReserveInfo[] = STOCKS.map((asset, reserveId) => ({
    reserveId,
    underlying: asset.token,
    hubAssetId: reserveId,
    decimals: 8,
    dynamicConfigKey: 0,
    priceSource: `0x${(reserveId + 1).toString(16).padStart(40, '0')}` as Address,
    role: { kind: 'stock', asset },
  }));
  const usdc: AaveReserveInfo = {
    reserveId: 7,
    underlying: ADDRESSES.usdc,
    hubAssetId: 7,
    decimals: 6,
    dynamicConfigKey: 0,
    priceSource: null,
    role: { kind: 'usdc' },
  };
  return {
    loadedAt: new Date('2026-10-21T15:00:00Z'),
    provider: 'test',
    aave: { ok: true, oracleDecimals: 8, reserves: [...reserves, usdc], usdc, noCap: NO_CAP },
    morpho: CRYPTO.map((asset) => ({
      ok: true as const,
      market: {
        asset,
        id: asset.morphoMarket,
        params: { loanToken: ADDRESSES.usdc, collateralToken: asset.token, oracle: '0x00000000000000000000000000000000000000a1', irm: '0x00000000000000000000000000000000000000a2', lltv: LLTV },
      },
    })),
  };
}

export interface Holdings {
  wallet?: Partial<Record<StockId | 'cbBTC' | 'WETH' | 'ETH', bigint>>;
  pledged?: Partial<Record<StockId, bigint>>;
  /** USDC base units owed on Aave. */
  aaveDebt?: bigint;
  morpho?: Partial<Record<'cbBTC' | 'ETH', { collateral: bigint; borrowShares: bigint }>>;
}

const seconds = (iso: string): bigint => BigInt(Date.parse(iso) / 1000);
/** A Wednesday morning in New York: weekday terms. */
export const WEEKDAY = seconds('2026-10-21T15:00:00Z');
/** A Saturday evening in New York: the weekend window. */
export const SATURDAY = seconds('2026-10-24T22:00:00Z');
/** A Sunday morning in New York: still the weekend window. */
export const SUNDAY = seconds('2026-10-25T15:00:00Z');

/** An earnings calendar read an hour before WEEKDAY: no stock reports unless a date is given. */
export function calendar(dates: Partial<Record<StockId, string[]>> = {}, missing: StockId[] = []): CalendarRead {
  return {
    ok: true,
    calendar: {
      readAt: new Date('2026-10-21T14:00:00Z'),
      dates: new Map(STOCKS.filter((s) => !missing.includes(s.id)).map((s) => [s.id, dates[s.id] ?? []])),
    },
  };
}

export function snapshot(h: Holdings, timestamp = WEEKDAY): WalletSnapshot {
  const u = universe();
  if (!u.aave.ok) throw new Error('fixture universe has no Aave');
  const balances = new Map<string, Outcome<bigint>>();
  for (const s of STOCKS) balances.set(s.token.toLowerCase(), ok(h.wallet?.[s.id] ?? 0n));
  balances.set(ADDRESSES.cbbtc.toLowerCase(), ok(h.wallet?.cbBTC ?? 0n));
  balances.set(ADDRESSES.weth.toLowerCase(), ok(h.wallet?.WETH ?? 0n));

  const reserves: AaveReserveSnapshot[] = u.aave.reserves.map((info) => {
    const stock = info.role.kind === 'stock' ? info.role.asset : null;
    const supplied = stock ? (h.pledged?.[stock.id] ?? 0n) : 0n;
    return {
      info,
      config: ok({ paused: false, frozen: false, borrowable: stock === null }),
      factorBps: ok(stock ? FACTORS[stock.id] : 0n),
      userFactorBps: ok(stock ? FACTORS[stock.id] : 0n),
      price: ok(stock ? STOCK_PRICES[stock.id] : E8),
      priceUpdatedAt: stock ? ok(1_792_598_400n) : reverted(),
      supplied: ok(supplied),
      status: ok({ usingAsCollateral: supplied > 0n, borrowing: stock === null && (h.aaveDebt ?? 0n) > 0n }),
      spokeConfig: ok(stock ? { addCap: 24_000n, drawCap: 0n, active: true, halted: false } : { addCap: 32_000_000n, drawCap: 21_000_000n, active: true, halted: false }),
      spokeAdded: ok(stock ? 1_000n * E8 : 6_000_000n * 10n ** 6n),
    };
  });

  const morpho = new Map<'cbBTC' | 'ETH', MorphoSnapshot | null>();
  for (const entry of u.morpho) {
    if (!entry.ok) continue;
    const id = entry.market.asset.id;
    const position = h.morpho?.[id] ?? { collateral: 0n, borrowShares: 0n };
    morpho.set(id, {
      info: entry.market,
      market: ok({
        totalSupplyAssets: 1_785_094_342_861_495n,
        totalSupplyShares: 1_606_934_596_929_172_956_296n,
        totalBorrowAssets: 1_610_573_516_105_827n,
        totalBorrowShares: 1_430_870_927_866_694_633_712n,
        lastUpdate: timestamp,
        fee: 0n,
      }),
      position: ok(position),
      price: ok(id === 'cbBTC' ? CBBTC_PRICE : WETH_PRICE),
      borrowRatePerSecond: ok(1_665_852_318n),
    });
  }

  return {
    provider: 'test',
    block: { number: 53_000_000n, timestamp },
    nativeEth: ok(h.wallet?.ETH ?? 0n),
    balances,
    coinbase: new Map(STOCKS.map((s) => [s.id, ok({ multiplier: 10n ** 18n, paused: false })])),
    aave: {
      reserves,
      usdcDebt: ok(h.aaveDebt ?? 0n),
      usdcLiquidity: ok(1_096_458_154_906n),
      usdcDrawnRateRay: ok(36_584_984_228_614_069_338_219_647n),
      usdcSpokeOwed: ok(5_103_903_801_787n),
      account: reverted(),
    },
    morpho,
  };
}

/** The example portfolio of docs/DESIGN.md. */
export const EXAMPLE: Holdings = {
  wallet: { NVDAc: 80_000_000n, AAPLc: 150_000_000n, TSLAc: 80_000_000n, cbBTC: 1_200_000n },
  pledged: { NVDAc: 340_000_000n },
  aaveDebt: 240_170_000n,
};
