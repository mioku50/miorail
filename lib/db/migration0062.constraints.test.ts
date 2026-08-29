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

async function migrationText(): Promise<string> {
  return readFile(resolve(drizzleDir(), '0062_market_reality_radar.sql'), 'utf8');
}

test('migration 0062 stores exact watches and has no provider-failure event kind', async () => {
  const migration = await migrationText();
  assert.match(
    migration,
    /user_id, underlying_key, token_address, direction, requested_cash_atomic,\s*destination, route_policy_key/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \(\s*chain_id, token_address, underlying_key\s*\)/,
  );
  assert.match(migration, /previous_snapshot_hash/);
  assert.match(migration, /previous_observed_at < occurred_at/);
  const eventKinds = migration.match(/market_reality_radar_event_kind CHECK \(kind IN \(([\s\S]*?)\)\)/)?.[1] ?? '';
  assert.doesNotMatch(eventKinds, /measurement_failed|provider|rpc/);
});

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
  for (const table of [
    'market_reality_radar_events',
    'market_reality_radar_state',
    'market_reality_radar_watches',
    'underlying_identity_observation',
    'representation_underlying',
    'underlying_asset',
    'issuer_representation',
    'issuer_membership_check',
    'representation_ratio_change',
    'representation_ratio',
    'official_assets',
    'official_asset_sources',
  ]) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  for (const file of [
    '0050_official_assets.sql',
    '0057_representation_ratio.sql',
    '0058_issuer_membership.sql',
    '0059_underlying_identity_and_backed.sql',
    '0062_market_reality_radar.sql',
  ]) {
    const migration = await readFile(resolve(drizzleDir(), file), 'utf8');
    await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  }
  const address = '0xb20000000000000000000078ee7ce2fe4908108c';
  await sql.unsafe(`INSERT INTO underlying_asset (
    underlying_key, asset_class, canonical_name, display_symbol, identifier_scheme,
    identifier_value, source_kind, source_ref, source_hash, observed_at
  ) VALUES ('security:isin:US67066G1040', 'equity', 'NVIDIA Corporation', 'NVDA',
    'isin', 'US67066G1040', 'coinbase_b20_metadata', 'reviewed instrument',
    '${'aa'.repeat(32)}', '2026-08-28T06:00:00.000Z')`);
  await sql.unsafe(`INSERT INTO representation_underlying (
    chain_id, token_address, underlying_key, source_kind, source_ref, source_hash,
    issuer_id, issuer_instrument_key, caip10, representation_kind, evidence_strength, observed_at
  ) VALUES (8453, '${address}', 'security:isin:US67066G1040', 'coinbase_b20_metadata',
    'reviewed instrument', '${'aa'.repeat(32)}', 'coinbase',
    'coinbase:b20_address:${address}', 'eip155:8453:${address}', 'b20_asset',
    'reviewed_machine_address_mapping', '2026-08-28T06:00:00.000Z')`);
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

function watchInsert(input: { userId: string; slot: number; cash: string; suffix: string }): string {
  const address = '0xb20000000000000000000078ee7ce2fe4908108c';
  return `INSERT INTO market_reality_radar_watches (
    watch_id, user_id, watch_slot, chain_id, underlying_key, token_address, issuer_id,
    representation_kind, direction, requested_cash_atomic, destination, route_policy_key,
    approved_sources, created_at
  ) VALUES ('0x${input.suffix.repeat(64).slice(0, 64)}', '${input.userId}', ${input.slot}, 8453,
    'security:isin:US67066G1040', '${address}', 'coinbase', 'b20_asset', 'sell',
    '${input.cash}', 'USDC', '0x${'bb'.repeat(32)}', '["coinbase_trade_api"]',
    '2026-08-28T06:00:00.000Z')`;
}

