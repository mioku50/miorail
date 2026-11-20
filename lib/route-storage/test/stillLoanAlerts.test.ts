import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { describe } from 'node:test';

import {
  InMemoryStillLoanAlertRepositoryV1,
  createDatabaseStillLoanAlertRepositoryV1,
  stillLoanHoldsAfterV1,
  stillLoanInterestStepV1,
  stillLoanRateAfterV1,
  stillLoanRateJumpedV1,
} from '../src/stillLoanAlerts.js';
import { stillLoanAlertsContractV1 } from './stillLoanAlerts.contract.js';

// ---------------------------------------------------------------------------
// Still's loan alerts: one row per loan, told once per worse band.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const SPOKE = '0x17905db0e4a3514467539956c084180616ae7b8d';

stillLoanAlertsContractV1('memory', async () => new InMemoryStillLoanAlertRepositoryV1());

describe('who is read', () => {
  test('the reachable wallets with a Still borrow, in address order, up to the limit, the unreachable filtered first (audit LL-3)', async () => {
    const alerts = new InMemoryStillLoanAlertRepositoryV1();
    alerts.confirmedBorrowers.add('0x3333333333333333333333333333333333333333');
    alerts.confirmedBorrowers.add(WALLET);
    alerts.confirmedBorrowers.add('0x0000000000000000000000000000000000000001');
    const reachable = [WALLET, '0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444'];
    assert.deepEqual(await alerts.borrowers({ reachable, limit: 5 }), [WALLET, '0x3333333333333333333333333333333333333333']);
    // An unreachable wallet earlier in the alphabet takes no place under the limit.
    assert.deepEqual(await alerts.borrowers({ reachable, limit: 1 }), [WALLET]);
    assert.deepEqual(await alerts.borrowers({ reachable: [], limit: 5 }), []);
  });
  test('the SQL takes every borrow that went to the wallet, and filters reachability before the limit', () => {
    const root = process.cwd().endsWith('lib/route-storage') ? resolve(process.cwd(), '..', '..') : process.cwd();
    const source = readFileSync(resolve(root, 'lib/route-storage/src/stillLoanAlerts.ts'), 'utf8');
    const query = source.slice(source.indexOf('async borrowers(input)'), source.indexOf('async attention()', source.indexOf('async borrowers(input)')));
    assert.match(query, /operation = 'borrow' AND state <> 'ready'/);
    assert.match(query, /wallet_address = ANY\(\$\{reachable\}::text\[\]\)[\s\S]*LIMIT/);
    assert.doesNotMatch(query, /state = 'confirmed'/);
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
    // Readers are the wallets whose Still borrow went to the wallet, in any state but ready (audit LL-3).
    assert.match(source, /FROM lending_executions\s+WHERE operation = 'borrow' AND state <> 'ready'/);
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

describe('the interest one reading adds', () => {
  const AT = new Date('2026-11-02T15:00:00.000Z');
  const before = (debtAtomic: string | null, rateBps: number | null = 500) => ({ debtAtomic, rateBps, readAt: AT.toISOString() });
  const at = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);

  test('growth within half again the rate charge is measured interest; a borrow or a repayment between is the charge, estimated', () => {
    // 1,000 USDC at 5% a year for five minutes charges 475 base units.
    assert.deepEqual(stillLoanInterestStepV1({ before: before('1000000000'), debtAtomic: '1000000475', at: at(5) }), { interest: 475n, estimated: 0n });
    assert.deepEqual(stillLoanInterestStepV1({ before: before('1000000000'), debtAtomic: '1000000714', at: at(5) }), { interest: 714n, estimated: 0n });
    assert.deepEqual(stillLoanInterestStepV1({ before: before('1000000000'), debtAtomic: '1000000715', at: at(5) }), { interest: 475n, estimated: 475n });
    assert.deepEqual(stillLoanInterestStepV1({ before: before('1000000000'), debtAtomic: '900000000', at: at(5) }), { interest: 475n, estimated: 475n });
    // One unit down is rounding, not a repayment.
    assert.deepEqual(stillLoanInterestStepV1({ before: before('1000000000'), debtAtomic: '999999999', at: at(5) }), { interest: 0n, estimated: 0n });
    // A small loan grows by whole units now and then: those count, nothing is invented between.
    assert.deepEqual(stillLoanInterestStepV1({ before: before('180000', 366), debtAtomic: '180001', at: at(5) }), { interest: 1n, estimated: 0n });
    assert.deepEqual(stillLoanInterestStepV1({ before: before('180000', 366), debtAtomic: '180000', at: at(5) }), { interest: 0n, estimated: 0n });
  });

  test('nothing is counted without two debts, without time between them, from no debt, or estimated without a rate', () => {
    assert.deepEqual(stillLoanInterestStepV1({ before: null, debtAtomic: '1000000475', at: at(5) }), { interest: 0n, estimated: 0n });
    assert.deepEqual(stillLoanInterestStepV1({ before: before(null), debtAtomic: '1000000475', at: at(5) }), { interest: 0n, estimated: 0n });
    assert.deepEqual(stillLoanInterestStepV1({ before: before('1000000000'), debtAtomic: null, at: at(5) }), { interest: 0n, estimated: 0n });
    assert.deepEqual(stillLoanInterestStepV1({ before: before('1000000000'), debtAtomic: '1000000475', at: AT }), { interest: 0n, estimated: 0n });
    assert.deepEqual(stillLoanInterestStepV1({ before: before('0'), debtAtomic: '50000000', at: at(5) }), { interest: 0n, estimated: 0n });
    // With no rate read, growth up to 100% a year still reads as interest; a jump past it adds nothing.
    assert.deepEqual(stillLoanInterestStepV1({ before: before('1000000000', null), debtAtomic: '1000009000', at: at(5) }), { interest: 9_000n, estimated: 0n });
    assert.deepEqual(stillLoanInterestStepV1({ before: before('1000000000', null), debtAtomic: '1050000000', at: at(5) }), { interest: 0n, estimated: 0n });
  });
});

describe('the holds after a reading', () => {
  test('held ones join, cleared ones go, unread ones stay; only a hold the row did not have is news', () => {
    assert.deepEqual(stillLoanHoldsAfterV1(['PAXG:transfers_paused'], undefined), { holds: ['PAXG:transfers_paused'], appeared: false });
    assert.deepEqual(stillLoanHoldsAfterV1([], { held: ['NVDAc:transfers_paused'], cleared: [] }), { holds: ['NVDAc:transfers_paused'], appeared: true });
    assert.deepEqual(stillLoanHoldsAfterV1(['NVDAc:transfers_paused'], { held: ['NVDAc:transfers_paused'], cleared: ['AAPLc:transfers_paused'] }),
      { holds: ['NVDAc:transfers_paused'], appeared: false });
    assert.deepEqual(stillLoanHoldsAfterV1(['NVDAc:transfers_paused', 'NVDAc:feed_paused'], { held: [], cleared: ['NVDAc:transfers_paused'] }),
      { holds: ['NVDAc:feed_paused'], appeared: false });
  });
});

describe('the borrows a channel has not told', () => {
  test('a reachable wallet, confirmed since the line, not told on this channel, oldest first', async () => {
    const alerts = new InMemoryStillLoanAlertRepositoryV1();
    const borrow = (executionId: string, confirmedAt: string, walletAddress = WALLET) => ({
      executionId, walletAddress, venue: 'morpho' as const, marketId: `0x${'ab'.repeat(32)}`, confirmedAt, facts: { requestedAssets: '1000000' }, proof: null,
    });
    alerts.confirmedLoans.push(
      borrow('b', '2026-11-17T10:05:00.000Z'),
      borrow('a', '2026-11-17T10:00:00.000Z'),
      borrow('old', '2026-11-17T01:00:00.000Z'),
      borrow('stranger', '2026-11-17T10:00:00.000Z', '0x9999999999999999999999999999999999999999'),
    );
    const since = new Date('2026-11-17T04:00:00.000Z');
    assert.deepEqual((await alerts.openedDue({ channel: 'telegram', wallets: [WALLET], since })).map((row) => row.executionId), ['a', 'b']);
    await alerts.recordNotice({ channel: 'telegram', kind: 'opened', key: 'a', walletAddress: WALLET, market: `0x${'ab'.repeat(32)}`, at: since });
    assert.deepEqual((await alerts.openedDue({ channel: 'telegram', wallets: [WALLET], since })).map((row) => row.executionId), ['b']);
    assert.deepEqual((await alerts.openedDue({ channel: 'base_app', wallets: [WALLET], since })).map((row) => row.executionId), ['a', 'b']);
  });

  test('the SQL reads only confirmed borrows of the given wallets that this channel has not told', () => {
    const root = process.cwd().endsWith('lib/route-storage') ? resolve(process.cwd(), '..', '..') : process.cwd();
    const source = readFileSync(resolve(root, 'lib/route-storage/src/stillLoanAlerts.ts'), 'utf8');
    const query = source.slice(source.indexOf('async openedDue(input) {'), source.indexOf('async recordNotice(input) {'));
    assert.match(query, /e\.operation = 'borrow' AND e\.state = 'confirmed'/);
    assert.match(query, /e\.wallet_address = ANY\(\$\{wallets\}::text\[\]\)/);
    assert.match(query, /n\.kind = 'opened' AND n\.notice_key = e\.execution_id::text/);
    const migration = readFileSync(resolve(root, 'lib/db/drizzle/0099_still_loan_notices.sql'), 'utf8');
    assert.match(migration, /PRIMARY KEY \(channel, kind, notice_key\)/);
    assert.match(migration, /kind IN \('opened', 'week', 'hold'\)/);
    assert.match(migration, /ALTER TABLE still_loan_notices OWNER TO miorail_user/);
    assert.match(readFileSync(resolve(root, 'lib/db/drizzle/meta/_journal.json'), 'utf8'), /"tag": "0099_still_loan_notices"/);
  });
});

describe('a rate jump', () => {
  test('at least 2 points over the rate heard of, and at least half again', () => {
    assert.equal(stillLoanRateJumpedV1(366, 566), true);
    assert.equal(stillLoanRateJumpedV1(366, 565), false);
    assert.equal(stillLoanRateJumpedV1(1_000, 1_499), false, '5 points is not half again over 10%');
    assert.equal(stillLoanRateJumpedV1(1_000, 1_500), true);
    assert.equal(stillLoanRateJumpedV1(0, 200), true);
    assert.equal(stillLoanRateJumpedV1(0, 199), false);
  });

  test('the first rate read is the one heard of; a jump starts a stretch and an episode once; no jump ends it; no rate read changes nothing', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 17, 10, minute)).toISOString();
    const first = stillLoanRateAfterV1(null, 410, at(0));
    assert.deepEqual(first, { rateToldBps: 410, rateToldAt: at(0), rateHighSince: null, rateEpisode: 0 });
    assert.deepEqual(stillLoanRateAfterV1(null, null, at(0)), { rateToldBps: null, rateToldAt: null, rateHighSince: null, rateEpisode: 0 });
    const high = stillLoanRateAfterV1(first, 1_240, at(5));
    assert.deepEqual(high, { ...first, rateHighSince: at(5), rateEpisode: 1 });
    assert.deepEqual(stillLoanRateAfterV1(high, 1_300, at(10)), high);
    assert.deepEqual(stillLoanRateAfterV1(high, null, at(10)), high);
    assert.deepEqual(stillLoanRateAfterV1(high, 500, at(10)), { ...high, rateHighSince: null });
  });

  test('the SQL that tells it reads the stretch and its episode, and telling a rate ends the stretch', async () => {
    const root = process.cwd().endsWith('lib/route-storage') ? resolve(process.cwd(), '..', '..') : process.cwd();
    const source = readFileSync(resolve(root, 'lib/route-storage/src/stillLoanAlerts.ts'), 'utf8');
    const query = source.slice(source.indexOf('async rateDue(input) {'), source.indexOf('async markRateTold(input) {'));
    assert.match(query, /a\.rate_high_since <= \$\{input\.highSince\.toISOString\(\)\}::timestamptz/);
    // With the loan's first reading for a loan read from 2026-11-21 (audit LL-1).
    assert.match(query, /n\.kind = 'rate'\s+AND n\.notice_key = a\.wallet_address \|\| '\|' \|\| a\.market \|\| '\|' \|\| CASE WHEN a\.created_at >= \$\{STILL_LOAN_GENERATION_FROM_V1\}::timestamptz THEN floor\(extract\(epoch FROM a\.created_at\)\)::bigint::text \|\| '\|' ELSE '' END \|\| a\.rate_episode::text/);
    const calls: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      calls.push(strings.join('$'));
      return [];
    }) as unknown as Parameters<typeof createDatabaseStillLoanAlertRepositoryV1>[0];
    await createDatabaseStillLoanAlertRepositoryV1(sql).markRateTold({ walletAddress: WALLET, market: SPOKE, rateBps: 1_240, at: new Date() });
    assert.match(calls[0]!, /SET rate_told_bps = \$, rate_told_at = \$::timestamptz, rate_high_since = NULL\s+WHERE wallet_address = \$ AND market = \$/);
  });
});

