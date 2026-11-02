import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';

import { mcpPrivateAuthRuntime } from './session.js';
import { mcpPrivateRouter } from './index.js';

// The connected endpoint's own limit through the real router: a host's
// handshake is counted apart from the assistant's tool calls, and a tool call
// over the limit hears, as its own result, that the limit is Miorail's. On
// 2026-11-02 a bare 429 there was reported to the person as Bitrefill refusing
// a purchase. The wallet is synthetic.
const WALLET = `0x${'7'.repeat(40)}`;

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    Object.defineProperty(req, 'session', { value: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } } });
    next();
  });
  a.use('/mcp/private', mcpPrivateRouter);
  return a;
}

const post = (server: ReturnType<typeof app>, id: number, method: string, params: Record<string, unknown> = {}) =>
  request(server).post('/mcp/private').set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id, method, params });

function answerOf(response: request.Response) {
  const line = String(response.text).split('\n').find((row) => row.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : response.text) as { id?: unknown; result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: { message: string } };
}

test('a host’s handshake does not spend the tool calls’ allowance, and a tool call over it hears whose limit it is', async (t) => {
  const originalFlags = mcpPrivateAuthRuntime.flags;
  mcpPrivateAuthRuntime.flags = (() => ({ routeIntelligenceV1: true, b20ControlV1: true, mcpPrivateV1: true })) as unknown as typeof originalFlags;
  t.after(() => { mcpPrivateAuthRuntime.flags = originalFlags; });
  const server = app();

  // Thirty handshake requests, more than the twenty tool calls a minute, and none counted against them.
  for (let id = 1; id <= 30; id += 1) {
    const response = id % 2
      ? await post(server, id, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'limit-test', version: '1' } })
      : await post(server, id, 'tools/list');
    assert.equal(response.status, 200, `handshake ${id} answered ${response.status}`);
  }
  for (let id = 31; id <= 50; id += 1) {
    const response = await post(server, id, 'tools/call', { name: 'no_such_tool', arguments: {} });
    assert.equal(response.status, 200);
    assert.ok(!JSON.stringify(answerOf(response)).includes('own limit'), `call ${id} was limited`);
  }

  const limited = await post(server, 51, 'tools/call', { name: 'miorail_prepare_still_purchase', arguments: {} });
  assert.equal(limited.status, 200);
  assert.match(String(limited.headers['retry-after']), /^\d+$/);
  const said = answerOf(limited);
  assert.equal(said.id, 51);
  assert.equal(said.result?.isError, true);
  assert.match(said.result?.content?.[0]?.text ?? '', /^Miorail did not run this: the connection made more than 20 calls in a minute\. This is Miorail's own limit, not Bitrefill's, a lending protocol's or the chain's, and nothing was done\. Try again in \d+ seconds\.$/);

  // Anything else over the limit is the protocol's own 429, answered to its request.
  const read = await post(server, 52, 'resources/read', { uri: 'ui://still/review.html' });
  assert.equal(read.status, 429);
  assert.equal(answerOf(read).id, 52);
  assert.match(answerOf(read).error?.message ?? '', /more than 20 calls in a minute\. This is Miorail's own limit/);
  // The handshake still answers.
  assert.equal((await post(server, 53, 'tools/list')).status, 200);
});
