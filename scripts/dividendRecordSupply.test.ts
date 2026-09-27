import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { B20BlockHeaderV1, B20ReaderV1 } from '@mioagent/b20-control';
import { InMemoryDividendRecordSupplyRepositoryV1 } from '@mioagent/route-storage';
import type { DividendDeclarationV1 } from '@mioagent/rwa-market-reality/dividends';

import { recordDividendSuppliesV1 } from './dividendRecordSupply.js';

const AAPLC = '0xb200000000000000000000c2e324d24d7eecd1fb';
const GOOGLC = '0xb2000000000000000000002d0ba3164cc74f58b7';
const APPLE = 'security:isin:US0378331005';
const ALPHABET = 'security:isin:US02079K3059';

function declaration(underlyingKey: string, recordDate: string, payDate: string): DividendDeclarationV1 {
  return {
    underlyingKey,
    symbol: 'X',
    company: 'X',
    amountPerShare: '0.1',
    declaredOn: '2026-07-01',
    exDate: null,
    recordDate,
    payDate,
    source: { publisher: 'x', url: 'https://www.sec.gov/x', quote: 'x' },
  };
}

/** Two-second blocks from block 1 at 2026-07-01T00:00:00Z, head at 3,000,000.
 * AAPLc has no code before block 2,000,000; GOOGLc always has supply. */
function readerV1() {
  const start = Date.parse('2026-07-01T00:00:00Z') / 1000;
  const head = 3_000_000;
  const calls: string[] = [];
  const header = (n: number): B20BlockHeaderV1 => ({ blockNumber: n, blockHash: `0x${n.toString(16).padStart(64, '0')}` as never, timestamp: start + (n - 1) * 2 });
  const reader = {
    async readBlockHeader(tag: string) {
      const n = tag === 'latest' ? head : Number.parseInt(tag, 16);
      return { ok: true as const, value: n > head ? null : header(n), raw: 'x' };
    },
    async call(input: { to: string; data: string; blockTag: string }) {
      calls.push(`${input.to.slice(-4)}:${input.data}:${input.blockTag}`);
      if (input.data === '0x313ce567') return { ok: true as const, value: `0x${(8).toString(16).padStart(64, '0')}`, raw: 'x' };
      const block = Number.parseInt(input.blockTag, 16);
      if (input.to === AAPLC && block < 2_000_000) return { ok: false as const, reason: 'empty_result' as const };
      return { ok: true as const, value: `0x${(611369380000).toString(16).padStart(64, '0')}`, raw: 'x' };
    },
  } as unknown as B20ReaderV1;
  return { reader, calls };
}

describe('supply at each record date', () => {
  const tokens = [
    { tokenAddress: AAPLC, underlyingKey: APPLE },
    { tokenAddress: GOOGLC, underlyingKey: ALPHABET },
    { tokenAddress: '0xb200000000000000000000d9192b6b456483c2e8', underlyingKey: 'security:isin:US0231351067' },
  ];
  const declarations = [
    declaration(APPLE, '2026-08-10', '2026-08-13'),
    declaration(ALPHABET, '2026-09-07', '2026-09-14'),
    declaration(ALPHABET, '2026-12-07', '2026-12-14'),
  ];

  test('read once at the close of each past record date; a token that did not exist yet had none', async () => {
    const repository = new InMemoryDividendRecordSupplyRepositoryV1();
    const { reader, calls } = readerV1();
    const now = new Date('2026-09-27T12:00:00Z');
    const pass = await recordDividendSuppliesV1({ reader, repository, tokens, declarations, now });
    assert.deepEqual(pass, { recorded: 2, known: 0, pending: 1, failed: [] });
    const rows = await repository.supplies({ chainId: 8453, tokenAddresses: [AAPLC, GOOGLC] });
    const apple = rows.find((row) => row.tokenAddress === AAPLC)!;
    const alphabet = rows.find((row) => row.tokenAddress === GOOGLC)!;
    assert.equal(apple.totalSupplyAtomic, '0');
    assert.equal(alphabet.totalSupplyAtomic, '611369380000');
    assert.equal(alphabet.recordCloseAt, '2026-09-07T20:00:00.000Z');
    assert.ok(Date.parse(alphabet.blockTime) <= Date.parse(alphabet.recordCloseAt));
    assert.ok(Date.parse(alphabet.blockTime) > Date.parse(alphabet.recordCloseAt) - 2_000);
    // A stock with no declaration is never read.
    assert.ok(!calls.some((call) => call.startsWith('c2e8')));

    // The next pass reads nothing it already has.
    const again = await recordDividendSuppliesV1({ reader, repository, tokens, declarations, now });
    assert.deepEqual(again, { recorded: 0, known: 2, pending: 1, failed: [] });
  });

  test('an endpoint that fails is a failure, recorded as nothing', async () => {
    const repository = new InMemoryDividendRecordSupplyRepositoryV1();
    const reader = {
      async readBlockHeader() {
        return { ok: false as const, reason: 'rate_limited' as const };
      },
      async call() {
        return { ok: false as const, reason: 'rate_limited' as const };
      },
    } as unknown as B20ReaderV1;
    const pass = await recordDividendSuppliesV1({ reader, repository, tokens, declarations, now: new Date('2026-09-27T12:00:00Z') });
    assert.deepEqual(pass.failed, ['2026-08-10:block_rate_limited', '2026-09-07:block_rate_limited']);
    assert.equal((await repository.supplies({ chainId: 8453, tokenAddresses: [AAPLC, GOOGLC] })).length, 0);
  });
});
