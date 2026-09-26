import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

test('migration 0074 gives each channel its own notifier memory, and links chats only through a hashed code', async () => {
  const migration = await readFile(resolve(drizzleDir(), '0074_telegram_notifications.sql'), 'utf8');
  // The three tables the Base App notifier writes gain a channel, and their
  // keys with it: a second channel must never read the first one's cursor or
  // spend its cap. Existing rows are Base App's.
  for (const table of ['base_app_notification_cursor', 'base_app_notification_daily', 'base_app_weekly_summary']) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'base_app'`));
  }
  assert.match(migration, /PRIMARY KEY \(channel, source\)/);
  assert.match(migration, /PRIMARY KEY \(channel, wallet_address, day\)/);
  assert.match(migration, /PRIMARY KEY \(channel, week_close_at, wallet_address\)/);
  assert.equal(migration.match(/CHECK \(channel IN \('base_app', 'telegram'\)\)/g)?.length, 3);
  // Re-runnable: every key change is guarded by the constraint's name.
  assert.equal(migration.match(/IF (NOT )?EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = /g)?.length, 9);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS telegram_links/);
  assert.match(migration, /PRIMARY KEY \(chat_id, wallet_address\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS telegram_link_codes/);
  assert.match(migration, /code_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  // Nothing Telegram knows about the person is stored: no name, no username.
  assert.doesNotMatch(migration.replace(/^--.*$/gm, ''), /username|first_name|last_name|language/i);
  assert.match(migration, /ALTER TABLE telegram_links OWNER TO miorail_user/);
  assert.match(migration, /ALTER TABLE telegram_link_codes OWNER TO miorail_user/);
});
