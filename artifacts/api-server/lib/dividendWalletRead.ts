import { b20BlockAtOrBeforeV1, callManyV1, type B20ReaderV1, type B20RpcResultV1 } from '@mioagent/b20-control';
import {
  dividendWalletConversionsV1,
  dividendWalletKeyV1,
  dividendWalletV1,
  type DividendWalletResponseV1,
} from '@mioagent/rwa-market-reality/dividend-wallet';
import type { DividendCalendarResponseV1 } from '@mioagent/rwa-market-reality/dividends';

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
// ---------------------------------------------------------------------------

const BALANCE_OF_V1 = '0x70a08231';
const DECIMALS_V1 = '0x313ce567';
const PAST_BALANCES_MAX_V1 = 20_000;

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
  const decimalReads = await callManyV1(reader, unknown.map((to) => ({ to, data: DECIMALS_V1, blockTag })));
  decimalReads.forEach((read, index) => {
    const decimals = Number(wordV1(read, 'decimals'));
    if (!Number.isInteger(decimals) || decimals > 36) throw new Error('dividend_wallet_decimals_malformed');
    caches.decimals.set(unknown[index]!, decimals);
  });

  const heldReads = await callManyV1(reader, tokens.map((to) => ({ to, data: balanceOfDataV1(wallet), blockTag })));
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
  const unread = conversions.filter((row) => !caches.pastBalances.has(pastKey(row)));
  const pastReads = await callManyV1(
    reader,
    unread.map((row) => ({
      to: row.tokenAddress,
      data: balanceOfDataV1(wallet),
      blockTag: `0x${caches.blockBefore.get(row.at)!.toString(16)}`,
    })),
  );
  pastReads.forEach((read, index) => {
    // No code at that block: the token did not exist yet, so nobody held it.
    const atomic = !read.ok && read.reason === 'empty_result' ? 0n : wordV1(read, 'past_balance');
    caches.pastBalances.set(pastKey(unread[index]!), atomic);
  });
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
