import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { computeMirror, type MirrorOutcome, type MirrorService } from '@mioagent/still-engine';

import { EXAMPLE, calendar, reverted, snapshot, universe } from '../../../../lib/still-engine/test/fixtures.js';
import { stillMineRouter, stillMineRuntimeV1 } from '../stillMine.js';
import { createMiorailPrivateMcpServerV1 } from './server.js';
import { MiorailGetMyStillResultV1Schema } from './outputs.js';

const WALLET = `0x${'1'.repeat(40)}` as const;
const OTHER = `0x${'2'.repeat(40)}` as const;
const NAME = 'miorail_get_my_still';

function report(partial = false, address = WALLET) {
  const read = snapshot(EXAMPLE);
  if (partial) read.morpho.get('cbBTC')!.price = reverted();
  return computeMirror({ universe: universe(), snapshot: read, calendar: calendar(),
    subject: { address, name: null, input: address }, assembledAt: new Date('2026-10-21T15:00:01.000Z') });
}

function fixture(t: test.TestContext, answer: (input: string) => Promise<MirrorOutcome>) {
  const original = { ...stillMineRuntimeV1 }, asked: string[] = [];
  const service: MirrorService = {
    check: async input => { asked.push(input); return answer(input); },
    reading: async () => assert.fail('the MCP tool reads by check, never a reading'),
    earnings: async () => ({ ok: false }),
  };
  stillMineRuntimeV1.service = () => service;
  t.after(() => Object.assign(stillMineRuntimeV1, original));
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { session: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } } });
    next();
  });
  app.use('/api/still', stillMineRouter);
  return { app, asked };
}

async function connected(t: test.TestContext) {
  const client = new Client({ name: 'still-protocol-test', version: '1' });
  const server = createMiorailPrivateMcpServerV1({ tenantId: `eip155:8453:${WALLET}`,
    walletAddress: WALLET, chainId: 8453, tokenId: 'test-grant', source: 'oauth' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  t.after(() => client.close());
  return client;
}

test('the protocol advertises the wallet-free read, the source block and partial-total meaning', async t => {
  fixture(t, async () => assert.fail('listing does not read the wallet'));
  const client = await connected(t);
  const tool = (await client.listTools()).tools.find(entry => entry.name === NAME)!;
  assert.ok(tool);
  assert.equal(client.getServerVersion()?.version, '1.8.1');
  assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), []);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.equal(tool.annotations?.destructiveHint, false);
  assert.match(tool.description ?? '', /headline\.complete.*false.*at least/);
  assert.match(tool.description ?? '', /chain_unavailable.*our read failure/);
  assert.match(tool.description ?? '', /reading\.block/);
  assert.ok(tool.outputSchema?.properties?.report);
  assert.doesNotMatch(JSON.stringify(tool.outputSchema), /approvalCalldata|transactionRequest|signedTransaction/);
});

test('web and Connected read the same owner’s report with unchanged integers, provenance and cache flag', async t => {
  const outcome: MirrorOutcome = { outcome: 'report', report: report(), cached: true };
  const { app, asked } = fixture(t, async () => outcome);
  const web = await request(app).get('/api/still/mine').expect(200);
  const client = await connected(t);
  await client.listTools(); // The SDK validates the advertised structured output.
  const result = await client.callTool({ name: NAME, arguments: {} });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, web.body);
  assert.deepEqual(result.structuredContent, outcome);
  assert.deepEqual(asked, [WALLET, WALLET]);
  assert.equal(outcome.report.reading.block, '53000000');
  assert.equal(outcome.report.subject.address, WALLET);
});

test('an incomplete Mirror remains a lower bound with unknown asset values, not zeroes', async t => {
  const value = report(true);
  assert.equal(value.headline.complete, false);
  assert.notEqual(value.headline.availableCents, null);
  assert.equal(value.assets.find(asset => asset.asset === 'cbBTC')!.valueCents, null);
  assert.ok(value.coverage.failed.length > 0);
  const outcome: MirrorOutcome = { outcome: 'report', report: value, cached: false };
  fixture(t, async () => outcome);
  const client = await connected(t);
  await client.listTools();
  const result = await client.callTool({ name: NAME, arguments: {} });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, outcome);
});

test('a chain failure stays its own outcome through the real transport and never becomes a report', async t => {
  const outcome: MirrorOutcome = { outcome: 'chain_unavailable', attempts: [{ provider: 'base-public', kind: 'throttled' }] };
  const { app } = fixture(t, async () => outcome);
  const web = await request(app).get('/api/still/mine').expect(503);
  const client = await connected(t);
  await client.listTools();
  const result = await client.callTool({ name: NAME, arguments: {} });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, web.body);
  assert.deepEqual(result.structuredContent, outcome);
  assert.equal('report' in (result.structuredContent ?? {}), false);
});

test('foreign wallet, subject, owner and tenant arguments are refused before any read', async t => {
  const { asked } = fixture(t, async () => assert.fail('no subject override may reach the service'));
  const client = await connected(t);
  for (const args of [{ wallet: OTHER }, { walletAddress: OTHER }, { subject: OTHER }, { owner: OTHER }, { tenantId: 'other-tenant' }]) {
    const result = await client.callTool({ name: NAME, arguments: args });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
  }
  assert.deepEqual(asked, []);
});

test('foreign reports, malformed service outcomes and thrown provider details are safely refused', async t => {
  let answer: () => Promise<MirrorOutcome> = async () => ({ outcome: 'report', report: report(false, OTHER), cached: false });
  fixture(t, async () => answer());
  const client = await connected(t);
  await client.listTools();
  const cases: Array<() => Promise<MirrorOutcome>> = [
    answer,
    async () => ({ outcome: 'report', report: report() }) as unknown as MirrorOutcome,
    async () => ({ outcome: 'invalid_subject', input: WALLET, reason: 'bad_checksum' }),
    async () => ({ outcome: 'chain_unavailable', attempts: [{ provider: 'https://rpc.invalid/secret-test-key', kind: 'unavailable' }] }),
    async () => { throw new Error('https://rpc.invalid/secret-test-key unavailable'); },
  ];
  for (const next of cases) {
    answer = next;
    const result = await client.callTool({ name: NAME, arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    const text = JSON.stringify(result.content);
    assert.match(text, /still_mirror_unavailable/);
    assert.doesNotMatch(text, /rpc\.invalid|secret-test-key|0x222/);
  }
  assert.equal(MiorailGetMyStillResultV1Schema.safeParse({ outcome: 'report', report: report() }).success, false);
  assert.equal(MiorailGetMyStillResultV1Schema.safeParse({ outcome: 'chain_unavailable', attempts: [], report: report() }).success, false);
});
