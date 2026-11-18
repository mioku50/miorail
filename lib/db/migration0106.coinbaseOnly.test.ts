import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Migration 0106: Coinbase only (2026-11-18).
//
// It deletes production rows, so it is proven on the whole chain before it:
// every migration up to 0105 applied to an empty database, the shapes the
// production rows have written into it, then 0106. Coinbase's rows must come
// through untouched, Backed's and Dinari's must be gone, and the constraints
// must refuse them afterwards.
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
const BACKED_NVDA = '0xa34c5e0abe843e10461e2c9586ea03e55dbcc495';
const DINARI_AAPL = '0x41f7a63713e76c0ab800be03bae9f17b8a356348';
const NVDA = 'security:isin:US67066G1040';
const DINARI_KEY = 'dinari:stock_id:7e6a9c04-1b3e-4a2f-9f0d-2b5c8a1d4e77';
const HASH = `0x${'a1'.repeat(32)}`;
const SHA = 'b2'.repeat(32);
const WAD = (10n ** 18n).toString();
const AT = '2026-11-01T00:00:00.000Z';
const LATER = '2026-11-10T00:00:00.000Z';

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

async function apply(tag: string): Promise<void> {
  const migration = await readFile(resolve(drizzleDir(), `${tag}.sql`), 'utf8');
  await sql!.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
}

