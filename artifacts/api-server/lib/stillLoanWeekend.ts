import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import type { AssetLine, MirrorReport, VenueLine } from '@mioagent/still-engine';
import { safetyFromHealthFactor } from '@mioagent/still-engine/policy';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';
import type { PublicLadderMidRowV1, StillLoanStateV1 } from '@mioagent/route-storage';

import type { StillLoanCallClientV1 } from './stillLoanHolds.js';

// ---------------------------------------------------------------------------
// Still: a loan's margin at the onchain price while its oracle holds
// (2026-11-17).
//
// From Friday 20:00 New York time to Sunday 20:00, and on market holidays, the
// feeds Aave V4 prices Coinbase stocks by hold the last close, and the gold
// feed Morpho prices PAXG by holds Friday's gold. Nothing can be liquidated
// while they hold, and when they print again a liquidator can act in the same
// block, so a warning from the oracle's own price comes minutes too late. The
// tokens trade all weekend: Coinbase stocks on Base, PAXG everywhere.
//
// So, inside that window, each loan is also worked out at those prices:
// - a stock at the public ladder's $100 mid (KyberSwap's best route, which for
//   these stocks runs through their one deep Aerodrome pool), against the feed
//   value the same reading stood beside. Only readings taken while that feed
//   had not printed since the window opened count; the latest two at least
//   half an hour apart are taken, and of those the one nearer the oracle's
//   price, so one odd quote never warns alone;
// - PAXG at Chainlink's PAXG/USD, which is the backup oracle of the market's
//   own meta-oracle, against the gold price it holds, at the reading's block.
//
// Both venues weigh collateral linearly in its price, so the health factor at
// those prices is the one read times the pledged value's weighted move. A
// stock whose price was not measured, or whose feed has printed since the
// window opened, counts at the oracle's price. The result is a reading at a
// price, never a forecast: over four weekends (Oct 24 to Nov 14) every move
// above 1% on Base matched the direction of the next print, smaller ones about
// seven times in ten.
// ---------------------------------------------------------------------------

/** Readings older than this say nothing about the price now. */
export const STILL_WEEKEND_LADDER_FOR_MS_V1 = 4 * 3_600_000;
/** Two readings at least this far apart, so one quote never warns alone. */
export const STILL_WEEKEND_READINGS_APART_MS_V1 = 30 * 60_000;
/** A price this far from the oracle's is a broken quote, not a market. */
export const STILL_WEEKEND_RATIO_BOUND_V1 = 0.5;

const RATIO_SCALE_V1 = 1_000_000_000n;
const ATOMIC_V1 = /^[0-9]{1,78}$/;

/** The Mirror's report, as the notifier hands it on. */
export type StillMirrorReportV1 = MirrorReport;

/** A price measured against the one the venue's oracle holds. */
export interface StillWeekendPriceV1 {
  /** The measured price over the oracle's. */
  ratio: number;
  /** When the reading it comes from was taken. */
  at: string;
}

export interface StillLoanWeekendShadowV1 {
  /** The loan: the Aave spoke or a Morpho market id, lowercase. */
  market: string;
  venue: 'aave-v4' | 'morpho';
  /** The band and margin at the venue's own price, as the Mirror read them. */
  oracleState: StillLoanStateV1;
  oracleMarginBps: number;
  /** The band and margin at the measured prices. */
  state: StillLoanStateV1;
  marginBps: number;
  /** Pledged collateral that trades below the oracle's price, the biggest fall first. */
  movers: { symbol: string; ratio: number }[];
  /** Stocks priced on Base, or PAXG by its own feed. */
  source: 'onchain' | 'paxg_feed';
  /** The oracle's last print for the biggest mover. */
  heldSince: string | null;
  windowStartsAt: string;
  windowEndsAt: string;
  debtAtomic: string;
}

function owesV1(venue: VenueLine): boolean {
  return typeof venue.debtAtomic === 'string' && ATOMIC_V1.test(venue.debtAtomic) && BigInt(venue.debtAtomic) > 0n;
}

