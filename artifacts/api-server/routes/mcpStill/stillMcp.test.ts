import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BitrefillGuestCatalogV1, SpendProductV1 } from '@mioagent/commerce-engine';
import { computeMirror, type MirrorInput, type MirrorService } from '@mioagent/still-engine';
import { InMemoryRateLimiter } from '@mioagent/utils';

import { EXAMPLE, calendar, snapshot, universe } from '../../../../lib/still-engine/test/fixtures.js';
import { publicStillRuntimeV1, resetStillCardCachesV1 } from '../stillPublic.js';
import { STILL_MCP_TOOLS_V1, STILL_MCP_VERSION_V1, createStillMcpServerV1 } from './server.js';
import { stillMcpRouter, stillMcpRuntimeV1 } from './index.js';
import { STILL_PUBLIC_HOST_V1 } from '../../lib/stillOrigin.js';

const WALLET = `0x${'1'.repeat(40)}` as const;
const here = __dirname;

function mirrorInput(): MirrorInput {
  return { universe: universe(), snapshot: snapshot(EXAMPLE), calendar: calendar(),
    subject: { address: WALLET, name: null, input: WALLET }, assembledAt: new Date('2026-10-21T15:00:01.000Z') };
}

function fixture(t: test.TestContext, over: Partial<MirrorService> = {}) {
  const original = { ...publicStillRuntimeV1 };
  const asked: string[] = [];
  const service: MirrorService = {
    check: async (raw) => {
      asked.push(raw);
      return { outcome: 'report', report: computeMirror(mirrorInput()), cached: false };
    },
    reading: async () => {
      const input = mirrorInput();
      return { outcome: 'report', report: computeMirror(input), input, cached: false };
    },
    earnings: async () => calendar(),
    ...over,
  };
  publicStillRuntimeV1.service = () => service;
  t.after(() => Object.assign(publicStillRuntimeV1, original));
  return { asked };
}

async function connected(t: test.TestContext) {
  const client = new Client({ name: 'still-mcp-test', version: '1' });
  const server = createStillMcpServerV1();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  t.after(() => client.close());
  return client;
}

