import { b20BlockAtOrBeforeV1, type B20ReaderV1, type B20RpcResultV1 } from '@mioagent/b20-control';
import {
  dividendWalletConversionsV1,
  dividendWalletKeyV1,
  dividendWalletV1,
  type DividendWalletResponseV1,
} from '@mioagent/rwa-market-reality/dividend-wallet';
import type { DividendCalendarResponseV1 } from '@mioagent/rwa-market-reality/dividends';
import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';

// ---------------------------------------------------------------------------
// One wallet's dividends, read from the chain.
//
// What it holds now: `balanceOf` for every stock on the calendar, at ONE
// pinned block, so the answer is a single moment. What a dividend brought it:
// its balance at the last block before each conversion, because the
// multiplier is one number for every holder and reaches whoever holds the
// token when it moves.
//
// The past does not change, so the block before a conversion and a token's
// decimals are found once per process, and a wallet's balance at a past block
// once per wallet, in a bounded map because wallets are unbounded. Nothing
// here logs a wallet or a balance.
//
// Every read at one block is ONE eth_call, through Multicall3. The production
// endpoint meters each call in a JSON-RPC batch and refuses a burst. Measured
// on 2026-09-28: with ten balances as a ten-call batch beside the board's
// other reads, this read failed three times in five, and the board said "could
// not be read".
// ---------------------------------------------------------------------------

const BALANCE_OF_V1 = '0x70a08231';
const DECIMALS_V1 = '0x313ce567';
const PAST_BALANCES_MAX_V1 = 20_000;

/** Multicall3: one address on every chain it is on, and on Base since block 5,022. */
export const MULTICALL3_V1 = '0xca11bde05977b3631167028862be2a173976ca11';

export const AGGREGATE3_ABI_V1 = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

export interface DividendWalletCachesV1 {
  /** The last block before a conversion, by the conversion's instant. */
  blockBefore: Map<string, number>;
  decimals: Map<string, number>;
  /** `wallet|token|block` to an atomic balance. */
  pastBalances: Map<string, bigint>;
}

export function createDividendWalletCachesV1(): DividendWalletCachesV1 {
  return { blockBefore: new Map(), decimals: new Map(), pastBalances: new Map() };
}

function balanceOfDataV1(wallet: string): string {
  return `${BALANCE_OF_V1}${wallet.slice(2).padStart(64, '0')}`;
}

/**
 * Several reads at one block, as one call.
 *
 * Each row may fail on its own, so a token that reverts is that row's answer
 * and not the whole read's. A row at an address with no code answers empty,
 * as a direct `eth_call` does, and still means "not deployed yet". When the
 * call itself fails, every row carries its reason. A Multicall3 that is not
 * there is an unreadable answer, never a set of empty tokens.
 */
export async function readAtBlockV1(
  reader: B20ReaderV1,
  calls: ReadonlyArray<{ to: string; data: string }>,
  blockTag: string,
): Promise<B20RpcResultV1<string>[]> {
  if (calls.length === 0) return [];
  const read = await reader.call({
    to: MULTICALL3_V1,
    data: encodeFunctionData({
      abi: AGGREGATE3_ABI_V1,
      functionName: 'aggregate3',
      args: [calls.map((call) => ({ target: call.to as Hex, allowFailure: true, callData: call.data as Hex }))],
    }),
    blockTag,
  });
  const unreadable: B20RpcResultV1<string> = { ok: false, reason: 'invalid_response' };
  if (!read.ok) return calls.map(() => (read.reason === 'empty_result' ? unreadable : read));
  let rows: readonly { success: boolean; returnData: Hex }[];
  try {
    rows = decodeFunctionResult({ abi: AGGREGATE3_ABI_V1, functionName: 'aggregate3', data: read.value as Hex });
  } catch {
    rows = [];
  }
  if (rows.length !== calls.length) return calls.map(() => unreadable);
  return rows.map((row): B20RpcResultV1<string> => {
    if (!row.success) return { ok: false, reason: 'reverted' };
    if (row.returnData === '0x') return { ok: false, reason: 'empty_result' };
    return { ok: true, value: row.returnData, raw: row.returnData };
  });
}

