import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, parseAbi, type PublicClient } from 'viem';
import { createDividendCalendar, readDividendCalendar } from '../src/dividend-calendar.js';
import { createDividendSource, reinvestment, stockMultiplierAbi } from '../src/dividends.js';
import { STOCKS } from '../src/registry.js';
import type { Provider } from '../src/rpc.js';
import { assertMatches } from './matches.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/dividends-base.json', import.meta.url), 'utf8')) as {
  capturedAt: string;
  cache: unknown;
  calendarAnswers: unknown[];
  records: Array<{ method: string; request: Record<string, unknown>; result: unknown; failed?: boolean }>;
  expected: Awaited<ReturnType<ReturnType<typeof createDividendSource>['current']>>;
};
const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const announcement = parseAbi(['event Announcement(address indexed caller,string id,string description,string uri)']);

function rpc(records = structuredClone(fixture.records)) {
  const calls: string[] = [];
  const run = async (method: string, request: Record<string, unknown>) => {
    calls.push(method);
    const match = records.find((r) => r.method === method && json(r.request) === json(request));
    if (!match || match.failed) throw new Error('recorded RPC read unavailable');
    const value = structuredClone(match.result);
    if (method === 'getBlock') {
      const b = value as { number: string; timestamp: string; hash: string };
      return { ...b, number: BigInt(b.number), timestamp: BigInt(b.timestamp) };
    }
    return value;
  };
  const provider: Provider = {
    label: 'replay',
    client: {
      readContract: (p: { args: unknown; blockNumber?: bigint }) =>
        run('readContract', { args: p.args, blockNumber: p.blockNumber ?? null }),
      getBlock: (p: Record<string, unknown>) => run('getBlock', p),
      getLogs: (p: Record<string, unknown>) => run('getLogs', { address: p.address, fromBlock: p.fromBlock, toBlock: p.toBlock }),
    } as unknown as PublicClient,
  };
  return { provider, calls, records };
}
function calendar() {
  let page = 0;
  return createDividendCalendar({
    now: () => new Date(fixture.capturedAt),
    fetch: async () => new Response(json(fixture.calendarAnswers[page++])),
  });
}
async function replay(records = structuredClone(fixture.records), cache: unknown = fixture.cache) {
  const dir = await mkdtemp(join(tmpdir(), 'still-dividends-'));
  await writeFile(join(dir, 'dividend-receipts-v1.json'), json(cache));
  const transport = rpc(records);
  const source = createDividendSource({
    providers: [transport.provider],
    calendar: calendar(),
    now: () => new Date(fixture.capturedAt),
    dataDir: dir,
  });
  const pending = source.current();
  const shared = source.current() === pending;
  return { report: await pending, source, transport, dir, shared };
}

