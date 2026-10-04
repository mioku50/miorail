import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { InMemoryReopenGameRepositoryV1 } from '@mioagent/route-storage';
import {
  etInstantV1,
  weekendMarketV1,
  type WeekendMarketRunV1,
  type WeekendMarketStockInputV1,
} from '@mioagent/rwa-market-reality/weekend-market';

import { createMiorailMcpServerV1 } from '../mcp/server.js';
import { createPublicReadCacheV1 } from '../publicStocks.js';
import { reopenGameCachesV1, reopenGameRuntime } from '../reopenGame.js';
import { createMiorailPrivateMcpServerV1 } from './server.js';

// ---------------------------------------------------------------------------
// Call the reopen on the protocol: the public read, and the connected read and
// pick for the one wallet a grant names.
// ---------------------------------------------------------------------------

const et = (localDate: string, clock: string): Date => {
  const [hour, minute] = clock.split(':').map(Number);
  return etInstantV1(localDate, hour! * 60 + minute!);
};

function hourly(fromDate: string, fromClock: string, hours: number, mid: number, reference: number, referenceUpdatedAt: string): WeekendMarketRunV1[] {
  const start = et(fromDate, fromClock).getTime();
  return Array.from({ length: hours }, (_, index) => ({
    at: new Date(start + index * 3_600_000).toISOString(),
    mid,
    reference,
    referenceUpdatedAt,
  }));
}

// MSTR's feed had no close this weekend: the round asks about four stocks.
const STOCKS: WeekendMarketStockInputV1[] = ['NVDA', 'TSLA', 'AAPL', 'AMZN'].map((symbol, index) => ({
  tokenAddress: `0xb2${String(index + 1).padStart(38, '0')}`,
  symbol,
  name: `${symbol} Inc.`,
  runs: [
    ...hourly('2026-10-09', '14:05', 2, 100.05, 100, et('2026-10-09', '15:59').toISOString()),
    ...hourly('2026-10-10', '10:05', 30, 101, 100, et('2026-10-09', '15:59').toISOString()),
  ],
}));

const WALLET = '0x4444444444444444444444444444444444444444' as const;

function stubV1(t: test.TestContext, now: Date) {
  const saved = { ...reopenGameRuntime };
  const savedCache = reopenGameCachesV1.shared;
  const repository = new InMemoryReopenGameRepositoryV1();
  let clock = now;
  Object.assign(reopenGameRuntime, {
    repository: () => repository,
    stocks: async () => STOCKS,
    weekend: async (at: Date) => weekendMarketV1({ now: at, stocks: STOCKS }),
    names: async () => new Map(),
    basename: async () => null,
    storageAvailable: async () => true,
    enabled: () => true,
    now: () => clock,
  });
  reopenGameCachesV1.shared = createPublicReadCacheV1({ ttlMs: 30_000, max: 4 });
  t.after(() => {
    Object.assign(reopenGameRuntime, saved);
    reopenGameCachesV1.shared = savedCache;
  });
  return {
    repository,
    setNow: (next: Date) => {
      clock = next;
    },
  };
}