// GHSA-46jr-4wx8-v453: a call carrying a vast argument payload is refused before
// any schema walks it, on this server and on the two others that share the cap.
test('a tool call with more than the capped number of argument elements is refused before it is validated', async (t) => {
  const client = await connected(t);
  const result = await client.callTool({ name: 'get_still_terms', arguments: { junk: Array.from({ length: 2_000 }, () => 0) } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /more than the maximum of 1000 elements/);
  const repo = (relative: string) => process.cwd().endsWith(`${path.sep}artifacts${path.sep}api-server`) ? path.join(process.cwd(), '../..', relative) : path.join(process.cwd(), relative);
  for (const file of ['routes/mcp/server.ts', 'routes/mcpPrivate/server.ts', 'routes/mcpStill/server.ts']) {
    assert.match(readFileSync(repo(`artifacts/api-server/${file}`), 'utf8'), /new McpServer\([\s\S]{0,200}maxToolInputElements: MCP_TOOL_INPUT_ELEMENTS_V1/, file);
  }
});

const structured = (result: unknown) => (result as { structuredContent: Record<string, unknown> }).structuredContent;

test('five tools under Still’s own name, every one a read, and instructions that say what it cannot do', async (t) => {
  fixture(t, { check: async () => assert.fail('listing reads no wallet') });
  const client = await connected(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...STILL_MCP_TOOLS_V1].sort());
  assert.deepEqual(client.getServerVersion(), { name: 'still', version: STILL_MCP_VERSION_V1 });
  for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
  const instructions = client.getInstructions() ?? '';
  assert.match(instructions, /Still is not a lender/);
  assert.match(instructions, /This server only reads: it prepares, signs and sends nothing/);
  assert.match(instructions, /null means unread, never zero/);
  assert.match(instructions, /Not offered to US persons/);
  assert.match(instructions, /miorail_prepare_still_purchase opens the invoice they chose/);
});

// Still's links go to its one address, miorail.xyz since 2026-11-03. What this
// server tells an assistant names that same door, not the one that only leads
// there.
test('the instructions and every tool name the host Still’s links use', async (t) => {
  fixture(t, { check: async () => assert.fail('listing reads no wallet') });
  const client = await connected(t);
  const { tools } = await client.listTools();
  const words = [client.getInstructions() ?? '', ...tools.map((tool) => tool.description ?? '')].join('\n');
  assert.ok(words.includes(`${STILL_PUBLIC_HOST_V1}/w/<wallet>`));
  assert.ok(words.includes(`${STILL_PUBLIC_HOST_V1}/spend`));
  assert.equal(words.includes('stills.lat'), STILL_PUBLIC_HOST_V1 === 'stills.lat');
});

// Bitrefill's answers below are synthetic, in the guest client's own shapes.
const ESIM: SpendProductV1 = { id: 'bitrefill-esim-japan', name: 'Bitrefill eSIM Japan', country: 'JP', inStock: true, recipientType: 'mixed', url: null,
  packages: [{ value: '5GB, 30 Days', faceCurrency: 'USD', priceUsdc: '9.80' }, { value: 'Unlimited, 30 Days', faceCurrency: 'USD', priceUsdc: '120.00' }] };
const TOP_UP: SpendProductV1 = { id: 'airtel-india', name: 'Airtel India', country: 'IN', inStock: true, recipientType: 'phone_number', url: null,
  packages: [{ value: '10', faceCurrency: 'INR', priceUsdc: '0.11' }] };

function catalogue(t: test.TestContext, catalog: Partial<BitrefillGuestCatalogV1>, pay = true) {
  const original = { ...publicStillRuntimeV1 }, env = process.env.STILL_SPEND_PAY_V1;
  const asked: unknown[] = [];
  publicStillRuntimeV1.spend = () => ({
    search: async (input) => { asked.push(input); return { ok: true, value: [] }; },
    product: async (id) => { asked.push(id); return { ok: false, reason: 'bitrefill_product_not_found' }; },
    ...catalog,
  });
  process.env.STILL_SPEND_PAY_V1 = pay ? 'on' : 'off';
  resetStillCardCachesV1();
  t.after(() => {
    Object.assign(publicStillRuntimeV1, original);
    if (env === undefined) delete process.env.STILL_SPEND_PAY_V1; else process.env.STILL_SPEND_PAY_V1 = env;
    resetStillCardCachesV1();
  });
  return { asked };
}

test('what a loan could pay for is the Spend page’s own catalogue read, and one product’s prices are against Still’s cap', async (t) => {
  const { asked } = catalogue(t, {
    search: async (input) => {
      asked.push(input);
      return { ok: true, value: [{ id: ESIM.id, name: ESIM.name, countries: ['JP'], inStock: true }] };
    },
    product: async (id) => ({ ok: true, value: id === TOP_UP.id ? TOP_UP : ESIM }),
  });
  const client = await connected(t);
  const found = structured(await client.callTool({ name: 'still_find_spend', arguments: { type: 'esim', country: 'jp' } }));
  assert.equal(found.outcome, 'products');
  assert.equal(found.country, 'JP');
  assert.deepEqual(found.products, [{ id: ESIM.id, name: ESIM.name, countries: ['JP'], inStock: true }]);
  assert.deepEqual(found.checkout, { enabled: true });
  // The page and the assistant read the same cached search: the second asks Bitrefill nothing.
  await client.callTool({ name: 'still_find_spend', arguments: { type: 'esim', country: 'JP' } });
  assert.deepEqual(asked, [{ type: 'esim', country: 'JP', query: undefined }]);

  const product = structured(await client.callTool({ name: 'still_spend_product', arguments: { productId: ESIM.id } }));
  assert.equal(product.outcome, 'product');
  assert.deepEqual((product.product as { packages: unknown[] }).packages, [
    { value: '5GB, 30 Days', faceCurrency: 'USD', priceUsdc: '9.80', withinCap: true },
    { value: 'Unlimited, 30 Days', faceCurrency: 'USD', priceUsdc: '120.00', withinCap: false },
  ]);
  assert.deepEqual(product.checkout, { enabled: true, available: true, capUsdc: '100', phone: null });
  const topUp = structured(await client.callTool({ name: 'still_spend_product', arguments: { productId: TOP_UP.id } }));
  assert.deepEqual((topUp.checkout as { phone: unknown }).phone, { callingCode: '91', prefixes: ['91'] });
});

test('an embargoed country is refused, and Bitrefill’s failure is never an empty catalogue', async (t) => {
  catalogue(t, {
    search: async () => ({ ok: false, reason: 'bitrefill_unreachable' }),
    product: async () => ({ ok: false, reason: 'bitrefill_rate_limited' }),
  }, false);
  const client = await connected(t);
  const embargoed = await client.callTool({ name: 'still_find_spend', arguments: { type: 'giftcard', country: 'IR' } });
  assert.equal((embargoed as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(embargoed), /still_spend_country_not_offered/);
  const failed = structured(await client.callTool({ name: 'still_find_spend', arguments: { type: 'giftcard', country: 'DE', query: 'Amazon' } }));
  assert.deepEqual(failed, { outcome: 'unavailable', type: 'giftcard', country: 'DE', query: 'Amazon', reason: 'bitrefill_unreachable', checkout: { enabled: false } });
  const unread = structured(await client.callTool({ name: 'still_spend_product', arguments: { productId: ESIM.id } }));
  assert.deepEqual(unread, { outcome: 'unavailable', reason: 'bitrefill_rate_limited' });
});

test('a wallet check is the page’s own check, through the same service', async (t) => {
  const { asked } = fixture(t);
  const client = await connected(t);
  const answer = structured(await client.callTool({ name: 'still_check_wallet', arguments: { wallet: 'example.base.eth' } }));
  assert.equal(answer.outcome, 'report');
  const report = answer.report as { headline: { availableCents: string | null }; venues: Array<{ venue: string }> };
  assert.match(report.headline.availableCents ?? '', /^\d+$/);
  assert.ok(report.venues.some((venue) => venue.venue === 'aave-v4'));
  assert.deepEqual(asked, ['example.base.eth']);
});

test('a name nobody holds is an outcome, and a failed read is our failure, never an empty wallet', async (t) => {
  fixture(t, { check: async (raw) => ({ outcome: 'name_not_found', input: raw, name: raw }) });
  const client = await connected(t);
  const missing = structured(await client.callTool({ name: 'still_check_wallet', arguments: { wallet: 'nobody.base.eth' } }));
  assert.deepEqual(missing, { outcome: 'name_not_found', input: 'nobody.base.eth', name: 'nobody.base.eth' });

  publicStillRuntimeV1.service = () => ({
    check: async () => { throw new Error('rpc https://secret.example/key'); },
    reading: async () => assert.fail('a failed check reads nothing more'),
    earnings: async () => calendar(),
  });
  const failed = await client.callTool({ name: 'still_check_wallet', arguments: { wallet: WALLET } });
  assert.equal((failed as { isError?: boolean }).isError, true);
  const text = JSON.stringify(failed);
  assert.match(text, /still_mirror_unavailable: .*our failure and says nothing about the wallet/);
  assert.doesNotMatch(text, /secret\.example/);
});

test('a what-if is the Agent’s own answer, with the figures before and after', async (t) => {
  fixture(t);
  const client = await connected(t);
  const answer = structured(await client.callTool({
    name: 'still_what_if',
    arguments: { wallet: WALLET, changes: [{ kind: 'price', asset: 'NVDAc', changePercent: -30 }] },
  }));
  assert.equal(answer.outcome, 'answer');
  assert.deepEqual(answer.subject, { address: WALLET, name: null });
  const words = answer.answer as { text: string; steps: string[]; bounds: string[] };
  assert.match(words.text, /NVIDIA/);
  assert.ok(words.steps.length > 0 && words.bounds.length > 0);
  type Side = { loans: Array<{ venue: string; marginBps: number | null }> };
  const before = (answer.before as Side).loans.find((loan) => loan.venue === 'aave-v4')!;
  const after = (answer.after as Side).loans.find((loan) => loan.venue === 'aave-v4')!;
  assert.ok(after.marginBps! < before.marginBps!, 'a fall in the collateral leaves less margin');
});

test('a change the engine cannot carry is refused with its reason, and a malformed one never reaches it', async (t) => {
  fixture(t);
  const client = await connected(t);
  const noDebt = structured(await client.callTool({
    name: 'still_what_if',
    arguments: { wallet: WALLET, changes: [{ kind: 'repay', loan: 'morpho:ETH', usdc: '10' }] },
  }));
  assert.deepEqual([noDebt.outcome, noDebt.reason], ['refused', 'no_debt']);
  assert.ok(typeof (noDebt.answer as { text: string }).text === 'string');

  const tooFine = await client.callTool({
    name: 'still_what_if',
    arguments: { wallet: WALLET, changes: [{ kind: 'deposit', asset: 'NVDAc', amount: '0.000000001', source: 'wallet' }] },
  });
  assert.equal((tooFine as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(tooFine), /still_change_invalid: A deposit is an amount above zero with at most 8 decimals/);

  // A fall of everything is outside one question: the schema refuses it before any read.
  const wholeFall = await client.callTool({
    name: 'still_what_if',
    arguments: { wallet: WALLET, changes: [{ kind: 'price', asset: 'NVDAc', changePercent: -100 }] },
  }).catch(() => ({ isError: true }));
  assert.equal((wholeFall as { isError?: boolean }).isError, true);
});

test('the endpoint refuses GET, and its limit is per client', async (t) => {
  const original = stillMcpRuntimeV1.limiter;
  stillMcpRuntimeV1.limiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 1 });
  t.after(() => { stillMcpRuntimeV1.limiter = original; });
  const app = express();
  app.use(express.json());
  app.use('/mcp/still', stillMcpRouter);
  await request(app).get('/mcp/still').expect(405);
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const first = await request(app).post('/mcp/still').set('Accept', 'application/json, text/event-stream').send(ping);
  assert.notEqual(first.status, 429);
  const second = await request(app).post('/mcp/still').set('Accept', 'application/json, text/event-stream').send(ping);
  assert.equal(second.status, 429);
});

test('nothing here can sign, send, pay or hold a key', () => {
  const sources = readdirSync(here).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  assert.deepEqual(sources.sort(), ['index.ts', 'server.ts', 'tools.ts']);
  for (const name of sources) {
    const code = readFileSync(path.join(here, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const banned of ['privateKey', 'signTransaction', 'sendCalls', 'eth_sendRawTransaction', 'x402', 'issueLendingDraft']) {
      assert.ok(!code.includes(banned), `${name} reaches ${banned}`);
    }
  }
});

test('the deploy asserts this registry and version, so the two cannot drift apart', () => {
  const deploy = readFileSync(path.join(here, '../../../../ops/deploy.sh'), 'utf8');
  const list = /\.result\.tools \| map\(\.name\) \| sort == (\[[^\]]+\])' >\/dev\/null \\\n\s+\|\| \{ echo 'FAILED: Still MCP/.exec(deploy);
  assert.ok(list, 'deploy.sh checks the Still MCP tool list');
  assert.deepEqual(JSON.parse(list[1]!), [...STILL_MCP_TOOLS_V1].sort());
  assert.match(deploy, new RegExp(`serverInfo\\.name == "still" and \\.result\\.serverInfo\\.version == "${STILL_MCP_VERSION_V1.replaceAll('.', '\\.')}"`));
});
