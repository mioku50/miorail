import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { describe } from 'node:test';

import {
  InMemoryAerodromeRewardAlertRepositoryV1,
  createDatabaseAerodromeRewardAlertRepositoryV1,
} from '../src/aerodromeRewardAlerts.js';
import { aerodromeRewardAlertsContractV1 } from './aerodromeRewardAlerts.contract.js';

// ---------------------------------------------------------------------------
// Found's alerts: one wallet, one amount, and an episode that says when the
// next build-up may be told again.
// ---------------------------------------------------------------------------

const ME = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';

aerodromeRewardAlertsContractV1('memory', async () => new InMemoryAerodromeRewardAlertRepositoryV1());

describe('the table and the SQL say the same', () => {
  const root = process.cwd().endsWith('lib/route-storage') ? resolve(process.cwd(), '..', '..') : process.cwd();
  const migration = readFileSync(resolve(root, 'lib/db/drizzle/0086_aerodrome_reward_alerts.sql'), 'utf8');
  const source = readFileSync(resolve(root, 'lib/route-storage/src/aerodromeRewardAlerts.ts'), 'utf8');

  test('the migration holds the rules the store enforces', () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS aerodrome_reward_alerts/);
    assert.match(migration, /wallet_address ~ '\^0x\[0-9a-f\]\{40\}\$'/);
    assert.match(migration, /threshold_usd_cents BETWEEN 100 AND 1000000/);
    assert.match(migration, /read_usd_cents IS NULL OR read_error IS NULL/);
    assert.match(migration, /read_error ~ '\^\[a-z0-9_\]\{1,64\}\$'/);
    assert.match(migration, /told_base_app BETWEEN 0 AND episode/);
    assert.match(migration, /ALTER TABLE aerodrome_reward_alerts OWNER TO miorail_user/);
    // One table: who hears what is the channels' business, not copied here.
    assert.equal(migration.match(/CREATE TABLE/g)?.length, 1);
  });

  test('the same amount is no update, and an episode moves only past a told one', () => {
    assert.match(source, /WHERE a\.threshold_usd_cents <> EXCLUDED\.threshold_usd_cents/);
    assert.match(source, /episode = a\.episode \+ 1/);
    assert.match(source, /AND \(told_base_app = episode OR told_telegram = episode\) THEN 1 ELSE 0 END/);
  });

  test('a channel writes only its own column, and only for the current episode', async () => {
    const calls: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      calls.push(strings.join('$'));
      return [];
    }) as unknown as Parameters<typeof createDatabaseAerodromeRewardAlertRepositoryV1>[0];
    const alerts = createDatabaseAerodromeRewardAlertRepositoryV1(sql);
    await alerts.markTold({ walletAddress: ME, channel: 'telegram', episode: 2 });
    await alerts.markTold({ walletAddress: ME, channel: 'base_app', episode: 2 });
    assert.match(calls[0]!, /SET told_telegram = \$\s+WHERE wallet_address = \$ AND episode = \$/);
    assert.match(calls[1]!, /SET told_base_app = \$\s+WHERE wallet_address = \$ AND episode = \$/);
    await assert.rejects(() => alerts.markTold({ walletAddress: ME, channel: 'sms' as never, episode: 2 }), /unknown notification channel/);
  });
});
