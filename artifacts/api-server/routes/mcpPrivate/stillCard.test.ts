import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import request from 'supertest';

import { mcpPrivateAuthRuntime } from './session.js';
import { mcpPrivateAppsRuntimeV1, mcpPrivateRouter } from './index.js';
import { STILL_CARD_MIME_V1, STILL_CARD_URI_V1, drawsStillCardV1, resetStillCardHtmlV1, stillCardRuntimeV1 } from './stillCard.js';

// Still's review card (MCP Apps) through the real endpoint: a client that says
// it draws apps gets the card on Still's tools; one that does not gets the same
// tools as text, and no card it could not draw. Every wallet here is synthetic.
const WALLET = `0x${'1'.repeat(40)}`, OTHER = `0x${'2'.repeat(40)}`;
const DRAWS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [STILL_CARD_MIME_V1] } } };
const STILL_TOOLS = ['miorail_prepare_still_loan', 'miorail_prepare_still_purchase', 'miorail_prepare_still_wallet_purchase', 'miorail_prepare_still_repay', 'miorail_get_still_review_status'];

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    const wallet = req.get('x-test-wallet') ?? WALLET;
    Object.defineProperty(req, 'session', { value: { user: { id: `eip155:8453:${wallet}`, address: wallet, chainId: 8453 } } });
    next();
  });
  a.use('/mcp/private', mcpPrivateRouter);
  return a;
}

async function rpc(server: ReturnType<typeof app>, wallet: string, method: string, params: Record<string, unknown> = {}) {
  const response = await request(server).post('/mcp/private').set('Accept', 'application/json, text/event-stream').set('x-test-wallet', wallet)
    .send({ jsonrpc: '2.0', id: 1, method, params });
  assert.equal(response.status, 200, `${method} answered ${response.status}`);
  const line = String(response.text).split('\n').find((row) => row.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : response.text) as { result?: Record<string, unknown>; error?: { message: string } };
}

const initialize = (capabilities: Record<string, unknown>) => ({ protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'card-test', version: '1' } });

test.beforeEach(() => mcpPrivateAppsRuntimeV1.grants.clear());

test('only an initialize that names the MCP Apps extension with its HTML type counts', () => {
  assert.equal(drawsStillCardV1(DRAWS), true);
  assert.equal(drawsStillCardV1({ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html'] } } }), false);
  assert.equal(drawsStillCardV1({ experimental: { 'io.modelcontextprotocol/ui': { mimeTypes: [STILL_CARD_MIME_V1] } } }), false);
  assert.equal(drawsStillCardV1(undefined), false);
});

test('a client that draws apps gets the card on Still’s four tools and can read it; one that does not gets neither', async (t) => {
  const originalFlags = mcpPrivateAuthRuntime.flags, originalHtml = stillCardRuntimeV1.html;
  mcpPrivateAuthRuntime.flags = (() => ({ routeIntelligenceV1: true, b20ControlV1: true, mcpPrivateV1: true })) as unknown as typeof originalFlags;
  stillCardRuntimeV1.html = async () => '<!doctype html><title>Still review</title>';
  t.after(() => { mcpPrivateAuthRuntime.flags = originalFlags; stillCardRuntimeV1.html = originalHtml; });
  const server = app();

  await rpc(server, WALLET, 'initialize', initialize(DRAWS));
  const tools = (await rpc(server, WALLET, 'tools/list')).result!.tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
  for (const name of STILL_TOOLS) {
    assert.deepEqual(tools.find((tool) => tool.name === name)?._meta, { ui: { resourceUri: STILL_CARD_URI_V1 }, 'ui/resourceUri': STILL_CARD_URI_V1 }, name);
  }
  assert.equal(tools.find((tool) => tool.name === 'miorail_get_my_still')?._meta, undefined, 'a read with nothing to sign has no card');
  const card = (await rpc(server, WALLET, 'resources/read', { uri: STILL_CARD_URI_V1 })).result!.contents as Array<Record<string, unknown>>;
  assert.equal(card[0]!.mimeType, STILL_CARD_MIME_V1);
  assert.equal(card[0]!.text, '<!doctype html><title>Still review</title>');
  const csp = (card[0]!._meta as { ui: { csp: { connectDomains: string[]; resourceDomains: string[]; frameDomains: string[] } } }).ui.csp;
  // Its fonts and WalletConnect, nothing of Still's: every read of Still's goes through the host.
  assert.deepEqual(csp.resourceDomains, ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']);
  assert.ok(csp.connectDomains.includes('wss://relay.walletconnect.org') && csp.frameDomains.includes('https://verify.walletconnect.org'));
  assert.ok([...csp.connectDomains, ...csp.frameDomains].every((origin) => /^(?:wss|https):\/\/[a-z]+\.walletconnect\.(?:org|com)$/.test(origin)));

  // Another wallet's client said nothing about apps: text only, and no card to read.
  await rpc(server, OTHER, 'initialize', initialize({}));
  const plain = (await rpc(server, OTHER, 'tools/list')).result!.tools as Array<{ name: string; _meta?: unknown }>;
  assert.ok(plain.every((tool) => tool._meta === undefined));
  assert.ok((await rpc(server, OTHER, 'resources/read', { uri: STILL_CARD_URI_V1 })).error);

  // Connecting again without the extension forgets it.
  await rpc(server, WALLET, 'initialize', initialize({}));
  const again = (await rpc(server, WALLET, 'tools/list')).result!.tools as Array<{ name: string; _meta?: unknown }>;
  assert.equal(again.find((tool) => tool.name === 'miorail_prepare_still_purchase')?._meta, undefined);
});

test('the deployed file gets the server’s WalletConnect project id, and an id that is not one leaves the card without it', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'still-card-'));
  mkdirSync(path.join(root, 'mcp-app'));
  writeFileSync(path.join(root, 'mcp-app', 'index.html'), '<meta name="still-walletconnect" content="__STILL_WALLETCONNECT_PROJECT_ID__">');
  const env = { index: process.env.MIORAIL_WEB_INDEX_HTML, id: process.env.STILL_WALLETCONNECT_PROJECT_ID };
  t.after(() => {
    for (const [key, value] of [['MIORAIL_WEB_INDEX_HTML', env.index], ['STILL_WALLETCONNECT_PROJECT_ID', env.id]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetStillCardHtmlV1();
  });
  process.env.MIORAIL_WEB_INDEX_HTML = path.join(root, 'index.html');
  for (const [id, expected] of [['0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'], ['not-an-id', ''], [undefined, '']] as const) {
    if (id === undefined) delete process.env.STILL_WALLETCONNECT_PROJECT_ID; else process.env.STILL_WALLETCONNECT_PROJECT_ID = id;
    resetStillCardHtmlV1();
    assert.equal(await stillCardRuntimeV1.html(), `<meta name="still-walletconnect" content="${expected}">`);
  }
});
