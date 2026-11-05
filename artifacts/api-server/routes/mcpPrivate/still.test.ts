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
import { STILL_PUBLIC_HOST_V1 } from '../../lib/stillOrigin.js';
import { STILL_MCP_IDENTITY_V1 } from '../mcpStill/server.js';

const WALLET = `0x${'1'.repeat(40)}` as const;
const OTHER = `0x${'2'.repeat(40)}` as const;
const NAME = 'miorail_get_my_still';

function report(partial = false, address = WALLET) {
  const read = snapshot(EXAMPLE);
  if (partial) read.morpho.get('cbBTC')!.price = reverted();
  return computeMirror({ universe: universe(), snapshot: read, calendar: calendar(),
    subject: { address, name: null, input: address }, assembledAt: new Date('2026-10-21T15:00:01.000Z') });
}

// The wallet's own USDC, read beside the Mirror at its own block.
const USDC = { raw: '2500000', decimals: 6, block: '53000001' };
const WALLET_USDC = { usdc: '2.5', atomic: '2500000', block: '53000001' };

function fixture(t: test.TestContext, answer: (input: string) => Promise<MirrorOutcome>,
  usdc: () => Promise<{ raw: string; decimals: number; block: string } | null> = async () => USDC) {
  const original = { ...stillMineRuntimeV1 }, asked: string[] = [];
  const service: MirrorService = {
    check: async input => { asked.push(input); return answer(input); },
    reading: async () => assert.fail('the MCP tool reads by check, never a reading'),
    earnings: async () => ({ ok: false }),
  };
  stillMineRuntimeV1.service = () => service;
  stillMineRuntimeV1.readUsdc = usdc;
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
  assert.equal(client.getServerVersion()?.version, '1.15.1');
  // Still's signed-in server: shown as Still, with Still's mark, like Still's own server.
  assert.deepEqual(client.getServerVersion(), { name: 'miorail-connected', version: '1.15.1', ...STILL_MCP_IDENTITY_V1 });
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

// A review link goes to Still's one address, miorail.xyz since 2026-11-03;
// the tools that hand one over name that same door.
test('every tool names the host Still’s review links use', async t => {
  fixture(t, async () => assert.fail('listing does not read the wallet'));
  const client = await connected(t);
  const words = (await client.listTools()).tools.map(entry => entry.description ?? '').join('\n');
  assert.ok(words.includes(`Get money opens on ${STILL_PUBLIC_HOST_V1},`));
  assert.ok(words.includes(`${STILL_PUBLIC_HOST_V1}/spend`));
  assert.equal(words.includes('stills.lat'), STILL_PUBLIC_HOST_V1 === 'stills.lat');
});

test('web and Connected read the same owner’s report with unchanged integers, provenance and cache flag', async t => {
  const outcome: MirrorOutcome = { outcome: 'report', report: report(), cached: true };
  const { app, asked } = fixture(t, async () => outcome);
  const web = await request(app).get('/api/still/mine').expect(200);
  const client = await connected(t);
  await client.listTools(); // The SDK validates the advertised structured output.
  const result = await client.callTool({ name: NAME, arguments: {} });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, { ...web.body, walletUsdc: WALLET_USDC });
  assert.deepEqual(result.structuredContent, { ...outcome, walletUsdc: WALLET_USDC });
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
  assert.deepEqual(result.structuredContent, { ...outcome, walletUsdc: WALLET_USDC });
});

// 2026-11-04: an assistant told the owner Still does not read their USDC, and could offer only a loan.
test('the wallet’s own USDC is read beside the Mirror at its own block, and one Base did not give is null, never zero', async t => {
  const outcome: MirrorOutcome = { outcome: 'report', report: report(), cached: false };
  let read: () => Promise<{ raw: string; decimals: number; block: string } | null> = async () => USDC;
  fixture(t, async () => outcome, () => read());
  const client = await connected(t);
  assert.match((await client.listTools()).tools.find(entry => entry.name === NAME)?.description ?? '', /walletUsdc.*null means Base did not answer, never zero/);
  for (const [usdc, expected] of [
    [async () => USDC, WALLET_USDC],
    [async () => ({ raw: '0', decimals: 6, block: '53000002' }), { usdc: '0', atomic: '0', block: '53000002' }],
    [async () => null, null],
    [async () => { throw new Error('rpc down'); }, null],
    [async () => ({ raw: '1', decimals: 18, block: '53000002' }), null],
  ] as const) {
    read = usdc;
    const result = await client.callTool({ name: NAME, arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual((result.structuredContent as { walletUsdc?: unknown }).walletUsdc, expected);
  }
});

test('a chain failure stays its own outcome through the real transport and never becomes a report', async t => {
  const outcome: MirrorOutcome = { outcome: 'chain_unavailable', attempts: [{ provider: 'base-public', kind: 'throttled' }] };
  const { app } = fixture(t, async () => outcome);
  const web = await request(app).get('/api/still/mine').expect(503);
  const client = await connected(t);
  await client.listTools();
  const result = await client.callTool({ name: NAME, arguments: {} });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, { ...web.body, walletUsdc: WALLET_USDC });
  assert.deepEqual(result.structuredContent, { ...outcome, walletUsdc: WALLET_USDC });
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