describe('a margin back', () => {
  test('the SQL asks for calm at two readings, the worse band of this episode told on this channel, and no notice for it', () => {
    const root = process.cwd().endsWith('lib/route-storage') ? resolve(process.cwd(), '..', '..') : process.cwd();
    const source = readFileSync(resolve(root, 'lib/route-storage/src/stillLoanAlerts.ts'), 'utf8');
    const query = source.slice(source.indexOf('async recoveredDue(input) {'), source.indexOf('async rateDue(input) {'));
    assert.match(query, /a\.state = 'calm' AND a\.episode > 0/);
    assert.match(query, /THEN a\.told_base_app ELSE a\.told_telegram END\) = a\.episode/);
    assert.match(query, /COALESCE\(a\.state_since, a\.read_at\) < a\.read_at/);
    // With the loan's first reading for a loan read from 2026-11-21 (audit LL-1).
    assert.match(query, /n\.kind = 'recovered'\s+AND n\.notice_key = a\.wallet_address \|\| '\|' \|\| a\.market \|\| '\|' \|\| CASE WHEN a\.created_at >= \$\{STILL_LOAN_GENERATION_FROM_V1\}::timestamptz THEN floor\(extract\(epoch FROM a\.created_at\)\)::bigint::text \|\| '\|' ELSE '' END \|\| a\.episode::text/);
  });
});

