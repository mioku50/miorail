import { selectorV1, type B20ReaderV1, type B20RpcResultV1 } from '@mioagent/b20-control';
import { assembleRwaSignalFeedV1 } from '@mioagent/rwa-dossier';
import {
  stockBriefV1,
  stockBriefWindowV1,
  type StockBriefV1,
} from '@mioagent/rwa-market-reality/stock-brief';
import { databaseDividendReadDepsV1 } from './dividendRead.js';
import { readAtBlockV1 } from './dividendWalletRead.js';
import { myDividendWalletV1, stocksDividendsRuntime } from '../routes/stocksDividends.js';
import { createPublicReadCacheV1 } from '../routes/publicStocks.js';
import { rwaDiscoverRuntime } from '../routes/rwaDiscover.js';
import { rwaMarketRealityRuntime } from '../routes/rwaMarketReality.js';

/** The web session and MCP grant both call this with their proven wallet.
 * Nothing accepts an arbitrary wallet at either protocol boundary. */
export const stockBriefRuntime = {
  now: () => new Date(),
  available: () => stocksDividendsRuntime.storageAvailable(),
  reader: (): B20ReaderV1 | null => stocksDividendsRuntime.reader(),
  dividends: myDividendWalletV1,
  calendar: stocksDividendsRuntime.calendar,
  references: databaseDividendReadDepsV1.references,
  watches: (userId: string) => rwaMarketRealityRuntime.radar().watchesForUser({ userId }),
  changes: (addresses: string[], since: string) =>
    assembleRwaSignalFeedV1(rwaDiscoverRuntime.deps(), {
      tokenAddresses: addresses,
      since,
      limit: 200,
    }),
};
export const stockBriefCacheV1 = createPublicReadCacheV1({ ttlMs: 30_000, max: 1_024 });

function word(read: B20RpcResultV1<string> | undefined): bigint | null {
  return read?.ok && /^0x[0-9a-fA-F]{64}$/.test(read.value) ? BigInt(read.value) : null;
}

export async function readMyStocksTodayV1(wallet: string, since?: string): Promise<StockBriefV1> {
  wallet = wallet.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error('stock_brief_identity_invalid');
  const now = stockBriefRuntime.now();
  stockBriefWindowV1(now, since); // Reject invalid/future windows before any IO.
  const core = await stockBriefCacheV1.read(wallet, async () => {
    if (!(await stockBriefRuntime.available())) throw new Error('stock_brief_storage_unavailable');
    const reader = stockBriefRuntime.reader();
    if (!reader) throw new Error('stock_brief_chain_unconfigured');
    const dividends = await stockBriefRuntime.dividends(wallet, now);
    const blockTag = `0x${dividends.blockNumber.toString(16)}`;
    if (!reader.readBlockHeader) throw new Error('stock_brief_block_unread');
    const header = await reader.readBlockHeader(blockTag);
    if (!header.ok || !header.value) throw new Error('stock_brief_block_unread');
    const balanceReadAt = new Date(header.value.timestamp * 1_000).toISOString();
    const calendar = await stockBriefRuntime.calendar(now);
    const held = dividends.holdings
      .filter((row) => Number(row.tokens) > 0)
      .map((row) => row.tokenAddress);
    // Pinned to the BALANCE block. No event fires at Cobalt maturation, so
    // shares per token are read here even when the background ratio is old.
    const reads = await readAtBlockV1(
      reader,
      held.flatMap((to) => [
        { to, data: `0x${selectorV1('multiplier()')}` },
        { to, data: `0x${selectorV1('newUIMultiplier()')}` },
        { to, data: `0x${selectorV1('effectiveAt()')}` },
      ]),
      blockTag,
    );
    const controls = new Map<
      string,
      {
        multiplierWad: string | null;
        scheduleRead: 'read' | 'unavailable';
        schedule: StockBriefV1['holdings'][number]['schedule'];
      }
    >();
    for (let index = 0; index < held.length; index++) {
      const multiplier = word(reads[index * 3]);
      const target = word(reads[index * 3 + 1]);
      const time = word(reads[index * 3 + 2]);
      const scheduleRead =
        time !== null &&
        time <= 4_102_444_800n &&
        (time === 0n || (target !== null && target > 0n));
      controls.set(held[index]!, {
        multiplierWad: multiplier !== null && multiplier > 0n ? multiplier.toString() : null,
        scheduleRead: scheduleRead ? 'read' : 'unavailable',
        schedule:
          scheduleRead && time! > BigInt(header.value.timestamp)
            ? {
                multiplierWad: target!.toString(),
                effectiveAt: new Date(Number(time!) * 1_000).toISOString(),
              }
            : null,
      });
    }
    const watches = await stockBriefRuntime.watches(`eip155:8453:${wallet}`);
    const watchedAddresses = [...new Set(watches.map((row) => row.tokenAddress))];
    const addresses = [...new Set([...held, ...watchedAddresses])];
    // Seven days is the maximum return window. Failures remain a named gap.
    const [referenceRead, changeRead] = await Promise.allSettled([
      stockBriefRuntime.references(held, {
        since: new Date(now.getTime() - 4 * 86_400_000),
        until: now,
      }),
      stockBriefRuntime.changes(addresses, new Date(now.getTime() - 7 * 86_400_000).toISOString()),
    ]);
    return {
      dividends,
      balanceReadAt,
      controls,
      watchedAddresses,
      generatedAt: now.toISOString(),
      tokenAddresses: calendar.stocks.map((row) => row.tokenAddress),
      references: referenceRead.status === 'fulfilled' ? referenceRead.value : [],
      changes: changeRead.status === 'fulfilled' ? changeRead.value : null,
    };
  });
  // A cached response must not move the next-visit cursor past its read.
  // Otherwise a refresh inside the TTL could silently skip intervening events.
  return stockBriefV1({ ...core, now, since });
}
