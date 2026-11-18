import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { createMemoryUnderlyingAssetRepository } from '@mioagent/route-storage';

import { MarketRealityIndexV1Schema } from '../src/contracts.js';
import { assembleMarketRealityIndexV1 } from '../src/engine.js';

// ---------------------------------------------------------------------------
// `market-reality-index/v1` as clients were given it.
//
// A frozen copy of the index schema at acf28d1c^ (src/contracts.ts), the last
// commit before the Coinbase-only refactor. That refactor removed five
// required fields and kept the version string, so a client validating v1
// strictly refused the whole list (re-audit P2-2, 2026-11-18). An index that
// says v1 must keep passing this copy. Never edit it to make a test pass: a
// response it refuses is a v2.
// ---------------------------------------------------------------------------

const Timestamp = z.string().datetime();

const PreviousIndexEntryV1Schema = z
  .object({
    underlyingKey: z
      .string()
      .regex(/^[a-z0-9_]+:[a-z0-9_]+:.+$/)
      .max(200),
    canonicalName: z.string().min(1).max(200),
    displaySymbol: z.string().min(1).max(40).nullable(),
    assetClass: z.enum(['equity', 'fund_share', 'other', 'unknown']),
    identifierScheme: z.string().min(1).max(40).nullable(),
    identifierValue: z.string().min(1).max(120).nullable(),
    representationCount: z.number().int().min(0),
    liveRepresentationCount: z.number().int().min(0),
    issuerIds: z.array(z.enum(['coinbase', 'dinari', 'backed'])).max(8),
    coinbaseIssued: z.boolean(),
    multiIssuer: z.boolean(),
  })
  .strict();

const PreviousIndexV1Schema = z
  .object({
    schemaVersion: z.literal('market-reality-index/v1'),
    chainId: z.literal(8453),
    scope: z.enum(['coinbase_b20', 'all_representations']),
    entries: z.array(PreviousIndexEntryV1Schema).max(500),
    totals: z
      .object({
        underlyings: z.number().int().min(0),
        boundRepresentations: z.number().int().min(0),
        multiIssuerUnderlyings: z.number().int().min(0),
        coinbaseUnderlyings: z.number().int().min(0),
        allUnderlyings: z.number().int().min(0),
      })
      .strict(),
    observedAt: Timestamp,
  })
  .strict();

const AT = '2026-11-18T12:00:00.000Z';
const STOCKS = [
  { isin: 'US67066G1040', symbol: 'NVDA', name: 'NVIDIA Corporation', token: '0xb20000000000000000000078ee7ce2fe4908108c' },
  { isin: 'US0378331005', symbol: 'AAPL', name: 'Apple Inc.', token: '0xb200000000000000000000c2e324d24d7eecd1fb' },
  // Deployed and bound, but no longer on Coinbase's list: not on the board.
  { isin: 'US19260Q1076', symbol: 'COIN', name: 'Coinbase Global, Inc.', token: '0xb200000000000000000000000000000000000c01' },
] as const;

/** Bindings written the way the issuer-API binder writes them, read back
 * through the repository the engine reads in production's place. */
async function assembledIndex() {
  const underlyings = createMemoryUnderlyingAssetRepository(
    new Map([[STOCKS[0].token, 'positive_supply' as const]]),
  );
  for (const stock of STOCKS) {
    const underlyingKey = `security:isin:${stock.isin}`;
    await underlyings.declareUnderlying({
      underlyingKey,
      assetClass: 'equity',
      canonicalName: stock.name,
      displaySymbol: stock.symbol,
      identifierScheme: 'isin',
      identifierValue: stock.isin,
      sourceKind: 'coinbase_stocks_api',
      sourceRef: `coinbase:tokenized-stocks:${stock.symbol}c`,
      sourceHash: 'ab'.repeat(32),
      observedAt: AT,
    });
    await underlyings.bindRepresentation({
      chainId: 8453,
      tokenAddress: stock.token,
      underlyingKey,
      sourceKind: 'coinbase_stocks_api',
      sourceRef: `coinbase:tokenized-stocks:${stock.symbol}c`,
      sourceHash: 'ab'.repeat(32),
      issuerId: 'coinbase',
      issuerInstrumentKey: `coinbase:b20_address:${stock.token}`,
      caip10: `eip155:8453:${stock.token}`,
      representationKind: 'b20_asset',
      evidenceStrength: 'reviewed_machine_address_mapping',
      observedBlockNumber: null,
      observedBlockHash: null,
      observedAt: AT,
    });
  }
  return assembleMarketRealityIndexV1(
    {
      underlyings,
      now: () => new Date(AT),
      currentOfficialAddresses: async () => new Set([STOCKS[0].token, STOCKS[1].token]),
    },
    { limit: 500 },
  );
}

function issues(result: { success: true } | { success: false; error: z.ZodError }): string {
  return result.success ? '' : JSON.stringify(result.error.issues.map((issue) => issue.path.join('.')));
}

test('an assembled index passes the current v1 schema and the one clients were given', async () => {
  // As the API sends it: JSON, not the object the engine returned.
  const wire: unknown = JSON.parse(JSON.stringify(await assembledIndex()));
  const current = MarketRealityIndexV1Schema.safeParse(wire);
  assert.ok(current.success, issues(current));
  const previous = PreviousIndexV1Schema.safeParse(wire);
  assert.ok(previous.success, `a v1 client refuses this index at ${issues(previous)}`);
});

test('the restored v1 fields say what a Coinbase-only corpus is', async () => {
  const index = await assembledIndex();
  assert.deepEqual(
    index.entries.map((entry) => [entry.displaySymbol, entry.coinbaseIssued, entry.multiIssuer]),
    [
      ['NVDA', true, false],
      ['AAPL', true, false],
    ],
  );
  assert.deepEqual(index.totals, {
    underlyings: 2,
    boundRepresentations: 2,
    multiIssuerUnderlyings: 0,
    // The list is the whole corpus now: nothing else for a scoped page to name.
    coinbaseUnderlyings: 2,
    allUnderlyings: 2,
  });
});