async function clientOf(server: { connect: (transport: never) => Promise<void> }): Promise<Client> {
  const client = new Client({ name: 'reopen-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b as never)]);
  return client;
}

const connectedV1 = () =>
  clientOf(
    createMiorailPrivateMcpServerV1({
      tenantId: `eip155:8453:${WALLET}`,
      walletAddress: WALLET,
      chainId: 8453,
      tokenId: 'test-grant',
      source: 'oauth',
    }),
  );

/** What these tests read of an answer. */
type AnswerV1 = {
  round: { state: string; stocks: { symbol: string }[] };
  me?: { picks: Record<string, string> };
  closeDay: string | null;
  miorailSummary: string;
};
type ToolResult = { isError?: boolean; structuredContent?: AnswerV1; content?: { text?: string }[] };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

describe('Call the reopen on the protocol', () => {
  test('the public read is the round with nobody in it, and takes no argument', async (t) => {
    stubV1(t, et('2026-10-10', '12:00'));
    const client = await clientOf(createMiorailMcpServerV1());
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'get_reopen_round')!;
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), []);
    const result = await call(client, 'get_reopen_round');
    assert.equal(result.isError, undefined);
    const answer = result.structuredContent!;
    assert.equal(answer.round.state, 'open');
    assert.deepEqual(answer.round.stocks.map((stock) => stock.symbol), ['NVDA', 'TSLA', 'AAPL', 'AMZN']);
    assert.equal('me' in answer, false);
    assert.equal(answer.closeDay, 'Friday');
    assert.match(answer.miorailSummary, /^Round #1 is open/);
    await client.close();
  });

  test('a connected pick names stocks one by one; a stock not named keeps its pick', async (t) => {
    const { repository } = stubV1(t, et('2026-10-10', '12:00'));
    const client = await connectedV1();
    const first = await call(client, 'miorail_call_the_reopen', { NVDA: 'above', TSLA: 'below' });
    assert.equal(first.isError, undefined, JSON.stringify(first.content));
    assert.deepEqual(first.structuredContent!.me?.picks, { NVDA: 'up', TSLA: 'down' });
    // "Change TSLA" leaves NVDA alone.
    const second = await call(client, 'miorail_call_the_reopen', { TSLA: 'above' });
    assert.deepEqual(second.structuredContent!.me?.picks, { NVDA: 'up', TSLA: 'up' });
    assert.match(second.structuredContent!.miorailSummary, /^This wallet's picks in round #1: NVDA above and TSLA above\./);
    // The same picks the page reads, under the wallet's own player.
    assert.deepEqual(
      (await repository.picksOf(`w:${WALLET}`)).map((row) => row.picks),
      [{ NVDA: 'up', TSLA: 'up' }],
    );
    const mine = await call(client, 'miorail_get_my_reopen');
    assert.deepEqual(mine.structuredContent!.me?.picks, { NVDA: 'up', TSLA: 'up' });
    await client.close();
  });

  test('nothing named, a stock not in the round, or a side that is not one: nothing changes', async (t) => {
    const { repository } = stubV1(t, et('2026-10-10', '12:00'));
    const client = await connectedV1();
    const none = await call(client, 'miorail_call_the_reopen', {});
    assert.equal(none.isError, true);
    assert.match(none.content?.[0]?.text ?? '', /^no_pick_named: .*Nothing was changed\.$/);
    const absent = await call(client, 'miorail_call_the_reopen', { MSTR: 'above' });
    assert.match(absent.content?.[0]?.text ?? '', /^stock_not_in_round: MSTR is not in round #1/);
    const wrong = await call(client, 'miorail_call_the_reopen', { NVDA: 'up' });
    assert.equal(wrong.isError, true);
    assert.deepEqual(await repository.picksOf(`w:${WALLET}`), []);
    await client.close();
  });

  test('after the lock the pick is refused with the next round’s opening, and a read still works', async (t) => {
    const { setNow } = stubV1(t, et('2026-10-10', '12:00'));
    const client = await connectedV1();
    await call(client, 'miorail_call_the_reopen', { NVDA: 'below' });
    setNow(et('2026-10-11', '17:00'));
    const late = await call(client, 'miorail_call_the_reopen', { NVDA: 'above' });
    assert.equal(late.isError, true);
    assert.match(
      late.content?.[0]?.text ?? '',
      /^round_locked: Picks for round #1 closed Sun 17:00 ET\. Round #2 opens Fri 20:00 ET \(2026-10-17T00:00:00\.000Z\)\. Nothing was changed\.$/,
    );
    const mine = await call(client, 'miorail_get_my_reopen');
    assert.deepEqual(mine.structuredContent!.me?.picks, { NVDA: 'down' }, 'the pick from before the lock stands');
    await client.close();
  });

  test('a wallet that never played reads as no picks, and reading makes it no player', async (t) => {
    const { repository } = stubV1(t, et('2026-10-10', '12:00'));
    const client = await connectedV1();
    const mine = await call(client, 'miorail_get_my_reopen');
    assert.deepEqual(mine.structuredContent!.me?.picks, {});
    assert.match(mine.structuredContent!.miorailSummary, /^This wallet has no picks in round #1\./);
    assert.equal((await repository.roundPicks('2026-10-09')).length, 0);
    await client.close();
  });
});
