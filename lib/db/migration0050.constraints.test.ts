import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// The constraints in migration 0050, tested by violating them.
//
// The repository refuses these rows in TypeScript, and the contract test proves
// it does. This file proves the DATABASE refuses them too, with the repository
// out of the way -- because the rules here are the OFFICIAL trust root, and a
// rule that lives only in the layer that happens to be calling today is one
// backfill script away from being no rule at all.
//
// Runs only against a THROWAWAY database named by MIOAGENT_MIGRATION_TEST_URL,
// and skips otherwise:
//
//   docker run -d --rm --name mio-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=t \
//     -p 127.0.0.1:55437:5432 postgres:17-alpine
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/db/migration0050.constraints.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const DOCS = 'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base.md';
const HASH = (char: string) => char.repeat(64);

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS official_assets, official_asset_sources CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0050_official_assets.sql'), 'utf8');
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('migration 0050 constraints', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('migration 0050 constraints', () => {
    const snapshot = async (overrides: Record<string, unknown> = {}) => {
      const row = {
        source_kind: 'base_docs_technical',
        source_url: DOCS,
        observed_at: '2026-08-25T09:00:00.000Z',
        status: 'ok',
        document_hash: HASH('a'),
        corpus_hash: HASH('b'),
        asset_count: 1,
        detail: null,
        ...overrides,
      };
      const [inserted] = await sql!`
        INSERT INTO official_asset_sources (
          source_kind, source_url, observed_at, status, document_hash, corpus_hash, asset_count, detail
        ) VALUES (
          ${row.source_kind as string}, ${row.source_url as string},
          ${row.observed_at as string}::timestamptz, ${row.status as string},
          ${row.document_hash as string | null}, ${row.corpus_hash as string | null},
          ${row.asset_count as number}, ${row.detail as string | null}
        ) RETURNING id`;
      return String(inserted.id);
    };

    test('a completed check with no assets cannot be stored as ok', async () => {
      await assert.rejects(snapshot({ asset_count: 0 }), /official_asset_sources_ok_is_complete/);
    });

    test('a failed check cannot claim assets', async () => {
      await assert.rejects(
        snapshot({ status: 'unreachable', document_hash: null, corpus_hash: null, asset_count: 2 }),
        /official_asset_sources_failed_claims_nothing/,
      );
    });

    test('an ok check must carry both hashes', async () => {
      await assert.rejects(snapshot({ corpus_hash: null }), /official_asset_sources_ok_is_complete/);
    });

    test('a source kind outside the reviewed set is refused', async () => {
      await assert.rejects(snapshot({ source_kind: 'some_aggregator' }), /official_asset_sources_kind/);
    });

    test('a source URL that is not https is refused', async () => {
      await assert.rejects(snapshot({ source_url: 'http://docs.base.org/x' }), /official_asset_sources_url_https/);
    });

    const asset = async (sourceId: string, overrides: Record<string, unknown> = {}) => {
      const row = {
        chain_id: 8453,
        token_address: AAPL,
        source_kind: 'base_docs_technical',
        ticker: 'AAPLc',
        display_name: 'Apple',
        issuer: 'coinbase',
        reference_feed_address: '0x787f13dea48db0897cbcdd985de77809d837f988',
        first_seen_at: '2026-08-25T09:00:00.000Z',
        last_seen_at: '2026-08-25T09:00:00.000Z',
        ...overrides,
      };
      await sql!`
        INSERT INTO official_assets (
          chain_id, token_address, source_kind, ticker, display_name, issuer,
          reference_feed_address, first_seen_at, last_seen_at, source_id
        ) VALUES (
          ${row.chain_id as number}, ${row.token_address as string}, ${row.source_kind as string},
          ${row.ticker as string}, ${row.display_name as string | null}, ${row.issuer as string},
          ${row.reference_feed_address as string | null},
          ${row.first_seen_at as string}::timestamptz, ${row.last_seen_at as string}::timestamptz,
          ${sourceId}::bigint
        )`;
    };

    test('a checksummed address is refused, so identity has one spelling', async () => {
      const id = await snapshot();
      await assert.rejects(
        asset(id, { token_address: '0xB200000000000000000000C2e324d24d7eEcd1fb' }),
        /official_assets_address_lower/,
      );
    });

    test('one source cannot list the same address twice', async () => {
      const id = await snapshot();
      await asset(id);
      await assert.rejects(asset(id), /official_assets_membership/);
    });

    test('membership cannot outlive the snapshot that justified it', async () => {
      const id = await snapshot({ observed_at: '2026-08-26T09:00:00.000Z' });
      await asset(id, { token_address: '0xb200000000000000000000397293cb8cda9a10c5', ticker: 'SNDKc' });
      // ON DELETE RESTRICT. Deleting the evidence would leave a claim of
      // officialness with nothing behind it.
      await assert.rejects(sql!`DELETE FROM official_asset_sources WHERE id = ${id}::bigint`, /violates foreign key/);
    });

    test('last seen cannot precede first seen', async () => {
      const id = await snapshot();
      await assert.rejects(
        asset(id, {
          token_address: '0xb2000000000000000000004884b426556b92883d',
          last_seen_at: '2026-08-24T09:00:00.000Z',
        }),
        /official_assets_seen_order/,
      );
    });
  });
}
