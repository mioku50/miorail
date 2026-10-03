import { selectorV1, type B20ReaderV1, type B20RpcResultV1 } from '@mioagent/b20-control';
import { assembleRwaSignalFeedV1 } from '@mioagent/rwa-dossier';
import {
  stockBriefV1,
  stockBriefWindowV1,
  stockReferencePriceV1,
  StockBriefInputV1Schema,
  type StockBriefV1,
} from '@mioagent/rwa-market-reality/stock-brief';
import type { z } from 'zod';
import { CASH_EXIT_DEFAULT_USDC_SIZES_ATOMIC_V1, type RwaSignalRowV1 } from '@mioagent/route-storage';
import {
  stockInboxRuntime,
  stockInboxProofV1,
  readStockInboxProofV1,
  StockInboxErrorV1,
} from './stockInboxRead.js';
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
  changes: (addresses: string[], since: string, until: string, rows?: readonly RwaSignalRowV1[]) =>
    assembleRwaSignalFeedV1(rwaDiscoverRuntime.deps(), {
      tokenAddresses: addresses,
      since,
      until,
      timeBasis: 'recorded',
      limit: 200,
      rows,
    }),
};
export const stockBriefCacheV1 = createPublicReadCacheV1({ ttlMs: 30_000, max: 1_024 });

/**
 * For each held contract this wallet does not also watch, the smallest
 * measured cash size that covers the holding. A cost change measured above it
 * is the public ladder's news, not this holder's. A holding Miorail cannot
 * value, or one larger than every measured size, gets no cap and keeps them all.
 */
export function stockInboxSizeCapsV1(input: {
  holdings: readonly { tokenAddress: string; tokens: string }[];
  references: readonly { tokenAddress: string; price: number; at: string }[];
  watched: ReadonlySet<string>;
  now: number;
}): { address: string; maxCashAtomic: string }[] {
  const caps: { address: string; maxCashAtomic: string }[] = [];
  for (const holding of input.holdings) {
    const tokens = Number(holding.tokens);
    if (!(tokens > 0) || input.watched.has(holding.tokenAddress)) continue;
    const price = stockReferencePriceV1(input.references, holding.tokenAddress, input.now);
    if (!price) continue;
    const value = Math.ceil(tokens * price.price * 1_000_000);
    if (!Number.isFinite(value)) continue;
    const rung = CASH_EXIT_DEFAULT_USDC_SIZES_ATOMIC_V1.find((size) => BigInt(size) >= BigInt(value));
    if (rung) caps.push({ address: holding.tokenAddress, maxCashAtomic: rung });
  }
  return caps;
}

function word(read: B20RpcResultV1<string> | undefined): bigint | null {
  return read?.ok && /^0x[0-9a-fA-F]{64}$/.test(read.value) ? BigInt(read.value) : null;
}

export async function readMyStocksTodayV1(
  wallet: string,
  options?: string | z.infer<typeof StockBriefInputV1Schema>,
): Promise<StockBriefV1> {
  wallet = wallet.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error('stock_brief_identity_invalid');
  const now = stockBriefRuntime.now();
  const input = StockBriefInputV1Schema.parse(
    typeof options === 'string' ? { since: options } : (options ?? {}),
  );
  if (input.since) stockBriefWindowV1(now, input.since); // Validate before chain IO.
  const cursor = input.cursor ? readStockInboxProofV1(input.cursor, wallet, 'cursor', now) : null;
  if (
    cursor &&
    (cursor.kind !== 'cursor' || input.since || (input.view && input.view !== cursor.view))
  )
    throw new StockInboxErrorV1('stock_inbox_cursor_invalid');
  const view = cursor?.kind === 'cursor' ? cursor.view : (input.view ?? 'unread');
  // Ensure proofs can be issued before spending any RPC reads.
  stockInboxRuntime.secret();
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
    const referenceRead = await Promise.allSettled([
      stockBriefRuntime.references(held, {
        since: new Date(now.getTime() - 4 * 86_400_000),
        until: now,
      }),
    ]);
    return {
      dividends,
      balanceReadAt,
      controls,
      tokenAddresses: calendar.stocks.map((row) => row.tokenAddress),
      references: referenceRead[0]!.status === 'fulfilled' ? referenceRead[0]!.value : [],
    };
  });
  // Balance/reference reads are cached, with their original dates. The inbox
  // is read on EVERY visit against a bounded insertion-time snapshot. Its
  // receipt must never advance past an event that was absent from a cached feed.
  const watches = await stockBriefRuntime.watches(`eip155:8453:${wallet}`);
  const watchedAddresses = [...new Set(watches.map((row) => row.tokenAddress))];
  const addresses = [
    ...new Set([
      ...core.dividends.holdings
        .filter((row) => Number(row.tokens) > 0)
        .map((row) => row.tokenAddress),
      ...watchedAddresses,
    ]),
  ];
  const repository = stockInboxRuntime.repository();
  const state = await repository.open(wallet, now);
  const since =
    cursor?.kind === 'cursor'
      ? cursor.since
      : input.since
        ? stockBriefWindowV1(now, input.since).since
        : state.since;
  const until = cursor?.kind === 'cursor' ? cursor.until : now.toISOString();
  let nextCursor: string | null = null;
  let changes: Awaited<ReturnType<typeof stockBriefRuntime.changes>> | null = null;
  try {
    const page = await repository.page({
      wallet,
      addresses,
      since,
      until,
      view,
      before: cursor?.kind === 'cursor' ? cursor.before : undefined,
      sizeCaps: stockInboxSizeCapsV1({
        holdings: core.dividends.holdings,
        references: core.references,
        watched: new Set(watchedAddresses),
        now: now.getTime(),
      }),
    });
    const visible = page.groups.flatMap((group) => group.rows);
    const expiry = new Date(now.getTime() + 15 * 60_000).toISOString();
    if (page.hasMore) {
      const last = page.groups.at(-1)!.anchor;
      nextCursor = stockInboxProofV1({
        kind: 'cursor',
        wallet,
        view,
        since,
        until,
        before: last,
        issuedAt: now.toISOString(),
        expiresAt: expiry,
      });
    }
    changes = await stockBriefRuntime.changes(addresses, since, until, visible);
  } catch {
    /* A failed inbox read cannot be marked as reviewed. */
  }
  const brief = stockBriefV1({
    ...core,
    now,
    since,
    preserveWindow: true,
    changes,
    watchedAddresses,
    inboxState: {
      view,
      openedAt: state.openedAt,
      reviewedAt: state.reviewedAt,
      snapshotAt: until,
      nextCursor: changes ? nextCursor : null,
      reviewToken: null,
    },
  });
  if (changes && view === 'unread')
    brief.inbox.reviewToken = stockInboxProofV1({
      kind: 'review',
      wallet,
      ids: brief.inbox.items.flatMap((row) => row.evidenceSignalIds ?? [row.signalId]),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    });
  return brief;
}
