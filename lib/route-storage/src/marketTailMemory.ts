import {
  MARKET_TAIL_PRUNE_MAX_V1,
  MarketVenueUnidentifiedError,
  assertMarketVenueTransferV1,
  assertMarketVenueV1,
  venueMayCarryTradesV1,
  type MarketTailCursorV1,
  type MarketTailRepositoryV1,
  type MarketVenueActivityV1,
  type MarketVenueTransferRowV1,
  type MarketVenueRowV1,
} from './marketTail.js';
import { RouteStorageIntegrityError } from './types.js';

/**
 * The in-memory twin.
 *
 * It refuses what the database refuses: an event on an unidentified venue, a
 * pass that claims to have read less than the store already has, a paired pool
 * missing half its pair. A fake that accepted any of those would let a test
 * pass on a row production cannot store.
 */
export function createMemoryMarketTailRepository(): MarketTailRepositoryV1 {
  const cursors = new Map<string, MarketTailCursorV1>();
  const venues = new Map<string, MarketVenueRowV1>();
  const events = new Map<string, MarketVenueTransferRowV1>();
  // What migration 0097's trigger keeps in Postgres: every transfer ever
  // stored, counted when it is stored, untouched when it is removed.
  const totals = new Map<string, MarketVenueActivityV1>();
  const totalKey = (chainId: number, token: string) => `${chainId}:${token}`;
  const venueKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;
  const eventKey = (row: MarketVenueTransferRowV1) =>
    `${row.chainId}:${row.transactionHash}:${row.logIndex}`;

  return {
    async readCursor(input) {
      return cursors.get(input.tailKey) ?? null;
    },

    async recordPass(input) {
      const existing = cursors.get(input.tailKey);
      if (existing && input.toBlock < existing.lastBlock) {
        throw new RouteStorageIntegrityError(
          `refusing to move the ${input.tailKey} cursor back from ${existing.lastBlock} to ${input.toBlock}: a tail that rewinds re-scans history while appearing to work`,
        );
      }

      const venueRows = input.venues.map((row) => assertMarketVenueV1(row, 'write'));
      let venuesAdded = 0;
      let venuesIdentified = 0;
      for (const row of venueRows) {
        const key = venueKey(row.chainId, row.address);
        const previous = venues.get(key);
        if (!previous) venuesAdded += 1;
        else if (previous.kind === 'candidate' && row.kind !== 'candidate') venuesIdentified += 1;
        venues.set(key, {
          ...row,
          // How long we have seen this address is a fact the next pass must
          // not reset.
          firstSeenAt: previous?.firstSeenAt ?? row.firstSeenAt,
        });
      }

      const eventRows = input.events.map((row) => assertMarketVenueTransferV1(row, 'write'));
      let inserted = 0;
      let duplicates = 0;
      for (const row of eventRows) {
        const venue = venues.get(venueKey(row.chainId, row.venueAddress));
        if (!venue) {
          throw new MarketVenueUnidentifiedError(row.venueAddress, 'the store has no such address');
        }
        if (!venueMayCarryTradesV1(venue.kind)) {
          throw new MarketVenueUnidentifiedError(
            row.venueAddress,
            `it is recorded as ${venue.kind}, so nothing that passed through it is evidence of anything`,
          );
        }
        const key = eventKey(row);
        if (events.has(key)) {
          duplicates += 1;
          continue;
        }
        events.set(key, row);
        inserted += 1;
        const totalAt = totalKey(row.chainId, row.tokenAddress);
        const total = totals.get(totalAt) ?? {
          tokenAddress: row.tokenAddress,
          transfers: 0,
          acquired: 0,
          disposed: 0,
          firstBlock: row.blockNumber,
          lastBlock: row.blockNumber,
        };
        total.transfers += 1;
        if (row.direction === 'out_of_venue') total.acquired += 1;
        else total.disposed += 1;
        total.firstBlock = Math.min(total.firstBlock, row.blockNumber);
        total.lastBlock = Math.max(total.lastBlock, row.blockNumber);
        totals.set(totalAt, total);
      }

      const cursor: MarketTailCursorV1 = {
        tailKey: input.tailKey,
        chainId: input.chainId,
        lastBlock: Math.max(existing?.lastBlock ?? 0, input.toBlock),
        lastRunAt: input.observedAt,
        passes: (existing?.passes ?? 0) + 1,
        logCalls: (existing?.logCalls ?? 0) + input.logCalls,
        identityCalls: (existing?.identityCalls ?? 0) + input.identityCalls,
        eventsWritten: (existing?.eventsWritten ?? 0) + inserted,
      };
      cursors.set(input.tailKey, cursor);
      return { cursor, inserted, duplicates, venuesAdded, venuesIdentified };
    },

    async venues(input) {
      const kinds = input.kinds ? new Set(input.kinds) : null;
      return [...venues.values()]
        .filter((row) => row.chainId === input.chainId && (!kinds || kinds.has(row.kind)))
        .sort((left, right) => left.address.localeCompare(right.address))
        .slice(0, Math.max(1, Math.min(1_000, input.limit)));
    },

    async venueActivity(input) {
      const wanted = new Set(input.tokenAddresses.map((address) => address.toLowerCase()));
      const byToken = new Map<string, MarketVenueActivityV1>();
      for (const row of events.values()) {
        if (row.chainId !== input.chainId) continue;
        if (!wanted.has(row.tokenAddress)) continue;
        if (row.blockNumber < input.sinceBlock) continue;
        const current = byToken.get(row.tokenAddress) ?? {
          tokenAddress: row.tokenAddress,
          transfers: 0,
          acquired: 0,
          disposed: 0,
          firstBlock: row.blockNumber,
          lastBlock: row.blockNumber,
        };
        current.transfers += 1;
        if (row.direction === 'out_of_venue') current.acquired += 1;
        else current.disposed += 1;
        current.firstBlock = Math.min(current.firstBlock, row.blockNumber);
        current.lastBlock = Math.max(current.lastBlock, row.blockNumber);
        byToken.set(row.tokenAddress, current);
      }
      // Only tokens with an observation. A token absent from this list was not
      // observed trading, which a caller must not read as a zero it measured.
      return [...byToken.values()].sort((left, right) =>
        left.tokenAddress.localeCompare(right.tokenAddress),
      );
    },

    async venueActivityAllTime(input) {
      const rows: MarketVenueActivityV1[] = [];
      for (const address of new Set(input.tokenAddresses.map((token) => token.toLowerCase()))) {
        const total = totals.get(totalKey(input.chainId, address));
        if (total) rows.push({ ...total });
      }
      return rows.sort((left, right) => left.tokenAddress.localeCompare(right.tokenAddress));
    },

    async pruneTransfersObservedBefore(input) {
      const before = Date.parse(input.before);
      if (!Number.isFinite(before)) {
        throw new RouteStorageIntegrityError('refusing to prune venue transfers before a moment that is not a time');
      }
      const limit = Math.max(1, Math.min(MARKET_TAIL_PRUNE_MAX_V1, Math.trunc(input.limit)));
      let removed = 0;
      let looked = 0;
      // A Map keeps the order rows were stored in, which is the order Postgres
      // numbers them: the oldest `limit`, and of those the ones older than the
      // moment.
      for (const [key, row] of events) {
        if (row.chainId !== input.chainId) continue;
        if (looked >= limit) break;
        looked += 1;
        if (Date.parse(row.observedAt) >= before) continue;
        events.delete(key);
        removed += 1;
      }
      return { removed };
    },

    async recentTransfers(input) {
      const token = input.tokenAddress.toLowerCase();
      return [...events.values()]
        .filter((row) => row.chainId === input.chainId && row.tokenAddress === token)
        .sort(
          (left, right) =>
            right.blockNumber - left.blockNumber ||
            right.logIndex - left.logIndex ||
            right.transactionHash.localeCompare(left.transactionHash),
        )
        .slice(0, Math.max(1, Math.min(500, input.limit)));
    },
  };
}