function wordV1(read: B20RpcResultV1<string>, what: string): bigint {
  if (!read.ok) throw new Error(`dividend_wallet_${what}_${read.reason}`);
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(read.value)) throw new Error(`dividend_wallet_${what}_malformed`);
  return BigInt(read.value);
}

export async function readDividendWalletV1(input: {
  wallet: string;
  now: Date;
  calendar: DividendCalendarResponseV1;
  reader: B20ReaderV1;
  caches: DividendWalletCachesV1;
}): Promise<DividendWalletResponseV1> {
  const { calendar, caches, reader } = input;
  const wallet = input.wallet.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error('dividend_wallet_address');

  const anchor = await reader.readBlockAnchor();
  if (!anchor.ok) throw new Error(`dividend_wallet_block_${anchor.reason}`);
  const blockTag = anchor.value.blockTag;
  const tokens = calendar.stocks.map((stock) => stock.tokenAddress);

  const unknown = tokens.filter((token) => !caches.decimals.has(token));
  const decimalReads = await readAtBlockV1(reader, unknown.map((to) => ({ to, data: DECIMALS_V1 })), blockTag);
  decimalReads.forEach((read, index) => {
    const decimals = Number(wordV1(read, 'decimals'));
    if (!Number.isInteger(decimals) || decimals > 36) throw new Error('dividend_wallet_decimals_malformed');
    caches.decimals.set(unknown[index]!, decimals);
  });

  const heldReads = await readAtBlockV1(reader, tokens.map((to) => ({ to, data: balanceOfDataV1(wallet) })), blockTag);
  const balances = new Map(tokens.map((token, index) => [token, wordV1(heldReads[index]!, 'balance')]));

  const conversions = dividendWalletConversionsV1(calendar);
  for (const at of new Set(conversions.map((row) => row.at))) {
    if (caches.blockBefore.has(at)) continue;
    // A second before: the instant setter's own block already converts, and
    // a scheduled change converts from the first block at its date.
    const found = await b20BlockAtOrBeforeV1(reader, Date.parse(at) - 1_000);
    if (!found.ok) throw new Error(`dividend_wallet_past_block_${found.reason}`);
    caches.blockBefore.set(at, found.value.blockNumber);
  }
  const pastKey = (row: { tokenAddress: string; at: string }) => `${wallet}|${row.tokenAddress}|${caches.blockBefore.get(row.at)}`;
  // One read per past block: conversions at the same instant share it.
  const unreadByBlock = new Map<number, typeof conversions>();
  for (const row of conversions) {
    if (caches.pastBalances.has(pastKey(row))) continue;
    const block = caches.blockBefore.get(row.at)!;
    unreadByBlock.set(block, [...(unreadByBlock.get(block) ?? []), row]);
  }
  for (const [block, rows] of unreadByBlock) {
    const pastReads = await readAtBlockV1(
      reader,
      rows.map((row) => ({ to: row.tokenAddress, data: balanceOfDataV1(wallet) })),
      `0x${block.toString(16)}`,
    );
    pastReads.forEach((read, index) => {
      // No code at that block: the token did not exist yet, so nobody held it.
      const atomic = !read.ok && read.reason === 'empty_result' ? 0n : wordV1(read, 'past_balance');
      caches.pastBalances.set(pastKey(rows[index]!), atomic);
    });
  }
  const balancesBefore = new Map(
    conversions.map((row) => [dividendWalletKeyV1(row.tokenAddress, row.at), caches.pastBalances.get(pastKey(row))!] as const),
  );
  // Oldest first out. Evicting one is only a re-read later.
  while (caches.pastBalances.size > PAST_BALANCES_MAX_V1) {
    const oldest = caches.pastBalances.keys().next();
    if (oldest.done) break;
    caches.pastBalances.delete(oldest.value);
  }

  return dividendWalletV1({
    calendar,
    now: input.now,
    blockNumber: Number(anchor.value.blockNumber),
    decimals: caches.decimals,
    balances,
    balancesBefore,
  });
}
