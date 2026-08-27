import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import { createDatabaseRepresentationSupplyRepository } from '../src/representationSupplyDatabase.js';
import type { SqlTemplateExecutor } from '../src/types.js';
import {
  representationSupplyContractV1,
  SUPPLY_TOKEN_V1,
} from './representationSupply.contract.js';

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(
  url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url),
);
let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('lib/db')) return resolve(cwd, 'drizzle');
  if (cwd.endsWith('lib/route-storage')) return resolve(cwd, '..', 'db', 'drizzle');
  return resolve(cwd, 'lib', 'db', 'drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  for (const table of [
    'representation_supply_change',
    'representation_supply',
    'representation_supply_observation',
    'underlying_identity_observation',
    'representation_underlying',
    'underlying_asset',
    'issuer_representation',
    'issuer_membership_check',
    'representation_ratio_change',
    'representation_ratio',
    'official_asset_sources',
    'official_assets',
  ]) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  for (const file of [
    '0050_official_assets.sql',
    '0057_representation_ratio.sql',
    '0058_issuer_membership.sql',
    '0059_underlying_identity_and_backed.sql',
    '0060_representation_supply.sql',
  ]) {
    await sql.unsafe(
      (await readFile(resolve(drizzleDir(), file), 'utf8')).replaceAll(
        '--> statement-breakpoint',
        '',
      ),
    );
  }
  await sql`
    INSERT INTO underlying_asset (
      underlying_key, asset_class, canonical_name, display_symbol, identifier_scheme,
      identifier_value, source_kind, source_ref, source_hash, observed_at
    ) VALUES (
      'security:isin:US67066G1040', 'equity', 'NVIDIA', 'NVDA', 'isin',
      'US67066G1040', 'backed_assets_api', 'fixture', ${'ab'.repeat(32)},
      '2026-08-27T12:00:00.000Z'
    )`;
  await sql`
    INSERT INTO representation_underlying (
      chain_id, token_address, underlying_key, source_kind, source_ref, source_hash,
      issuer_id, issuer_instrument_key, caip10, representation_kind, evidence_strength,
      observed_at
    ) VALUES (
      8453, ${SUPPLY_TOKEN_V1}, 'security:isin:US67066G1040', 'backed_assets_api',
      'fixture', ${'ab'.repeat(32)}, 'backed', 'backed:instrument:nvda',
      ${`eip155:8453:${SUPPLY_TOKEN_V1}`}, 'rebasing_erc20',
      'reviewed_machine_address_mapping', '2026-08-27T12:00:00.000Z'
    )`;
});

after(async () => sql?.end({ timeout: 5 }));

if (!throwaway) {
  describe('postgres representation supply', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  representationSupplyContractV1('postgres', async () => {
    await sql!.unsafe(
      'TRUNCATE representation_supply_change, representation_supply, representation_supply_observation',
    );
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (
        sql as unknown as (
          strings: TemplateStringsArray,
          ...values: unknown[]
        ) => Promise<Record<string, unknown>[]>
      )(strings, ...values);
    return { repository: createDatabaseRepresentationSupplyRepository(executor) };
  });
}
