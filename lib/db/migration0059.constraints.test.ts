import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(
  url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url),
);
let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  for (const table of [
    'underlying_identity_observation',
    'representation_underlying',
    'underlying_asset',
    'issuer_representation',
    'issuer_membership_check',
    'representation_ratio_change',
    'representation_ratio',
    'official_assets',
    'official_asset_sources',
  ])
    await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
  for (const file of [
    '0050_official_assets.sql',
    '0057_representation_ratio.sql',
    '0058_issuer_membership.sql',
    '0059_underlying_identity_and_backed.sql',
  ]) {
    const migration = await readFile(resolve(drizzleDir(), file), 'utf8');
    await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  }
});

after(async () => sql?.end({ timeout: 5 }));

async function refuses(statement: string, expected: RegExp): Promise<void> {
  await assert.rejects(
    () => sql!.unsafe(statement),
    (error: unknown) => {
      assert.match(String((error as { message?: string }).message ?? error), expected);
      return true;
    },
  );
}

if (!throwaway) {
  describe('migration 0059 constraints', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('migration 0059 constraints', () => {
    test('Backed is a reviewed source and a failed snapshot still claims nothing', async () => {
      await sql!.unsafe(`INSERT INTO official_asset_sources (
        source_kind, source_url, observed_at, status, document_hash, corpus_hash, asset_count, detail
      ) VALUES ('backed_assets_api', 'https://api.xstocks.fi/api/v1/token?type=btokens', now(),
        'ok', '${'aa'.repeat(32)}', '${'bb'.repeat(32)}', 17, NULL)`);
      await refuses(
        `INSERT INTO official_asset_sources (
          source_kind, source_url, observed_at, status, document_hash, corpus_hash, asset_count, detail
        ) VALUES ('backed_assets_api', 'https://api.xstocks.fi/api/v1/token?type=btokens', now(),
          'unreachable', NULL, NULL, 17, 'ours')`,
        /official_asset_sources_failed_claims_nothing/,
      );
    });

    test('exact CAIP-10 and stable identifier are enforced independently of ticker', async () => {
      const address = '0xa34c5e0abe843e10461e2c9586ea03e55dbcc495';
      await sql!.unsafe(`INSERT INTO underlying_asset (
        underlying_key, asset_class, canonical_name, display_symbol, identifier_scheme,
        identifier_value, source_kind, source_ref, source_hash, observed_at
      ) VALUES ('security:isin:US67066G1040', 'equity', 'NVIDIA Corporation', 'NVDA',
        'isin', 'US67066G1040', 'backed_assets_api', 'issuer uuid', '${'cc'.repeat(32)}', now())`);
      await sql!.unsafe(`INSERT INTO representation_underlying (
        chain_id, token_address, underlying_key, source_kind, source_ref, source_hash,
        issuer_id, issuer_instrument_key, caip10, representation_kind, evidence_strength, observed_at
      ) VALUES (8453, '${address}', 'security:isin:US67066G1040', 'backed_assets_api',
        'issuer uuid', '${'cc'.repeat(32)}', 'backed', 'backed:instrument_id:uuid',
        'eip155:8453:${address}', 'rebasing_erc20', 'reviewed_machine_address_mapping', now())`);
      await refuses(
        `UPDATE representation_underlying SET caip10 = 'eip155:8453:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'`,
        /representation_underlying_caip10/,
      );
      await refuses(
        `UPDATE underlying_asset SET identifier_scheme = NULL`,
        /underlying_asset_identifier_pair/,
      );
      await refuses(
        `UPDATE representation_underlying SET chain_id = 1`,
        /representation_underlying_base_chain/,
      );
    });

    test('Backed ratio semantics are reviewed and already applied by the token', async () => {
      const address = '0xa34c5e0abe843e10461e2c9586ea03e55dbcc495';
      const hash = `0x${'dd'.repeat(32)}`;
      await sql!.unsafe(`INSERT INTO representation_ratio (
        chain_id, token_address, ratio_kind, application, raw_value, scale, scale_source,
        block_number, block_hash, evidence_hash, observed_at, last_checked_at,
        last_changed_at, reads, changes, created_at
      ) VALUES (8453, '${address}', 'backed_evm_multiplier', 'already_applied_by_token',
        '1000000000000000000', '1000000000000000000', 'reviewed_constant', '1', '${hash}',
        '${hash}', now(), now(), NULL, 1, 0, now())`);
      const rows = await sql!.unsafe(
        `SELECT application FROM representation_ratio WHERE token_address = '${address}'`,
      );
      assert.equal(rows[0]?.application, 'already_applied_by_token');
    });
  });
}