describe('the repayments a channel has not told', () => {
  test('a reachable wallet, confirmed since the line, no debt left, not told on this channel, oldest first', async () => {
    const alerts = new InMemoryStillLoanAlertRepositoryV1();
    const repay = (executionId: string, confirmedAt: string, remainingDebtAssets: string, walletAddress = WALLET) => ({
      executionId, walletAddress, venue: 'morpho' as const, marketId: `0x${'ab'.repeat(32)}`, confirmedAt, facts: { operation: 'repay' },
      proof: { appliedAssets: '1000000', remainingDebtAssets },
    });
    alerts.confirmedRepays.push(
      repay('b', '2026-11-17T10:05:00.000Z', '0'),
      repay('a', '2026-11-17T10:00:00.000Z', '0'),
      repay('part', '2026-11-17T10:00:00.000Z', '26810000'),
      repay('old', '2026-11-17T01:00:00.000Z', '0'),
      repay('stranger', '2026-11-17T10:00:00.000Z', '0', '0x9999999999999999999999999999999999999999'),
    );
    const since = new Date('2026-11-17T04:00:00.000Z');
    assert.deepEqual((await alerts.closedDue({ channel: 'telegram', wallets: [WALLET], since })).map((row) => row.executionId), ['a', 'b']);
    await alerts.recordNotice({ channel: 'telegram', kind: 'closed', key: 'a', walletAddress: WALLET, market: `0x${'ab'.repeat(32)}`, at: since });
    assert.deepEqual((await alerts.closedDue({ channel: 'telegram', wallets: [WALLET], since })).map((row) => row.executionId), ['b']);
    assert.deepEqual((await alerts.closedDue({ channel: 'base_app', wallets: [WALLET], since })).map((row) => row.executionId), ['a', 'b']);
  });

  test('the SQL reads only confirmed repayments that left no debt, of the given wallets, that this channel has not told', () => {
    const root = process.cwd().endsWith('lib/route-storage') ? resolve(process.cwd(), '..', '..') : process.cwd();
    const source = readFileSync(resolve(root, 'lib/route-storage/src/stillLoanAlerts.ts'), 'utf8');
    const query = source.slice(source.indexOf('async closedDue(input) {'), source.indexOf('async recoveredDue(input) {'));
    assert.match(query, /e\.operation = 'repay' AND e\.state = 'confirmed'/);
    assert.match(query, /e\.verification_json -> 'effect' ->> 'remainingDebtAssets' = '0'/);
    assert.match(query, /e\.wallet_address = ANY\(\$\{wallets\}::text\[\]\)/);
    assert.match(query, /n\.kind = 'closed' AND n\.notice_key = e\.execution_id::text/);
    const migration = readFileSync(resolve(root, 'lib/db/drizzle/0100_still_loan_closed_recovered_rate.sql'), 'utf8');
    assert.match(migration, /kind IN \('opened', 'week', 'hold', 'closed', 'recovered', 'rate'\)/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS state_since\s+timestamptz/);
    assert.match(migration, /\(rate_told_bps IS NULL\) = \(rate_told_at IS NULL\)/);
    assert.match(migration, /rate_high_since IS NULL OR rate_episode > 0/);
    assert.match(readFileSync(resolve(root, 'lib/db/drizzle/meta/_journal.json'), 'utf8'), /"tag": "0100_still_loan_closed_recovered_rate"/);
  });
});

