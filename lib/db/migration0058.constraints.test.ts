import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// The constraints in migration 0058, tested by violating them.
//
// The repositories refuse these rows in TypeScript. This proves the DATABASE
// refuses them with the repositories out of the way, which matters more here
// than usual: a row in `issuer_representation` is Miorail vouching that a named
// issuer deployed a named contract, and the cheapest way to publish a false one
// is a script that skipped the interface.
//
// It DROPS the tables, so it runs only against a throwaway local database.
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

const DINARI_AAPL = '0x41f7a63713e76c0ab800be03bae9f17b8a356348';
const ROOT = '0xbce6410a175a1c9b1a25d38d7e1a900f8393bc4d';
const HASH = `0x${'a1'.repeat(32)}`;
const WAD = (10n ** 18n).toString();

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  for (const table of [
    'representation_underlying',
    'underlying_asset',
    'issuer_representation',
    'issuer_membership_check',
    'representation_ratio_change',
    'representation_ratio',
  ]) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  for (const file of ['0057_representation_ratio.sql', '0058_issuer_membership.sql']) {
    const migration = await readFile(resolve(drizzleDir(), file), 'utf8');
    await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  }
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

async function refuses(statement: string, expected: RegExp): Promise<void> {
  await assert.rejects(
    async () => {
      await sql!.unsafe(statement);
    },
    (error: unknown) => {
      const message = String((error as { message?: string }).message ?? error);
      assert.match(message, expected);
      return true;
    },
  );
}

function representationRow(over: Record<string, string> = {}): string {
  const v = {
    chain_id: '8453',
    token_address: `'${DINARI_AAPL}'`,
    issuer_id: `'dinari'`,
    root_key: `'dinari_dshare_factory_v0_4_0_production'`,
    root_address: `'${ROOT}'`,
    membership: `'established'`,
    block_number: `'50487393'`,
    block_hash: `'${HASH}'`,
    evidence_hash: `'${HASH}'`,
    first_seen_at: `'2026-08-26T12:00:00Z'`,
    last_checked_at: `'2026-08-26T12:00:00Z'`,
    last_changed_at: 'NULL',
    reads: '1',
    changes: '0',
    ...over,
  };
  return `INSERT INTO issuer_representation (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')})`;
}

function checkRow(over: Record<string, string> = {}): string {
  const v = {
    id: `'check-${Math.random().toString(16).slice(2)}'`,
    issuer_id: `'dinari'`,
    root_key: `'dinari_dshare_factory_v0_4_0_production'`,
    chain_id: '8453',
    root_address: `'${ROOT}'`,
    predicate_selector: `'0x25f28f16'`,
    status: `'ok'`,
    block_number: `'50487393'`,
    block_hash: `'${HASH}'`,
    candidates: '2',
    established: '1',
    refuted: '1',
    unread: '0',
    observed_at: `'2026-08-26T12:00:00Z'`,
    detail: 'NULL',
    ...over,
  };
  return `INSERT INTO issuer_membership_check (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')})`;
}

