import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';

import { createDatabaseOfficialAssetRepository, type OfficialAssetTransactionV1 } from '../src/officialAssetsDatabase.js';
import { officialAssetContractV1 } from './officialAssets.contract.js';

// ---------------------------------------------------------------------------
// The same contract the in-memory repository is held to, run against real
// Postgres -- because half of this guarantee is CHECK constraints and a
// foreign key, and a zod schema alone cannot prove those exist.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/officialAssets.postgres.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

let sql: ReturnType<typeof postgres> | null = null;

const transaction: OfficialAssetTransactionV1 = async <T>(work: (tx: SqlTemplateExecutor) => Promise<T>) =>
  await sql!.begin((tx) => work(tx as unknown as SqlTemplateExecutor)) as T;

function drizzleDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('lib/db')) return resolve(cwd, 'drizzle');
  if (cwd.endsWith('lib/route-storage')) return resolve(cwd, '..', 'db', 'drizzle');
  return resolve(cwd, 'lib', 'db', 'drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 4, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS official_assets CASCADE');
  await sql.unsafe('DROP TABLE IF EXISTS official_asset_sources CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0050_official_assets.sql'), 'utf8');
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  // This repository also stores Backed. Apply the actual source-kind changes
  // from 0059; its remaining statements concern separate identity tables.
  const backedMigration = await readFile(resolve(drizzleDir(), '0059_underlying_identity_and_backed.sql'), 'utf8');
  await sql.unsafe(backedMigration.split('ALTER TABLE underlying_asset')[0]!);
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres official assets', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  officialAssetContractV1('postgres', async () => {
    // The sources table is truncated too, and CASCADE takes membership with
    // it: a test that started with yesterday's snapshot still standing would
    // measure a different definition of "currently listed".
    await sql!.unsafe('TRUNCATE official_asset_sources, official_assets RESTART IDENTITY CASCADE');
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (sql as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<Record<string, unknown>[]>)(strings, ...values);
    return { repository: createDatabaseOfficialAssetRepository(executor, transaction) };
  });

  test('a failed membership write rolls back the published source and every asset', async () => {
    await sql!.unsafe('TRUNCATE official_asset_sources, official_assets RESTART IDENTITY CASCADE');
    const repository = createDatabaseOfficialAssetRepository(
      sql! as unknown as SqlTemplateExecutor,
      transaction,
    );
    const snapshot = {
      sourceKind: 'base_docs_technical' as const,
      sourceUrl: 'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base.md',
      observedAt: '2026-09-05T10:00:00.000Z', status: 'ok' as const,
      documentHash: 'a'.repeat(64), corpusHash: 'b'.repeat(64), detail: null,
    };
    const asset = {
      chainId: 8453 as const, tokenAddress: '0xb200000000000000000000c2e324d24d7eecd1fb',
      sourceKind: 'base_docs_technical' as const, ticker: 'AAPLc', displayName: 'Apple',
      issuer: 'coinbase', referenceFeedAddress: null,
    };
    await repository.recordSnapshot({ snapshot, assets: [asset] });
    await sql!.unsafe(`CREATE FUNCTION audit_reject_member() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.ticker = 'FAIL' THEN RAISE EXCEPTION 'injected membership failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER audit_reject_member BEFORE INSERT OR UPDATE ON official_assets
      FOR EACH ROW EXECUTE FUNCTION audit_reject_member()`);
    try {
      await assert.rejects(repository.recordSnapshot({
        snapshot: { ...snapshot, observedAt: '2026-09-05T10:01:00.000Z' },
        assets: [asset, { ...asset, tokenAddress: '0xb200000000000000000000397293cb8cda9a10c5', ticker: 'FAIL' }],
      }), /injected membership failure/);
      const rows = await sql!`SELECT count(*)::int AS n FROM official_asset_sources`;
      assert.equal(rows[0]!.n, 1, 'a failed pass must not publish its source');
      const current = await repository.officialAssets({ chainId: 8453, limit: 50 });
      assert.deepEqual(current.map((row) => row.tokenAddress), [asset.tokenAddress]);
      assert.equal((await repository.latestSnapshot({ sourceKind: snapshot.sourceKind }))!.observedAt, snapshot.observedAt);
    } finally {
      await sql!.unsafe('DROP TRIGGER audit_reject_member ON official_assets; DROP FUNCTION audit_reject_member()');
    }
  });
}