if (!throwaway) {
  describe('migration 0062 database constraints', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('migration 0062 database constraints', () => {
    test('watch identity is the reviewed underlying/address edge', async () => {
      await sql!.unsafe(watchInsert({ userId: 'identity-user', slot: 1, cash: '1000000000', suffix: '1' }));
      await refuses(
        watchInsert({ userId: 'zero-size-user', slot: 1, cash: '0', suffix: '3' }),
        /market_reality_radar_watch_cash/,
      );
      await refuses(
        watchInsert({ userId: 'wrong-user', slot: 1, cash: '1000000000', suffix: '2' })
          .replace('security:isin:US67066G1040', 'security:isin:US0378331005'),
        /market_reality_radar_watch_(underlying|representation)_fk/,
      );
    });

    test('the database enforces 25 tenant slots without merging exact questions', async () => {
      for (let slot = 1; slot <= 25; slot += 1) {
        const suffix = (slot % 10).toString();
        await sql!.unsafe(
          watchInsert({ userId: 'capacity-user', slot, cash: String(1_000_000 + slot), suffix })
            .replace(`0x${suffix.repeat(64)}`, `0x${slot.toString(16).padStart(64, '0')}`),
        );
      }
      await refuses(
        watchInsert({ userId: 'capacity-user', slot: 26, cash: '2000000', suffix: 'f' }),
        /market_reality_radar_watch_slot/,
      );
      await refuses(
        watchInsert({ userId: 'capacity-user', slot: 25, cash: '3000000', suffix: 'e' }),
        /market_reality_radar_watch_user_slot_unique/,
      );
    });

    test('events bind to their watch identity and failures cannot be event kinds', async () => {
      const watchId = `0x${'cc'.repeat(32)}`;
      await sql!.unsafe(
        watchInsert({ userId: 'event-user', slot: 1, cash: '1000000000', suffix: 'c' }),
      );
      const event = (kind: string, address: string) => `INSERT INTO market_reality_radar_events (
        event_id, watch_id, chain_id, token_address, kind, previous_snapshot_hash,
        snapshot_hash, previous_observed_at, occurred_at, approved_sources, facts, recorded_at
      ) VALUES ('0x${'dd'.repeat(32)}', '${watchId}', 8453, '${address}', '${kind}',
        '0x${'11'.repeat(32)}', '0x${'22'.repeat(32)}', '2026-08-28T07:00:00.000Z',
        '2026-08-28T07:30:00.000Z', '["coinbase_trade_api"]', '{}',
        '2026-08-28T07:31:00.000Z')`;
      await refuses(
        event('measurement_failed', '0xb20000000000000000000078ee7ce2fe4908108c'),
        /market_reality_radar_event_kind/,
      );
      await refuses(
        event('route_became_unavailable', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        /market_reality_radar_event_watch_fk/,
      );
    });

    test('removing a watch removes its cursor and events, not reviewed identity', async () => {
      const watchId = `0x${'ee'.repeat(32)}`;
      await sql!.unsafe(
        watchInsert({ userId: 'cascade-user', slot: 1, cash: '1000000000', suffix: 'e' }),
      );
      await sql!.unsafe(`INSERT INTO market_reality_radar_state (
        watch_id, point, snapshot_hash, observed_at, updated_at
      ) VALUES ('${watchId}', '{}', '0x${'11'.repeat(32)}',
        '2026-08-28T07:00:00.000Z', '2026-08-28T07:00:00.000Z')`);
      await sql!.unsafe(`INSERT INTO market_reality_radar_events (
        event_id, watch_id, chain_id, token_address, kind, previous_snapshot_hash,
        snapshot_hash, previous_observed_at, occurred_at, approved_sources, facts, recorded_at
      ) VALUES ('0x${'ef'.repeat(32)}', '${watchId}', 8453,
        '0xb20000000000000000000078ee7ce2fe4908108c', 'route_became_available',
        '0x${'11'.repeat(32)}', '0x${'22'.repeat(32)}',
        '2026-08-28T06:30:00.000Z', '2026-08-28T07:00:00.000Z',
        '["coinbase_trade_api"]', '{}', '2026-08-28T07:01:00.000Z')`);
      await sql!.unsafe(`DELETE FROM market_reality_radar_watches WHERE watch_id = '${watchId}'`);
      const state = await sql!.unsafe(`SELECT count(*)::int total FROM market_reality_radar_state WHERE watch_id = '${watchId}'`);
      const events = await sql!.unsafe(`SELECT count(*)::int total FROM market_reality_radar_events WHERE watch_id = '${watchId}'`);
      const identity = await sql!.unsafe(`SELECT count(*)::int total FROM representation_underlying`);
      assert.equal(state[0]?.total, 0);
      assert.equal(events[0]?.total, 0);
      assert.equal(identity[0]?.total, 1);
    });
  });
}