/** Each stock's price on Base against the price its feed holds, by token, lowercase. */
export function stillWeekendLadderPricesV1(input: {
  mids: readonly PublicLadderMidRowV1[];
  windowStartsAt: string;
  now: Date;
}): Map<string, StillWeekendPriceV1> {
  const opened = Date.parse(input.windowStartsAt);
  const oldest = input.now.getTime() - STILL_WEEKEND_LADDER_FOR_MS_V1;
  const readings = new Map<string, { at: number; ratio: number }[]>();
  for (const row of input.mids) {
    const at = Date.parse(row.at);
    if (!(at >= opened && at >= oldest && at <= input.now.getTime())) continue;
    // A feed that printed since the window opened is not holding: its reading is no weekend price.
    if (!(Date.parse(row.referenceUpdatedAt) < opened)) continue;
    if (!(row.reference > 0) || !(row.mid > 0) || !Number.isFinite(row.mid / row.reference)) continue;
    const ratio = row.mid / row.reference;
    if (Math.abs(ratio - 1) > STILL_WEEKEND_RATIO_BOUND_V1) continue;
    const token = row.token.toLowerCase();
    readings.set(token, [...(readings.get(token) ?? []), { at, ratio }]);
  }
  const out = new Map<string, StillWeekendPriceV1>();
  for (const [token, rows] of readings) {
    const sorted = [...rows].sort((a, b) => b.at - a.at);
    const latest = sorted[0]!;
    const earlier = sorted.find((row) => latest.at - row.at >= STILL_WEEKEND_READINGS_APART_MS_V1);
    if (!earlier) continue;
    const nearer = Math.abs(latest.ratio - 1) <= Math.abs(earlier.ratio - 1) ? latest : earlier;
    out.set(token, { ratio: nearer.ratio, at: new Date(nearer.at).toISOString() });
  }
  return out;
}

/** What is pledged in this loan: every stock on the Aave spoke, or the one collateral of a Morpho market. */
function pledgedInV1(report: MirrorReport, venue: VenueLine): AssetLine[] {
  const market = venue.market.toLowerCase();
  return report.assets.filter((asset) => {
    if (asset.pledged === null || !ATOMIC_V1.test(asset.pledged.raw) || BigInt(asset.pledged.raw) === 0n) return false;
    if (venue.venue === 'aave-v4') return asset.venue === 'aave-v4';
    return asset.venue === 'morpho' && CRYPTO.find((row) => row.id === asset.asset)?.morphoMarket.toLowerCase() === market;
  });
}

/** Each owed loan at the measured prices, while the report's window is open. A loan with nothing measured is absent. */
export function stillLoanWeekendShadowsV1(input: {
  report: MirrorReport;
  /** Stock prices on Base by token, lowercase (`stillWeekendLadderPricesV1`). */
  stocks: ReadonlyMap<string, StillWeekendPriceV1>;
  /** PAXG/USD over the gold price Morpho holds, at the reading's block (`readStillPaxgWeekendPriceV1`). */
  paxg?: StillWeekendPriceV1 | null;
}): StillLoanWeekendShadowV1[] {
  const { report } = input;
  const weekend = report.terms?.weekend;
  if (!weekend?.active) return [];
  const opened = Date.parse(weekend.startsAt);
  const out: StillLoanWeekendShadowV1[] = [];
  for (const venue of report.venues) {
    if (!owesV1(venue) || !venue.safety || !ATOMIC_V1.test(venue.safety.healthFactor)) continue;
    const weighed = pledgedInV1(report, venue).flatMap((asset) => {
      if (asset.priceCents === null || !ATOMIC_V1.test(asset.priceCents) || asset.pledged === null) return [];
      const factor = asset.protocolFactorBps;
      if (factor === null || !Number.isInteger(factor) || factor <= 0) return [];
      const weight = (BigInt(asset.pledged.raw) * BigInt(asset.priceCents) * BigInt(factor)) / 10n ** BigInt(asset.pledged.decimals);
      // Only a price the oracle has held since the window opened is measured against.
      const held = asset.priceUpdatedAt !== null && Date.parse(asset.priceUpdatedAt) < opened;
      const price = !held ? null
        : venue.venue === 'aave-v4' ? input.stocks.get(asset.token.toLowerCase()) ?? null
          : asset.asset === 'PAXG' ? input.paxg ?? null : null;
      return [{ asset, weight, price }];
    });
    const priced = weighed.filter((row) => row.price !== null);
    const total = weighed.reduce((sum, row) => sum + row.weight, 0n);
    if (priced.length === 0 || total === 0n) continue;
    const moved = weighed.reduce((sum, row) => sum + row.weight
      * (row.price ? BigInt(Math.round(row.price.ratio * Number(RATIO_SCALE_V1))) : RATIO_SCALE_V1), 0n);
    const healthFactor = (BigInt(venue.safety.healthFactor) * moved) / (total * RATIO_SCALE_V1);
    const { marginBps, state } = safetyFromHealthFactor(healthFactor);
    const movers = priced
      .filter((row) => row.price!.ratio < 1)
      .sort((a, b) => a.price!.ratio - b.price!.ratio);
    out.push({
      market: venue.market.toLowerCase(),
      venue: venue.venue,
      oracleState: venue.safety.state,
      oracleMarginBps: venue.safety.marginBps,
      state,
      marginBps: Number(marginBps),
      movers: movers.map((row) => ({ symbol: row.asset.symbol, ratio: row.price!.ratio })),
      source: venue.venue === 'aave-v4' ? 'onchain' : 'paxg_feed',
      heldSince: movers[0]?.asset.priceUpdatedAt ?? null,
      windowStartsAt: weekend.startsAt,
      windowEndsAt: weekend.endsAt,
      debtAtomic: venue.debtAtomic!,
    });
  }
  return out;
}