describe('the weekend bands', () => {
  test('a key per loan, window and band; the SQL asks only this channel and kind; 0101 lets the table keep the kind', async () => {
    const { stillLoanWeekendKeyV1 } = await import('../src/stillLoanAlerts.js');
    assert.equal(stillLoanWeekendKeyV1({ walletAddress: WALLET, market: SPOKE, windowStartsAt: '2026-11-21T01:00:00.000Z', state: 'act' }),
      `${WALLET}|${SPOKE}|2026-11-21T01:00:00.000Z|act`);
    const root = process.cwd().endsWith('lib/route-storage') ? resolve(process.cwd(), '..', '..') : process.cwd();
    const source = readFileSync(resolve(root, 'lib/route-storage/src/stillLoanAlerts.ts'), 'utf8');
    const query = source.slice(source.indexOf('async noticesTold(input) {'), source.indexOf('async recordNotice(input) {', source.indexOf('async noticesTold(input) {')));
    assert.match(query, /WHERE channel = \$\{input\.channel\} AND kind = \$\{input\.kind\} AND notice_key = ANY\(\$\{\[\.\.\.input\.keys\]\}::text\[\]\)/);
    const migration = readFileSync(resolve(root, 'lib/db/drizzle/0101_still_loan_weekend_notices.sql'), 'utf8');
    assert.match(migration, /kind IN \('opened', 'week', 'hold', 'closed', 'recovered', 'rate', 'weekend'\)/);
    assert.match(readFileSync(resolve(root, 'lib/db/drizzle/meta/_journal.json'), 'utf8'), /"tag": "0101_still_loan_weekend_notices"/);
  });
});
