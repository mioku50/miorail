import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import express from 'express';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createEarningsCalendar, STOCKS, StillTermsSchema, type CalendarRead, type MirrorService } from '@mioagent/still-engine';
import { InMemoryRateLimiter } from '@mioagent/utils';

import { publicStillRouter, publicStillRuntimeV1 } from '../stillPublic.js';
import { createMiorailMcpServerV1 } from './server.js';

const saved = { ...publicStillRuntimeV1 };
afterEach(() => Object.assign(publicStillRuntimeV1, saved));
const NOW = new Date('2026-11-26T16:00:00.000Z'); // Thanksgiving, 11:00 New York

function wire(earnings: MirrorService['earnings']) {
  const service: MirrorService = { check: async () => assert.fail('terms must not read a wallet'), earnings };
  publicStillRuntimeV1.service = () => service;
  publicStillRuntimeV1.now = () => NOW;
  publicStillRuntimeV1.limiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 30 });
  const app = express();
  app.use('/api/public/still', publicStillRouter);
  return app;
}

async function connected(t: test.TestContext) {
  const client = new Client({ name: 'still-terms-test', version: '1' });
  const server = createMiorailMcpServerV1();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('MCP and HTTP return identical terms from one cached calendar, including the holiday window', async t => {
  const fetchFn = mock.fn<typeof fetch>(async () => Response.json({ data: { tokenizedStocks: {
    items: STOCKS.map(stock => ({ chainId: 8453, address: stock.token,
      offchain: { nextEarningsReport: null, earnings: [] } })), pageInfo: { next: null },
  } } }));
  const calendar = createEarningsCalendar({ fetch: fetchFn, now: () => NOW });
  const app = wire(() => calendar.current());
  const client = await connected(t);
  const tool = (await client.listTools()).tools.find(tool => tool.name === 'get_still_terms')!;
  assert.equal(client.getServerVersion()?.version, '1.8.0');
  assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), []);
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.ok(tool.outputSchema);
  assert.match(tool.description!, /50%.*40%.*calendar.*unread/);
  assert.match(tool.description!, /not.*recommendation to borrow/);

  const result = await client.callTool({ name: 'get_still_terms', arguments: {} });
  assert.notEqual(result.isError, true);
  const mcp = StillTermsSchema.parse(result.structuredContent);
  const http = await request(app).get('/api/public/still/terms').expect(200);
  assert.deepEqual(mcp, http.body);
  assert.deepEqual(JSON.parse((result.content as { text: string }[])[0]!.text), mcp);
  assert.equal(fetchFn.mock.callCount(), 1, 'two doors must share the same cached calendar');
  assert.equal(mcp.termsVersion, '2026-10-26');
  assert.equal(mcp.sharePercentOfProtocol, 50);
  assert.equal(mcp.weekend.activeNow, true);
  assert.equal(mcp.weekend.stockSharePercentOfProtocol, 40);
  assert.equal(mcp.weekend.startsAt, '2026-11-26T01:00:00.000Z');
  assert.equal(mcp.weekend.endsAt, '2026-11-27T01:00:00.000Z');
  assert.equal(mcp.earnings.stocks.length, 7);
  assert.ok(mcp.earnings.stocks.every(stock => stock.calendarRead && !stock.countsAtEarningsRateNow));
  assert.deepEqual(mcp.assets.filter(asset => asset.id === 'cbBTC' || asset.id === 'ETH').map(asset => asset.id), ['cbBTC', 'ETH']);
  assert.equal(mcp.notOfferedTo, 'US persons');
});

test('an unread earnings calendar remains a conservative valid answer, while read-empty is separate', async t => {
  let calendar: CalendarRead = { ok: false };
  wire(async () => calendar);
  const client = await connected(t);
  const read = async () => {
    const result = await client.callTool({ name: 'get_still_terms', arguments: {} });
    assert.notEqual(result.isError, true);
    return StillTermsSchema.parse(result.structuredContent);
  };
  const unread = await read();
  assert.equal(unread.earnings.calendarReadAt, null);
  assert.equal(unread.earnings.stocks.length, 7);
  assert.ok(unread.earnings.stocks.every(stock => !stock.calendarRead && stock.countsAtEarningsRateNow));
  calendar = { ok: true, calendar: { readAt: NOW, dates: new Map([['NVDAc', ['2026-11-26']], ['TSLAc', []]]) } };
  const partial = await read();
  assert.equal(partial.earnings.stocks.find(stock => stock.id === 'NVDAc')!.countsAtEarningsRateNow, true);
  assert.equal(partial.earnings.stocks.find(stock => stock.id === 'TSLAc')!.countsAtEarningsRateNow, false);
  assert.equal(partial.earnings.stocks.find(stock => stock.id === 'TSLAc')!.calendarRead, true);
  assert.equal(partial.earnings.stocks.find(stock => stock.id === 'AAPLc')!.calendarRead, false);
});

test('a wallet override is refused before any calendar or wallet read', async t => {
  wire(async () => assert.fail('invalid arguments must not reach the service'));
  const client = await connected(t);
  const result = await client.callTool({ name: 'get_still_terms', arguments: { wallet: `0x${'1'.repeat(40)}` } });
  assert.equal(result.isError, true);
});

test('unexpected calendar failures expose a fixed refusal, never provider details or a false limit', async t => {
  wire(async () => { throw new Error('https://provider.invalid/private?api_key=do-not-print'); });
  const client = await connected(t);
  const result = await client.callTool({ name: 'get_still_terms', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  const text = JSON.stringify(result.content);
  assert.match(text, /still_terms_unavailable/);
  assert.doesNotMatch(text, /provider\.invalid|do-not-print|api_key|sharePercentOfProtocol/);
});