const PAXG_ORACLE_ABI_V1 = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)',
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function currentOracle() view returns (address)',
  'function primaryOracle() view returns (address)',
  'function backupOracle() view returns (address)',
  'function price() view returns (uint256)',
]);

async function callV1(clients: readonly StillLoanCallClientV1[], to: Address, data: Hex, blockNumber: bigint): Promise<Hex | null> {
  for (const client of clients) {
    try {
      const answer = await client.call({ to, data, blockNumber });
      if (answer.data && answer.data !== '0x') return answer.data;
    } catch { /* the next configured endpoint; unread stays unread */ }
  }
  return null;
}

/** Several calls at one block through Multicall3; null for each that failed, or for all when the batch did. */
async function batchV1(
  clients: readonly StillLoanCallClientV1[],
  calls: readonly { target: Address; functionName: 'currentOracle' | 'primaryOracle' | 'backupOracle' | 'price' }[],
  blockNumber: bigint,
): Promise<(Hex | null)[]> {
  const data = encodeFunctionData({ abi: PAXG_ORACLE_ABI_V1, functionName: 'aggregate3', args: [calls.map((call) => ({
    target: call.target, allowFailure: true, callData: encodeFunctionData({ abi: PAXG_ORACLE_ABI_V1, functionName: call.functionName }),
  }))] });
  const answer = await callV1(clients, ADDRESSES.multicall3 as Address, data, blockNumber);
  if (!answer) return calls.map(() => null);
  try {
    const rows = decodeFunctionResult({ abi: PAXG_ORACLE_ABI_V1, functionName: 'aggregate3', data: answer });
    return rows.length === calls.length ? rows.map((row) => (row.success && row.returnData !== '0x' ? row.returnData : null)) : calls.map(() => null);
  } catch {
    return calls.map(() => null);
  }
}

function addressOfV1(word: Hex | null): Address | null {
  return word && /^0x0{24}[0-9a-fA-F]{40}$/.test(word) && !/^0x0{64}$/.test(word) ? (`0x${word.slice(26)}` as Address) : null;
}

function uintOfV1(word: Hex | null): bigint | null {
  return word && /^0x[0-9a-fA-F]{64}$/.test(word) ? BigInt(word) : null;
}

/**
 * PAXG at Chainlink's PAXG/USD against the gold price its Morpho market holds, at the reading's block: the
 * meta-oracle's backup over the oracle it reads now. Null outside the window, without a PAXG debt, when the
 * meta-oracle already reads PAXG/USD (nothing is held then), or when any read fails.
 */
export async function readStillPaxgWeekendPriceV1(input: {
  clients: readonly StillLoanCallClientV1[];
  report: MirrorReport;
}): Promise<StillWeekendPriceV1 | null> {
  if (!input.report.terms?.weekend?.active) return null;
  const paxg = CRYPTO.find((asset) => asset.id === 'PAXG');
  if (!paxg) return null;
  const market = paxg.morphoMarket.toLowerCase();
  if (!input.report.venues.some((venue) => venue.market.toLowerCase() === market && owesV1(venue))) return null;
  const blockNumber = BigInt(input.report.reading.block);
  const params = await callV1(input.clients, ADDRESSES.morpho as Address,
    encodeFunctionData({ abi: PAXG_ORACLE_ABI_V1, functionName: 'idToMarketParams', args: [paxg.morphoMarket as Hex] }), blockNumber);
  if (!params) return null;
  let oracle: Address;
  try {
    oracle = decodeFunctionResult({ abi: PAXG_ORACLE_ABI_V1, functionName: 'idToMarketParams', data: params })[2];
  } catch {
    return null;
  }
  const [current, primary, backup] = (await batchV1(input.clients, [
    { target: oracle, functionName: 'currentOracle' },
    { target: oracle, functionName: 'primaryOracle' },
    { target: oracle, functionName: 'backupOracle' },
  ], blockNumber)).map(addressOfV1);
  if (!current || !primary || !backup || current.toLowerCase() !== primary.toLowerCase()) return null;
  const [held, measured] = (await batchV1(input.clients, [
    { target: primary, functionName: 'price' },
    { target: backup, functionName: 'price' },
  ], blockNumber)).map(uintOfV1);
  if (!held || !measured) return null;
  const ratio = Number((measured * RATIO_SCALE_V1) / held) / Number(RATIO_SCALE_V1);
  if (!Number.isFinite(ratio) || Math.abs(ratio - 1) > STILL_WEEKEND_RATIO_BOUND_V1) return null;
  return { ratio, at: input.report.reading.blockTime };
}
