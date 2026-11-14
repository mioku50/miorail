import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { encodeAbiParameters } from 'viem';
import { createChainTokenIdentityReaderV1 } from './tokenIdentityReader.js';

// 2026-11-14: the primary Base endpoint answered invalid responses for a few
// seconds, AAPLc's symbol() and decimals() could not be read, and a sell of
// AAPLc from Assets was refused as an untrusted address twice in a row. The
// reader now asks a second endpoint when the first fails.

const AAPLC = '0xb200000000000000000000c2e324d24d7eecd1fb';

function listen(handler: (body: { id: number; method: string; params: unknown[] }) => { status: number; body: string }): Promise<Server> {
  return new Promise((ready) => {
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
        const answer = handler(parsed);
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(answer.body);
      });
    });
    server.listen(0, '127.0.0.1', () => ready(server));
  });
}
const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

describe('the chain token reader asks a second endpoint when the first fails', () => {
  let broken: Server;
  let answering: Server;
  let primaryCalls = 0;
  let fallbackCalls = 0;
  before(async () => {
    broken = await listen(() => { primaryCalls++; return { status: 503, body: '{"error":"unavailable"}' }; });
    answering = await listen((call) => {
      fallbackCalls++;
      const data = String((call.params[0] as { data?: string })?.data ?? '');
      const result = data.startsWith('0x95d89b41')
        ? encodeAbiParameters([{ type: 'string' }], ['AAPLc'])
        : data.startsWith('0x313ce567')
          ? encodeAbiParameters([{ type: 'uint8' }], [8])
          : '0x';
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: call.id, result }) };
    });
  });
  after(() => { broken.close(); answering.close(); });

  it('reads symbol() and decimals() from the fallback while the primary answers 503', async () => {
    const reader = createChainTokenIdentityReaderV1({ rpcUrl: urlOf(broken), fallbackRpcUrl: urlOf(answering), timeoutMs: 2_000 });
    assert.equal(await reader.readSymbol(AAPLC), 'AAPLc');
    assert.equal(await reader.readDecimals(AAPLC), 8);
    assert.ok(primaryCalls > 0, 'the primary is asked first');
    assert.ok(fallbackCalls >= 2, 'the fallback answered both reads');
  });

  it('without a fallback the same failure is still unread, never a guess', async () => {
    const reader = createChainTokenIdentityReaderV1({ rpcUrl: urlOf(broken), timeoutMs: 2_000 });
    assert.equal(await reader.readSymbol(AAPLC), null);
    assert.equal(await reader.readDecimals(AAPLC), null);
  });
});
