import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { StockQuotesResponseV1Schema, stockQuotesV1 } from '../src/stockQuotes.js';

// ---------------------------------------------------------------------------
// `stock-quotes/v1` as the clients in people's open tabs hold it.
//
// The client checks the reply with a strict schema before it draws anything, so
// a key it does not know refuses the whole board: prices and icons go blank
// until a reload. f8c93f0b added `market` that way, with no new version, and
// 341 of 415 rows carried it (audit 11-20 STK-3). This is a frozen copy of the
// schema served from 2026-11-19 (f8c93f0b) until 2026-11-21 04:15 UTC, the
// oldest a tab can still hold. A v1 reply must keep passing it.
//
// `corporateAction` is accepted by the clients served since 2026-11-21 04:15
// UTC and NOT by this copy, so the server does not send it yet (audit UI-1).
// The commit that starts sending it replaces this copy with the schema those
// clients hold, once they are the oldest served. Never edit it only to make a
// test pass: a reply it refuses is a v2.
// ---------------------------------------------------------------------------

const IsoV1 = z.string().regex(/^\d{4}-\d{2}-\d{2}T/);

const ServedStockQuotesV1Schema = z
  .object({
    schemaVersion: z.literal('stock-quotes/v1'),
    asOf: IsoV1,
    rows: z
      .array(
        z
          .object({
            underlyingKey: z.string().min(1).max(200),
            tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
            tokenSymbol: z.string().min(1).max(40).nullable(),
            companyName: z.string().min(1).max(200).nullable(),
            iconPath: z
              .string()
              .regex(/^\/api\/public\/stocks\/icons\/0x[0-9a-f]{40}\.png$/)
              .nullable(),
            priceUsd: z.number().positive().finite().nullable(),
            priceAt: IsoV1.nullable(),
            change24h: z.number().finite().nullable(),
            changeFromAt: IsoV1.nullable(),
            depth: z
              .object({
                state: z.enum(['normal', 'thin', 'unmeasured']),
                roundTripLossBps: z.number().int().min(-1_000_000).max(10_000).nullable(),
                buyMoveBps: z.number().int().min(-1_000_000).max(10_000_000).nullable().optional(),
                sellMoveBps: z.number().int().min(-1_000_000).max(10_000).nullable().optional(),
                measuredAt: IsoV1.nullable(),
              })
              .strict()
              .optional(),
            market: z.literal('none').optional(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

const NOW = new Date('2026-11-21T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const stock = (n: number) => ({
  tokenAddress: `0xb2${String(n).padStart(38, '0')}`,
  underlyingKey: `security:isin:US00000000${n}`,
  tokenSymbol: `S${n}c`,
  companyName: `Company ${n}`,
  iconPath: `/api/public/stocks/icons/0xb2${String(n).padStart(38, '0')}.png`,
});

test('every kind of v1 row passes the schema the oldest open tab holds', () => {
  const [priced, split, unpriced, marketless] = [stock(1), stock(2), stock(3), stock(4)];
  const prices = [priced, split].flatMap((row) => [
    { token: row.tokenAddress, at: hoursAgo(24), mid: 100, buyAt1k: 100.4, sellAt1k: 99.6 },
    { token: row.tokenAddress, at: hoursAgo(1), mid: 12.5, buyAt1k: 12.6, sellAt1k: 12.4 },
  ]);
  const reply = stockQuotesV1({
    now: NOW,
    prices,
    stocks: [priced, split, unpriced, marketless],
    noMarket: new Set([marketless.tokenAddress]),
    // A multiplier change between the two prices: the row says no change, and carries no new key yet.
    ratioChangedAt: new Map([[split.tokenAddress, [hoursAgo(5)]]]),
  });
  // As the API sends it: JSON, not the object the builder returned.
  const wire = JSON.parse(JSON.stringify(reply)) as unknown;
  const served = ServedStockQuotesV1Schema.safeParse(wire);
  assert.ok(served.success, served.success ? '' : JSON.stringify(served.error.issues));
  assert.ok(StockQuotesResponseV1Schema.safeParse(wire).success);
  const rows = reply.rows;
  assert.equal(rows.find((row) => row.tokenAddress === split.tokenAddress)?.change24h, null);
  assert.equal(rows.find((row) => row.tokenAddress === marketless.tokenAddress)?.market, 'none');
  assert.ok(rows.every((row) => !('corporateAction' in row)), 'corporateAction waits until this copy is retired');
});

test('a key the oldest open tab does not know is refused by it', () => {
  const wire = { schemaVersion: 'stock-quotes/v1', asOf: NOW.toISOString(), rows: [{ ...stock(1), priceUsd: null, priceAt: null,
    change24h: null, changeFromAt: null, corporateAction: true }] };
  assert.equal(ServedStockQuotesV1Schema.safeParse(wire).success, false);
  // The clients served since 2026-11-21 04:15 UTC take it.
  assert.equal(StockQuotesResponseV1Schema.safeParse(wire).success, true);
});
