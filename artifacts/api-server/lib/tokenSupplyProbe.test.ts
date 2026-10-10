import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { readTokenSupplyAnswerV1, tokenSupplyAnswerFromCallV1 } from './tokenSupplyProbe.js';

// A Base node in miniature: each address answers `totalSupply()` the way one
// kind of account does on mainnet.
const TOKEN = '0x00000000000000000000000000000000000000a1';
const WALLET = '0x00000000000000000000000000000000000000a2';
const NO_SUCH_FUNCTION = '0x00000000000000000000000000000000000000a3';
const NODE_DOWN = '0x00000000000000000000000000000000000000a4';
const NODE_LIMITED = '0x00000000000000000000000000000000000000a5';

async function startNodeV1(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        id: number;
        params: [{ to: string; data: string }, string];
      };
      const to = body.params[0].to.toLowerCase();
      const reply = (status: number, payload: Record<string, unknown>) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }));
      };
      if (to === TOKEN) return reply(200, { result: `0x${'0'.repeat(52)}02735a068b48` });
      if (to === WALLET) return reply(200, { result: '0x' });
      if (to === NO_SUCH_FUNCTION) return reply(200, { error: { code: 3, message: 'execution reverted', data: '0x' } });
      if (to === NODE_LIMITED) return reply(200, { error: { code: -32005, message: 'request limit exceeded' } });
      return reply(503, { error: { code: -32603, message: 'unavailable' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('a supply word is a token; an empty or short answer is not', () => {
  assert.equal(tokenSupplyAnswerFromCallV1(`0x${'0'.repeat(63)}1`), 'token');
  assert.equal(tokenSupplyAnswerFromCallV1('0x'), 'not_token');
  assert.equal(tokenSupplyAnswerFromCallV1(undefined), 'not_token');
  assert.equal(tokenSupplyAnswerFromCallV1('0x01'), 'not_token');
});

test('a token answers, a wallet and a contract without the function do not, and a failing node is unreadable', async () => {
  const node = await startNodeV1();
  try {
    const env = { BASE_MAINNET_RPC_URL: node.url } as NodeJS.ProcessEnv;
    assert.equal(await readTokenSupplyAnswerV1(TOKEN, env), 'token');
    assert.equal(await readTokenSupplyAnswerV1(WALLET, env), 'not_token');
    assert.equal(await readTokenSupplyAnswerV1(NO_SUCH_FUNCTION, env), 'not_token');
    // A node that fails is not the address saying no: nothing is decided.
    assert.equal(await readTokenSupplyAnswerV1(NODE_DOWN, env), 'unreadable');
    assert.equal(await readTokenSupplyAnswerV1(NODE_LIMITED, env), 'unreadable');
  } finally {
    await node.close();
  }
});