if (!throwaway) {
  describe('migration 0058 constraints', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('migration 0058 constraints', () => {
    test('an unreviewed issuer cannot be vouched for', async () => {
      await refuses(representationRow({ issuer_id: `'backed'` }), /issuer_representation_issuer/);
    });

    test('there is no third membership value', async () => {
      // "We could not ask" is the absence of a row, never a value inside one.
      await refuses(representationRow({ membership: `'unknown'` }), /issuer_representation_membership/);
    });

    test('the first sighting cannot be a change', async () => {
      await refuses(representationRow({ changes: '1' }), /issuer_representation_change_has_a_time/);
      await refuses(
        representationRow({ last_changed_at: `'2026-08-26T12:00:00Z'` }),
        /issuer_representation_change_has_a_time/,
      );
      await refuses(
        representationRow({ reads: '1', changes: '1', last_changed_at: `'2026-08-26T12:00:00Z'` }),
        /issuer_representation_counts/,
      );
    });

    test('a mixed-case address is refused rather than silently normalised', async () => {
      await refuses(
        representationRow({ token_address: `'0x41F7A63713E76C0AB800BE03BAE9F17B8A356348'` }),
        /issuer_representation_addresses/,
      );
    });

    test('one address may be answered by two roots, and they do not collide', async () => {
      // Measured: the production factory says true about this token and the
      // v1.0.0 staging factory on the same chain says false.
      await sql!.unsafe(representationRow());
      await sql!.unsafe(
        representationRow({
          root_key: `'dinari_dshare_factory_v1_0_0_staging'`,
          root_address: `'0x4cdbd5a0938be8c57ded76880f774db67dc915a9'`,
          membership: `'refuted'`,
        }),
      );
      const rows = (await sql!.unsafe(
        `SELECT membership FROM issuer_representation WHERE token_address = '${DINARI_AAPL}' ORDER BY root_key`,
      )) as unknown as { membership: string }[];
      assert.deepEqual(
        rows.map((row) => row.membership),
        ['established', 'refuted'],
      );
      await sql!.unsafe('TRUNCATE issuer_representation');
    });

    test('a check that did not complete cannot carry a decision', async () => {
      await refuses(
        checkRow({
          status: `'endpoint_unavailable'`,
          block_number: 'NULL',
          block_hash: 'NULL',
          established: '1',
          refuted: '0',
          unread: '1',
        }),
        /issuer_membership_check_incomplete_decides_nothing/,
      );
    });

    test('an answer from the chain has a block behind it', async () => {
      await refuses(
        checkRow({ block_number: 'NULL', block_hash: 'NULL' }),
        /issuer_membership_check_anchored/,
      );
      await refuses(
        checkRow({
          status: `'root_unreadable'`,
          established: '0',
          refuted: '0',
          unread: '2',
        }),
        /issuer_membership_check_anchored/,
      );
    });

    test('every candidate lands in exactly one bucket', async () => {
      await refuses(checkRow({ candidates: '9' }), /issuer_membership_check_counts/);
    });

    test('a representation cannot point at an underlying nobody declared', async () => {
      await refuses(
        `INSERT INTO representation_underlying (
           chain_id, token_address, underlying_key, source_kind, source_ref, observed_at
         ) VALUES (8453, '${DINARI_AAPL}', 'dinari:stock_id:nobody', 'dinari_stock_api',
           'invented', '2026-08-26T12:00:00Z')`,
        /representation_underlying_underlying_key_fkey|violates foreign key/,
      );
    });

    test('a bare ticker cannot become an underlying key', async () => {
      await refuses(
        `INSERT INTO underlying_asset (
           underlying_key, asset_class, canonical_name, source_kind, source_ref, observed_at
         ) VALUES ('AAPL', 'equity', 'Apple Inc.', 'dinari_stock_api', 'guessed',
           '2026-08-26T12:00:00Z')`,
        /underlying_asset_key_namespaced/,
      );
    });

    test('the ratio store now takes Dinari, and still refuses an unreviewed kind', async () => {
      await sql!.unsafe(
        `INSERT INTO representation_ratio (
           chain_id, token_address, ratio_kind, application, raw_value, scale, scale_source,
           block_number, block_hash, evidence_hash, observed_at, last_checked_at,
           last_changed_at, reads, changes, created_at
         ) VALUES (8453, '${DINARI_AAPL}', 'dinari_balance_per_share', 'already_applied_by_token',
           '${WAD}', '${WAD}', 'reviewed_constant', '50487393', '${HASH}', '${HASH}',
           '2026-08-26T12:00:00Z', '2026-08-26T12:00:00Z', NULL, 1, 0, '2026-08-26T12:00:00Z')`,
      );
      await refuses(
        `INSERT INTO representation_ratio (
           chain_id, token_address, ratio_kind, application, raw_value, scale, scale_source,
           block_number, block_hash, evidence_hash, observed_at, last_checked_at,
           last_changed_at, reads, changes, created_at
         ) VALUES (8453, '${DINARI_AAPL}', 'backed_rebase', 'already_applied_by_token',
           '${WAD}', '${WAD}', 'reviewed_constant', '50487393', '${HASH}', '${HASH}',
           '2026-08-26T12:00:00Z', '2026-08-26T12:00:00Z', NULL, 1, 0, '2026-08-26T12:00:00Z')`,
        /representation_ratio_kind/,
      );
      await refuses(
        `INSERT INTO representation_ratio (
           chain_id, token_address, ratio_kind, application, raw_value, scale, scale_source,
           block_number, block_hash, evidence_hash, observed_at, last_checked_at,
           last_changed_at, reads, changes, created_at
         ) VALUES (8453, '0xb200000000000000000000c2e324d24d7eecd1fb', 'b20_multiplier',
           'apply_to_raw_balance', '${WAD}', '${WAD}', 'assumed', '50487393', '${HASH}', '${HASH}',
           '2026-08-26T12:00:00Z', '2026-08-26T12:00:00Z', NULL, 1, 0, '2026-08-26T12:00:00Z')`,
        /representation_ratio_scale_source/,
      );
      await sql!.unsafe('TRUNCATE representation_ratio_change, representation_ratio');
    });
  });
}