describe('dividends through recorded public transport', () => {
  it('reads the whole registry and verifies the real issuer receipts, without a wallet', async () => {
    const { report, source, transport, shared } = await replay();
    assert.equal(shared, true);
    assert.deepEqual(report.coverage, {
      total: 7,
      calendarsRead: 7,
      adjustmentsRead: 7,
      receiptsVerified: 3,
      receiptsPriced: 2,
      receiptsUnread: 0,
    });
    assert.deepEqual(report.stocks.map((s) => s.asset), STOCKS.map((s) => s.id));
    const nvidia = report.stocks.find((s) => s.asset === 'NVDAc')!;
    assertMatches(nvidia.receipt.proof, {
      block: '52041960',
      multiplierBeforeWad: '1000000000000000000',
      multiplierAfterWad: '1000537939576369481',
      ofDeclaredBps: 4951,
    });
    assert.equal(nvidia.receipt.proof?.reinvestedUsdPerShare, '0.123793993770507007');
    assertMatches(report.stocks.find((s) => s.asset === 'GOOGLc')!.receipt, {
      state: 'verified',
      proof: { reinvestedUsdPerShare: null, ofDeclaredBps: null, oraclePrice: null },
    });
    assert.equal(report.stocks.find((s) => s.asset === 'AMZNc')!.next.state, 'no_dividends_listed');
    assert.equal(report.stocks.find((s) => s.asset === 'AAPLc')!.next.state, 'not_announced');
    const reads = transport.calls.length;
    assert.equal(await source.current(), report);
    assert.equal(transport.calls.length, reads);
  });

  it('re-proves disk locators rather than trusting cached money', async () => {
    const cached = structuredClone(fixture.cache) as { entries: Array<[string, { proof: Record<string, unknown> }]> };
    for (const [, value] of cached.entries) {
      value.proof.reinvestedUsdPerShare = '999999';
      value.proof.ofDeclaredBps = 999999;
    }
    const { report, transport } = await replay(undefined, cached);
    assert.equal(report.stocks.find((s) => s.asset === 'NVDAc')!.receipt.proof?.reinvestedUsdPerShare, '0.123793993770507007');
    assert.ok(transport.calls.includes('getLogs'));
  });

  for (const kind of ['description', 'transaction', 'closing', 'duplicate'] as const) {
    it(`does not turn an unproven ${kind} into a dividend receipt`, async () => {
      const records = structuredClone(fixture.records);
      const logRecord = records.find(
        (r) =>
          r.method === 'getLogs' && String(r.request.address).toLowerCase() === STOCKS.find((s) => s.id === 'NVDAc')!.token.toLowerCase(),
      )!;
      const logs = logRecord.result as Array<{
        data: `0x${string}`;
        topics: [`0x${string}`, ...`0x${string}`[]];
        transactionHash: string;
        logIndex: number;
      }>;
      const open = logs.find((l) => {
        try {
          return decodeEventLog({ abi: announcement, ...l }).eventName === 'Announcement';
        } catch {
          return false;
        }
      })!;
      if (kind === 'description') {
        const d = decodeEventLog({ abi: announcement, ...open });
        open.data = encodeAbiParameters(
          [{ type: 'string' }, { type: 'string' }, { type: 'string' }],
          [d.args.id, 'Stock Split', d.args.uri],
        );
      }
      if (kind === 'transaction') open.transactionHash = '0x' + '1'.repeat(64);
      if (kind === 'closing') logs.splice(logs.length - 1, 1);
      if (kind === 'duplicate') logs.push({ ...open });
      const { report } = await replay(records);
      assertMatches(report.stocks.find((s) => s.asset === 'NVDAc')!.receipt, {
        state: 'not_verified',
        reason: 'dividend_not_verified',
        proof: null,
      });
    });
  }

  it('treats failed scale reads as unread while keeping the measured calendar', async () => {
    const records = structuredClone(fixture.records);
    const selector = encodeFunctionData({ abi: stockMultiplierAbi, functionName: 'effectiveAt' });
    const snapshot = records.find((r) => r.method === 'readContract' && json(r.request).includes(selector))!;
    const calls = (snapshot.request.args as Array<Array<{ target: string; callData: string }>>)[0]!;
    const index = calls.findIndex(
      (c) => c.target.toLowerCase() === STOCKS.find((s) => s.id === 'NVDAc')!.token.toLowerCase() && c.callData === selector,
    );
    (snapshot.result as Array<{ success: boolean; returnData: string }>)[index] = { success: false, returnData: '0x' };
    const { report } = await replay(records);
    assert.equal(report.coverage.adjustmentsRead, 6);
    assertMatches(report.stocks.find((s) => s.asset === 'NVDAc'), {
      calendar: 'read',
      adjustment: { state: 'unread' },
      receipt: { state: 'unread', proof: null },
    });
  });

  it('does not call an already-matured scheduled timestamp a pending dividend', async () => {
    const records = structuredClone(fixture.records);
    const selector = encodeFunctionData({ abi: stockMultiplierAbi, functionName: 'effectiveAt' });
    const snapshot = records.find((r) => r.method === 'readContract' && json(r.request).includes(selector))!;
    const calls = (snapshot.request.args as Array<Array<{ target: string; callData: string }>>)[0]!;
    for (let i = 0; i < calls.length; i++)
      if (calls[i]!.callData === selector)
        (snapshot.result as Array<{ success: boolean; returnData: string }>)[i] = {
          success: true,
          returnData: encodeFunctionResult({ abi: stockMultiplierAbi, functionName: 'effectiveAt', result: 1n }),
        };
    const { report } = await replay(records);
    assert.equal(report.stocks.every((s) => s.adjustment.state === 'none' && s.adjustment.effectiveAt === null), true);
  });
});

describe('dividend calendar absences and paging', () => {
  it('keeps empty, absent and malformed stock rows separate', async () => {
    const answer = structuredClone(fixture.calendarAnswers[0]) as {
      data: { tokenizedStocks: { items: Array<{ address: string; offchain: { dividends: unknown } }> } };
    };
    answer.data.tokenizedStocks.items = answer.data.tokenizedStocks.items.filter(
      (i) => i.address.toLowerCase() !== STOCKS.find((s) => s.id === 'MSFTc')!.token.toLowerCase(),
    );
    answer.data.tokenizedStocks.items.find(
      (i) => i.address.toLowerCase() === STOCKS.find((s) => s.id === 'NVDAc')!.token.toLowerCase(),
    )!.offchain.dividends = [{ amount: 'not a number' }];
    const result = await readDividendCalendar(async () => new Response(json(answer)), new Date(fixture.capturedAt));
    assert.deepEqual(result.stocks.get('AMZNc'), []);
    assert.equal(result.stocks.has('MSFTc'), false);
    assert.equal(result.stocks.has('NVDAc'), false);
  });
  it('refuses a repeated page cursor rather than accepting a partial calendar', async () => {
    const body = structuredClone(fixture.calendarAnswers[0]) as { data: { tokenizedStocks: { pageInfo: { next: string | null } } } };
    body.data.tokenizedStocks.pageInfo.next = 'same-page';
    const fetcher = mock.fn(async () => new Response(json(body)));
    await assert.rejects(readDividendCalendar(fetcher, new Date(fixture.capturedAt)), /paging changed/);
    assert.equal(fetcher.mock.callCount(), 2);
  });
  it('a failed calendar never becomes a known empty one', async () => {
    const result = await createDividendCalendar({ fetch: async () => new Response('no', { status: 503 }) }).current();
    assert.equal(result, null);
  });
});

it('values new underlying shares with a raw-token oracle price, without double counting the multiplier', () => {
  assert.deepEqual(reinvestment(2n * 10n ** 18n, 3n * 10n ** 18n, 300n * 10n ** 8n, 8, '50'), {
    addedSharesPerShare: '0.5',
    reinvestedUsdPerShare: '50',
    ofDeclaredBps: 10000,
  });
});