async function count(query: string): Promise<number> {
  const rows = (await sql!.unsafe(query)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  const journal = JSON.parse(await readFile(resolve(drizzleDir(), 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const tags = journal.entries.map((entry) => entry.tag);
  const at = tags.indexOf('0106_coinbase_only');
  assert.ok(at > 0, 'the journal holds the migration this test proves');
  // Every migration before it, from an empty database; the ones after it are not this test's (0107 came next).
  for (const tag of tags.slice(0, at)) await apply(tag);

  // Coinbase's source and contract.
  const [coinbaseSource] = await sql`
    INSERT INTO official_asset_sources (source_kind, source_url, observed_at, status, document_hash, corpus_hash, asset_count, detail)
    VALUES ('coinbase_stocks_api', 'https://api.coinbase.com/v1/tokenized-stocks', ${AT}, 'ok', ${SHA}, ${SHA}, 1, null)
    RETURNING id`;
  const [backedSource] = await sql`
    INSERT INTO official_asset_sources (source_kind, source_url, observed_at, status, document_hash, corpus_hash, asset_count, detail)
    VALUES ('backed_assets_api', 'https://api.xstocks.fi/api/v1/token?type=btokens', ${AT}, 'ok', ${SHA}, ${SHA}, 1, null)
    RETURNING id`;
  await sql`
    INSERT INTO official_assets (chain_id, token_address, source_kind, ticker, display_name, issuer, reference_feed_address, first_seen_at, last_seen_at, source_id)
    VALUES (8453, ${NVDAC}, 'coinbase_stocks_api', 'NVDAc', 'NVIDIA', 'coinbase', null, ${AT}, ${AT}, ${coinbaseSource!.id}),
           (8453, ${BACKED_NVDA}, 'backed_assets_api', 'bNVDA', 'Backed NVIDIA', 'Backed Assets', null, ${AT}, ${AT}, ${backedSource!.id})`;

  // NVDA was declared by Backed's source first and is bound by both issuers;
  // the Dinari company is bound by Dinari alone.
  await sql`
    INSERT INTO underlying_asset (underlying_key, asset_class, canonical_name, display_symbol, identifier_scheme, identifier_value, source_kind, source_ref, source_hash, observed_at)
    VALUES (${NVDA}, 'equity', 'NVDA', 'NVDA', 'isin', 'US67066G1040', 'backed_assets_api', 'https://api.xstocks.fi/#nvda', ${SHA}, ${AT}),
           (${DINARI_KEY}, 'equity', 'Apple Inc.', 'AAPL', 'dinari_stock_id', '7e6a9c04-1b3e-4a2f-9f0d-2b5c8a1d4e77', 'dinari_stock_api', 'GET /stocks/', null, ${AT})`;
  await sql`
    INSERT INTO representation_underlying (chain_id, token_address, underlying_key, source_kind, source_ref, source_hash, issuer_id, issuer_instrument_key, caip10, representation_kind, evidence_strength, observed_at)
    VALUES (8453, ${NVDAC}, ${NVDA}, 'coinbase_stocks_api', ${`https://api.coinbase.com/v1/tokenized-stocks#${NVDAC}`}, ${SHA}, 'coinbase', ${`coinbase:b20_address:${NVDAC}`}, ${`eip155:8453:${NVDAC}`}, 'b20_asset', 'reviewed_machine_address_mapping', ${LATER}),
           (8453, ${BACKED_NVDA}, ${NVDA}, 'backed_assets_api', 'https://api.xstocks.fi/#nvda', ${SHA}, 'backed', 'backed:instrument:nvda', ${`eip155:8453:${BACKED_NVDA}`}, 'rebasing_erc20', 'reviewed_machine_address_mapping', ${AT}),
           (8453, ${DINARI_AAPL}, ${DINARI_KEY}, 'dinari_stock_api', 'tokens[] eip155:8453', null, 'dinari', ${DINARI_KEY}, ${`eip155:8453:${DINARI_AAPL}`}, 'dinari_dshare', 'reviewed_machine_address_mapping', ${AT})`;

  await sql`
    INSERT INTO representation_ratio (chain_id, token_address, ratio_kind, application, raw_value, scale, block_number, block_hash, evidence_hash, observed_at, last_checked_at, created_at, scale_source)
    VALUES (8453, ${NVDAC}, 'b20_multiplier', 'apply_to_raw_balance', ${WAD}, ${WAD}, '1', ${HASH}, ${HASH}, ${AT}, ${AT}, ${AT}, 'read_from_contract'),
           (8453, ${DINARI_AAPL}, 'dinari_balance_per_share', 'already_applied_by_token', ${WAD}, ${WAD}, '1', ${HASH}, ${HASH}, ${AT}, ${AT}, ${AT}, 'reviewed_constant')`;
  // A contract that resembled Backed's NVDA, and one that resembles Coinbase's.
  await sql`
    INSERT INTO official_asset_lookalikes (chain_id, token_address, official_address, match_kind, matched_value, launch_symbol, launch_name, launched_at, first_flagged_at, last_seen_at, matched_alias)
    VALUES (8453, '0xb200000000000000000000dead0000000000ad01', ${BACKED_NVDA}, 'symbol_exact', 'bNVDA', 'bNVDA', 'Backed NVIDIA', ${AT}, ${AT}, ${AT}, 'published_ticker'),
           (8453, '0xb200000000000000000000dead0000000000ad02', ${NVDAC}, 'symbol_exact', 'NVDAc', 'NVDAc', 'NVIDIA', ${AT}, ${AT}, ${AT}, 'published_ticker')`;
  await sql`
    INSERT INTO issuer_representation (chain_id, token_address, issuer_id, root_key, root_address, membership, block_number, block_hash, evidence_hash, first_seen_at, last_checked_at)
    VALUES (8453, ${DINARI_AAPL}, 'dinari', 'dinari_base_v1', '0xbce6410a175a1c9b1a25d38d7e1a900f8393bc4d', 'established', '1', ${HASH}, ${HASH}, ${AT}, ${AT})`;

  await apply('0106_coinbase_only');
});

after(async () => sql?.end({ timeout: 5 }));

if (!throwaway) {
  describe('migration 0106', () => {
    test('skipped: no throwaway database', { skip: 'MIOAGENT_MIGRATION_TEST_URL is not a local database' }, () => {});
  });
} else {
  describe('migration 0106: Coinbase only', () => {
    test('Coinbase’s rows come through untouched', async () => {
      assert.equal(await count(`SELECT count(*) AS n FROM official_assets WHERE token_address = '${NVDAC}'`), 1);
      assert.equal(await count(`SELECT count(*) AS n FROM official_asset_sources WHERE source_kind = 'coinbase_stocks_api'`), 1);
      assert.equal(await count(`SELECT count(*) AS n FROM representation_underlying WHERE token_address = '${NVDAC}' AND issuer_id = 'coinbase'`), 1);
      assert.equal(await count(`SELECT count(*) AS n FROM representation_ratio WHERE token_address = '${NVDAC}'`), 1);
    });

    test('Backed’s and Dinari’s rows are gone, and their membership tables with them', async () => {
      assert.equal(await count(`SELECT count(*) AS n FROM official_assets WHERE source_kind = 'backed_assets_api'`), 0);
      assert.equal(await count(`SELECT count(*) AS n FROM official_asset_sources WHERE source_kind = 'backed_assets_api'`), 0);
      assert.equal(await count(`SELECT count(*) AS n FROM representation_underlying WHERE issuer_id IN ('backed', 'dinari')`), 0);
      assert.equal(await count(`SELECT count(*) AS n FROM representation_ratio WHERE ratio_kind <> 'b20_multiplier'`), 0);
      assert.equal(await count(`SELECT count(*) AS n FROM underlying_asset WHERE underlying_key = '${DINARI_KEY}'`), 0);
      assert.equal(await count(`SELECT count(*) AS n FROM pg_tables WHERE tablename IN ('issuer_representation', 'issuer_membership_check')`), 0);
      // A resemblance to Backed's contract went with it; one to Coinbase's stays.
      assert.equal(await count(`SELECT count(*) AS n FROM official_asset_lookalikes WHERE official_address = '${BACKED_NVDA}'`), 0);
      assert.equal(await count(`SELECT count(*) AS n FROM official_asset_lookalikes WHERE official_address = '${NVDAC}'`), 1);
    });

    test('a company Backed declared first stays, attributed to the Coinbase source that binds it', async () => {
      const [row] = (await sql!`
        SELECT source_kind, source_ref, observed_at FROM underlying_asset WHERE underlying_key = ${NVDA}`) as unknown as {
        source_kind: string;
        source_ref: string;
        observed_at: Date;
      }[];
      assert.equal(row?.source_kind, 'coinbase_stocks_api');
      assert.equal(row?.source_ref, `https://api.coinbase.com/v1/tokenized-stocks#${NVDAC}`);
      assert.equal(row?.observed_at.toISOString(), LATER);
    });

    test('the constraints refuse Backed and Dinari from now on', async () => {
      await assert.rejects(
        sql!`INSERT INTO official_asset_sources (source_kind, source_url, observed_at, status, asset_count)
             VALUES ('backed_assets_api', 'https://api.xstocks.fi/', ${AT}, 'ok', 0)`,
        /official_asset_sources_kind/,
      );
      await assert.rejects(
        sql!`INSERT INTO representation_underlying (chain_id, token_address, underlying_key, source_kind, source_ref, issuer_id, issuer_instrument_key, caip10, representation_kind, evidence_strength, observed_at)
             VALUES (8453, ${BACKED_NVDA}, ${NVDA}, 'coinbase_stocks_api', 'x', 'backed', 'backed:x', ${`eip155:8453:${BACKED_NVDA}`}, 'b20_asset', 'reviewed_machine_address_mapping', ${AT})`,
        /representation_underlying_issuer/,
      );
      await assert.rejects(
        sql!`INSERT INTO representation_ratio (chain_id, token_address, ratio_kind, application, raw_value, scale, block_number, block_hash, evidence_hash, observed_at, last_checked_at, created_at, scale_source)
             VALUES (8453, ${DINARI_AAPL}, 'dinari_balance_per_share', 'already_applied_by_token', ${WAD}, ${WAD}, '1', ${HASH}, ${HASH}, ${AT}, ${AT}, ${AT}, 'reviewed_constant')`,
        /representation_ratio_kind/,
      );
    });

    test('running it again changes nothing', async () => {
      await apply('0106_coinbase_only');
      assert.equal(await count(`SELECT count(*) AS n FROM representation_underlying`), 1);
      assert.equal(await count(`SELECT count(*) AS n FROM underlying_asset`), 1);
    });
  });
}
