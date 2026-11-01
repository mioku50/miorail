import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { describe } from 'node:test';

import {
  InMemoryStillLoanAlertRepositoryV1,
  createDatabaseStillLoanAlertRepositoryV1,
} from '../src/stillLoanAlerts.js';
import { stillLoanAlertsContractV1 } from './stillLoanAlerts.contract.js';

// ---------------------------------------------------------------------------
// Still's loan alerts: one row per loan, told once per worse band.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const SPOKE = '0x17905db0e4a3514467539956c084180616ae7b8d';

stillLoanAlertsContractV1('memory', async () => new InMemoryStillLoanAlertRepositoryV1());

describe('who is read', () => {
  test('the wallets with a confirmed Still borrow, in address order, up to the limit', async () => {
    const alerts = new InMemoryStillLoanAlertRepositoryV1();
    alerts.confirmedBorrowers.add('0x3333333333333333333333333333333333333333');
    alerts.confirmedBorrowers.add(WALLET);
    assert.deepEqual(await alerts.borrowers(5), [WALLET, '0x3333333333333333333333333333333333333333']);
    assert.deepEqual(await alerts.borrowers(1), [WALLET]);
  });
});

describe('the table and the SQL say the same', () => {
  const root = process.cwd().endsWith('lib/route-storage') ? resolve(process.cwd(), '..', '..') : process.cwd();
  const migration = readFileSync(resolve(root, 'lib/db/drizzle/0093_still_loan_alerts.sql'), 'utf8');
  const source = readFileSync(resolve(root, 'lib/route-storage/src/stillLoanAlerts.ts'), 'utf8');
  const journal = readFileSync(resolve(root, 'lib/db/drizzle/meta/_journal.json'), 'utf8');

  test('the migration holds the rules the store enforces, and the deploy applies it', () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS still_loan_alerts/);
    assert.match(migration, /PRIMARY KEY \(wallet_address, market\)/);
    assert.match(migration, /wallet_address ~ '\^0x\[0-9a-f\]\{40\}\$'/);
    assert.match(migration, /market ~ '\^0x\[0-9a-f\]\{40\}\(\[0-9a-f\]\{24\}\)\?\$'/);
    assert.match(migration, /state IN \('calm', 'watch', 'act', 'liquidation'\)/);
    assert.match(migration, /margin_bps BETWEEN 0 AND 10000/);
    assert.match(migration, /told_telegram IS NULL OR told_telegram BETWEEN 0 AND episode/);
    assert.match(migration, /ALTER TABLE still_loan_alerts OWNER TO miorail_user/);
    assert.equal(migration.match(/CREATE TABLE/g)?.length, 1);
    // The deploy's migrator skips a file the journal does not name.
    assert.match(journal, /"tag": "0093_still_loan_alerts"/);
  });

  test('only a worse band moves the episode, and an older block is no update', () => {
    assert.match(source, /WHEN \$\{rank\}::int > array_position\(ARRAY\['calm', 'watch', 'act', 'liquidation'\], a\.state\) - 1/);
    assert.match(source, /WHERE a\.read_block <= EXCLUDED\.read_block/);
    // Readers are the wallets whose Still loan was confirmed onchain.
    assert.match(source, /FROM lending_executions\s+WHERE operation = 'borrow' AND state = 'confirmed'/);
  });

  test('a channel writes only its own column, and only for the current episode', async () => {
    const calls: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      calls.push(strings.join('$'));
      return [];
    }) as unknown as Parameters<typeof createDatabaseStillLoanAlertRepositoryV1>[0];
    const alerts = createDatabaseStillLoanAlertRepositoryV1(sql);
    await alerts.markTold({ walletAddress: WALLET, market: SPOKE, channel: 'telegram', episode: 2 });
    await alerts.markTold({ walletAddress: WALLET, market: SPOKE, channel: 'base_app', episode: 2 });
    assert.match(calls[0]!, /SET told_telegram = \$\s+WHERE wallet_address = \$ AND market = \$ AND episode = \$/);
    assert.match(calls[1]!, /SET told_base_app = \$\s+WHERE wallet_address = \$ AND market = \$ AND episode = \$/);
  });
});
