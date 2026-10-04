import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import postgres from 'postgres';

import assert from 'node:assert/strict';

import { createDatabaseBaseAppNotificationRepositoryV1 } from '../src/baseAppNotificationsDatabase.js';
import { createDatabaseReopenGameRepositoryV1 } from '../src/reopenGameDatabase.js';
import { reopenGameContract } from './reopenGame.contract.js';

const url = process.env.MIOAGENT_MIGRATION_TEST_URL;
// This suite truncates tables. Require the named disposable database and local endpoint.
const temporary = !!url && /^postgres:\/\/.*@127\.0\.0\.1:\d+\/miorail_reopen_game_test$/.test(url);
let sql: ReturnType<typeof postgres>;
before(async () => {
  if (!temporary) return;
  sql = postgres(url!, { max: 1, onnotice() {} });
  const root = process.cwd().endsWith('lib/route-storage')
    ? resolve(process.cwd(), '../db/drizzle')
    : resolve(process.cwd(), 'lib/db/drizzle');
  // Twice: the migration must run again over itself without failing.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const file of ['0079_reopen_game.sql', '0080_reopen_leaderboard_notices.sql', '0081_reopen_shares.sql']) {
      await sql.unsafe(await readFile(resolve(root, file), 'utf8'));
    }
  }
});
after(async () => {
  if (sql) await sql.end({ timeout: 5 });
});
if (!temporary) test('disposable Postgres reopen game test', { skip: true }, () => {});
else
  reopenGameContract('postgres', async () => {
    // RESTART IDENTITY: player numbers start at 1 for every case, as they do
    // on an empty memory store.
    await sql`TRUNCATE reopen_shares, reopen_notices, reopen_picks, reopen_players, reopen_rounds RESTART IDENTITY`;
    return createDatabaseReopenGameRepositoryV1((strings, ...values) =>
      (sql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>)(
        strings,
        ...values,
      ),
    );
  });

if (temporary)
  test('postgres: round notices are kept per channel, round, kind and wallet', async () => {
    const executor = (strings: TemplateStringsArray, ...values: unknown[]) =>
      (sql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>)(
        strings,
        ...values,
      );
    await sql`TRUNCATE reopen_shares, reopen_notices, reopen_picks, reopen_players, reopen_rounds RESTART IDENTITY`;
    await createDatabaseReopenGameRepositoryV1(executor).openRound({
      opening: {
        roundId: '2026-10-09',
        closeAt: '2026-10-09T20:00:00.000Z',
        opensAt: '2026-10-10T00:00:00.000Z',
        locksAt: '2026-10-11T21:00:00.000Z',
        expectedReopenAt: '2026-10-12T00:00:00.000Z',
        nextSessionCloseAt: '2026-10-12T20:00:00.000Z',
        stocks: [],
      },
      now: new Date('2026-10-10T01:00:00.000Z'),
    });
    const baseApp = createDatabaseBaseAppNotificationRepositoryV1(executor);
    const telegram = createDatabaseBaseAppNotificationRepositoryV1(executor, { channel: 'telegram' });
    const wallet = '0x1111111111111111111111111111111111111111';
    const at = new Date('2026-10-10T14:00:00.000Z');
    await baseApp.recordReopenSent({ roundId: '2026-10-09', kind: 'open', wallets: [wallet, wallet], at });
    await baseApp.recordReopenSent({ roundId: '2026-10-09', kind: 'open', wallets: [wallet], at });
    assert.deepEqual([...(await baseApp.reopenSentTo({ roundId: '2026-10-09', kind: 'open', wallets: [wallet] }))], [wallet]);
    assert.deepEqual([...(await telegram.reopenSentTo({ roundId: '2026-10-09', kind: 'open', wallets: [wallet] }))], []);
    assert.deepEqual([...(await baseApp.reopenSentTo({ roundId: '2026-10-09', kind: 'results', wallets: [wallet] }))], []);
    // A notice for a round that does not exist is refused by the table.
    await assert.rejects(baseApp.recordReopenSent({ roundId: '2026-10-02', kind: 'open', wallets: [wallet], at }));
  });

