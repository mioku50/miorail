import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { createProviders, type MirrorReport, type VenueLine } from '@mioagent/still-engine';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';
import type { StillLoanHoldReadingV1 } from '@mioagent/route-storage';

import { decodeMorphoCollateralTransfersV1, morphoCollateralHoldCallDataV1, morphoCollateralHoldableV1 } from './morphoCollateralHold.js';
import { stillRpcUrlsV1 } from './stillMirror.js';

// ---------------------------------------------------------------------------
// Still: what can hold a loan's collateral, read for its owner (2026-11-17).
//
// Two sources, each saying only what it read:
// - The Mirror's own reading of the stocks pledged on Aave V4: the reserve
//   paused or frozen, the stock halted on the spoke, and Coinbase's registry
//   flag, which holds the stock's price feed (corporate actions freeze the
//   feed, not the token). A flag counts as read only when the read behind it
//   did not fail.
// - The tokens themselves, at the reading's block, through Multicall3 with
//   allowFailure: B20 `isPaused(TRANSFER)` for each stock pledged on Aave V4,
//   and for cbBTC or PAXG on Morpho `paused()` plus the issuer's freeze of
//   Morpho Blue and of this wallet (./morphoCollateralHold.ts). WETH has none.
//
// What each means for a loan was measured on the contracts (2026-11-13/14):
// during a B20 transfer pause, Aave V4 still liquidates (it moves supplied
// shares inside the spoke), while repaying works and taking the stock back
// waits; a cbBTC or PAXG pause holds Morpho's liquidation and take-back, and
// repaying works. The words are in ./stillLoanNotices.ts.
// ---------------------------------------------------------------------------

const HOLD_ABI_V1 = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)',
  'function isPaused(uint8 feature) view returns (bool)',
]);
/** B20's TRANSFER feature: `pause([TRANSFER])` makes transfer and transferFrom revert. */
const B20_TRANSFER_FEATURE_V1 = 0;
const SYMBOL_V1 = /^[A-Za-z0-9]{1,16}$/;

/** One RPC endpoint's `eth_call`. */
export interface StillLoanCallClientV1 {
  call(args: { to: Address; data: Hex; blockNumber: bigint }): Promise<{ data?: Hex | undefined }>;
}

function owesV1(venue: VenueLine): boolean {
  return typeof venue.debtAtomic === 'string' && /^[0-9]{1,78}$/.test(venue.debtAtomic) && BigInt(venue.debtAtomic) > 0n;
}

function pledgedStocksV1(report: MirrorReport) {
  return (report.assets ?? []).filter((asset) => asset.venue === 'aave-v4' && SYMBOL_V1.test(asset.symbol)
    && asset.pledged !== null && /^[0-9]{1,78}$/.test(asset.pledged.raw) && BigInt(asset.pledged.raw) > 0n);
}

/** What the Mirror read of the stocks pledged on Aave V4. */
export function stillLoanMirrorHoldsV1(report: MirrorReport): StillLoanHoldReadingV1 {
  const held: string[] = [];
  const cleared: string[] = [];
  for (const asset of pledgedStocksV1(report)) {
    const say = (kind: string, on: boolean, read: boolean) => {
      if (read) (on ? held : cleared).push(`${asset.symbol}:${kind}`);
    };
    const status = !asset.failed.includes(`${asset.asset} reserve status`);
    const cap = !asset.failed.includes(`${asset.asset} Aave cap`);
    say('reserve_paused', asset.limits.includes('reserve_paused'), status);
    say('reserve_frozen', asset.limits.includes('reserve_frozen'), status);
    say('spoke_halted', asset.limits.includes('spoke_halted'), cap);
    // The registry read leaves no failure of its own: a line read in full is the only clear "not held".
    const feed = asset.limits.includes('issuer_paused');
    say('feed_paused', feed, feed || asset.failed.length === 0);
  }
  return { held, cleared };
}

/** A one-word boolean answer, else unread. */
function wordV1(row: { success: boolean; returnData: Hex }): boolean | null {
  return row.success && /^0x0{63}[01]$/.test(row.returnData) ? row.returnData.endsWith('1') : null;
}

async function firstAnswerV1(clients: readonly StillLoanCallClientV1[], data: Hex, blockNumber: bigint): Promise<Hex | null> {
  for (const client of clients) {
    try {
      const answer = await client.call({ to: ADDRESSES.multicall3 as Address, data, blockNumber });
      if (answer.data && answer.data !== '0x') return answer.data;
    } catch { /* the next configured endpoint; unread stays unread */ }
  }
  return null;
}

/** What the collateral tokens of each owed loan say, by loan market. A loan whose tokens could not be read is absent. */
export async function readStillLoanTokenHoldsV1(input: {
  clients: readonly StillLoanCallClientV1[];
  report: MirrorReport;
  walletAddress: string;
}): Promise<Map<string, StillLoanHoldReadingV1>> {
  const out = new Map<string, StillLoanHoldReadingV1>();
  const blockNumber = BigInt(input.report.reading.block);
  for (const venue of input.report.venues) {
    if (!owesV1(venue)) continue;
    const market = venue.market.toLowerCase();
    if (venue.venue === 'aave-v4') {
      const stocks = pledgedStocksV1(input.report);
      if (stocks.length === 0) continue;
      const pause = encodeFunctionData({ abi: HOLD_ABI_V1, functionName: 'isPaused', args: [B20_TRANSFER_FEATURE_V1] });
      const data = encodeFunctionData({ abi: HOLD_ABI_V1, functionName: 'aggregate3',
        args: [stocks.map((stock) => ({ target: stock.token.toLowerCase() as Address, allowFailure: true, callData: pause }))] });
      const answer = await firstAnswerV1(input.clients, data, blockNumber);
      if (!answer) continue;
      let rows: readonly { success: boolean; returnData: Hex }[];
      try {
        rows = decodeFunctionResult({ abi: HOLD_ABI_V1, functionName: 'aggregate3', data: answer });
      } catch {
        continue;
      }
      if (rows.length !== stocks.length) continue;
      const held: string[] = [];
      const cleared: string[] = [];
      rows.forEach((row, index) => {
        const paused = wordV1(row);
        if (paused !== null) (paused ? held : cleared).push(`${stocks[index]!.symbol}:transfers_paused`);
      });
      out.set(market, { held, cleared });
      continue;
    }
    const asset = CRYPTO.find((row) => row.morphoMarket.toLowerCase() === market);
    if (!asset || !morphoCollateralHoldableV1(asset) || !SYMBOL_V1.test(asset.symbol)) continue;
    const data = morphoCollateralHoldCallDataV1(asset, input.walletAddress);
    if (!data) continue;
    const read = decodeMorphoCollateralTransfersV1(await firstAnswerV1(input.clients, data, blockNumber));
    if (!read) continue;
    const held: string[] = [];
    const cleared: string[] = [];
    const say = (kind: string, on: boolean | null) => {
      if (on !== null) (on ? held : cleared).push(`${asset.symbol}:${kind}`);
    };
    say('transfers_paused', read.paused);
    say('market_frozen', read.marketFrozen);
    say('wallet_frozen', read.walletFrozen);
    out.set(market, { held, cleared });
  }
  return out;
}

/** The endpoints the Mirror reads, for the same block it read. */
export function stillLoanHoldClientsV1(env: NodeJS.ProcessEnv = process.env): StillLoanCallClientV1[] {
  return createProviders(stillRpcUrlsV1(env), 'miorail-still/1').map((provider) => provider.client as unknown as StillLoanCallClientV1);
}
