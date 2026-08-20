import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { B20_CREATED_TOPIC_V1, B20_FACTORY_V1 } from '@mioagent/b20-control';

import { locateB20LaunchByCodeV1 } from './b20TargetedLaunch.js';

const TOKEN = '0xb20000000000000000000047f57bc93d7f130101';
const TOPIC = `0x${'0'.repeat(24)}${TOKEN.slice(2)}`;

function responseV1(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('targeted canonical launch lookup', () => {
  test('binary-searches code and reads exactly one creation block', async () => {
    const readBlocks: number[] = [];
    let logRange: { fromBlock: string; toBlock: string; topics: string[] } | null = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (body.method === 'eth_blockNumber') return responseV1('0x64');
      if (body.method === 'eth_getCode') {
        const block = Number(BigInt((body.params[1] as string)));
        readBlocks.push(block);
        return responseV1(block >= 42 ? '0x6001' : '0x');
      }
      const filter = body.params[0] as { fromBlock: string; toBlock: string; topics: string[] };
      logRange = filter;
      return responseV1([
        {
          address: B20_FACTORY_V1,
          topics: [B20_CREATED_TOPIC_V1, TOPIC, `0x${'0'.repeat(64)}`],
          data: '0x',
          blockNumber: '0x2a',
          blockHash: `0x${'a'.repeat(64)}`,
          transactionHash: `0x${'b'.repeat(64)}`,
          logIndex: '0x0',
          transactionIndex: '0x0',
          removed: false,
        },
      ]);
    };

    const result = await locateB20LaunchByCodeV1({
      rpcUrl: 'https://example.invalid',
      tokenAddress: TOKEN,
      budgetMs: 10_000,
      fetchImpl,
    });
    assert.equal(result.outcome, 'found');
    assert.equal(result.outcome === 'found' ? result.creationBlock : null, 42);
    assert.deepEqual(logRange, {
      address: B20_FACTORY_V1,
      fromBlock: '0x2a',
      toBlock: '0x2a',
      topics: [B20_CREATED_TOPIC_V1, TOPIC],
    });
    assert.ok(readBlocks.length <= 9, `binary search used ${readBlocks.length} code reads for 101 blocks`);
  });

  test('a missing contract is a completed not-found result', async () => {
    const result = await locateB20LaunchByCodeV1({
      rpcUrl: 'https://example.invalid',
      tokenAddress: TOKEN,
      budgetMs: 10_000,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        return responseV1(body.method === 'eth_blockNumber' ? '0x64' : '0x');
      },
    });
    assert.equal(result.outcome, 'not_found');
  });

  test('the wall-clock budget is an explicit timeout', async () => {
    let now = 0;
    const result = await locateB20LaunchByCodeV1({
      rpcUrl: 'https://example.invalid',
      tokenAddress: TOKEN,
      budgetMs: 5,
      monotonicMs: () => now,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        now += 4;
        return responseV1(body.method === 'eth_blockNumber' ? '0x64' : '0x6001');
      },
    });
    assert.equal(result.outcome, 'timed_out');
  });
});
