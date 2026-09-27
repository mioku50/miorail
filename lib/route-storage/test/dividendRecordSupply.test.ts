import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  InMemoryDividendRecordSupplyRepositoryV1,
  createDatabaseDividendRecordSupplyRepositoryV1,
  dividendSupplyDecimalV1,
  type DividendRecordSupplyV1,
} from '../src/index.js';

const GOOGL = '0xb2000000000000000000002d0ba3164cc74f58b7';

function row(over: Partial<DividendRecordSupplyV1> = {}): DividendRecordSupplyV1 {
  return {
    chainId: 8453,
    tokenAddress: GOOGL,
    recordDate: '2026-09-07',
    recordCloseAt: '2026-09-07T20:00:00.000Z',
    blockNumber: 51_010_926,
    blockTime: '2026-09-07T19:59:59.000Z',
    totalSupplyAtomic: '611369380000',
    decimals: 8,
    readAt: '2026-09-27T12:00:00.000Z',
    ...over,
  };
}

describe('supply at a record date', () => {
  test('recorded once; a second read of the same date changes nothing', async () => {
    const repository = new InMemoryDividendRecordSupplyRepositoryV1();
    assert.equal(await repository.record(row()), 'recorded');
    assert.equal(await repository.record(row({ totalSupplyAtomic: '1' })), 'already_recorded');
    const [stored] = await repository.supplies({ chainId: 8453, tokenAddresses: [GOOGL] });
    assert.equal(stored?.totalSupplyAtomic, '611369380000');
    assert.equal(dividendSupplyDecimalV1(stored!), '6113.6938');
  });

  test('a block after the close, a malformed amount or token is refused', async () => {
    const repository = new InMemoryDividendRecordSupplyRepositoryV1();
    await assert.rejects(repository.record(row({ blockTime: '2026-09-07T20:00:01.000Z' })), /after_close/);
    await assert.rejects(repository.record(row({ totalSupplyAtomic: '-1' })), /amount/);
    await assert.rejects(repository.record(row({ tokenAddress: GOOGL.toUpperCase() })), /token/);
    await assert.rejects(repository.record(row({ recordDate: '2026-9-7' })), /date/);
  });

  test('zero is a supply, and it prints as zero', () => {
    assert.equal(dividendSupplyDecimalV1({ totalSupplyAtomic: '0', decimals: 8 }), '0');
    assert.equal(dividendSupplyDecimalV1({ totalSupplyAtomic: '100000000', decimals: 8 }), '1');
    assert.equal(dividendSupplyDecimalV1({ totalSupplyAtomic: '5', decimals: 8 }), '0.00000005');
  });

  test('the Postgres repository writes first-wins and reads the date back as a date', async () => {
    const statements: string[] = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(strings.join('?'));
      if (/INSERT INTO dividend_record_supply/.test(strings.join(''))) return [{ token_address: values[1] }];
      return [
        {
          token_address: GOOGL,
          record_date: '2026-09-07',
          record_close_at: new Date('2026-09-07T20:00:00.000Z'),
          block_number: '51010926',
          block_time: new Date('2026-09-07T19:59:59.000Z'),
          total_supply_atomic: '611369380000',
          decimals: 8,
          read_at: new Date('2026-09-27T12:00:00.000Z'),
        },
      ];
    }) as never;
    const repository = createDatabaseDividendRecordSupplyRepositoryV1(sql);
    assert.equal(await repository.record(row()), 'recorded');
    assert.match(statements[0]!, /ON CONFLICT \(chain_id, token_address, record_date\) DO NOTHING/);
    const [read] = await repository.supplies({ chainId: 8453, tokenAddresses: [GOOGL] });
    assert.deepEqual(read, row());
    assert.deepEqual(await repository.supplies({ chainId: 8453, tokenAddresses: [] }), []);
  });
});
