import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { createSpendBalanceReaderV1 } from './spendBalance.js';

const WALLET = '0x8e525BfCe1eF40Aa8075ef64E45421b5855C8909' as const;
const USDC = {
  assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  chainId: 8453 as const,
  kind: 'erc20' as const,
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const,
  symbol: 'USDC',
  decimals: 6,
};
const ETH = {
  assetId: 'eip155:8453/native',
  chainId: 8453 as const,
  kind: 'native' as const,
  address: null,
  symbol: 'ETH',
  decimals: 18,
};

function answering(result: unknown, status = 200) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

describe('what the wallet holds of the asset a swap spends', () => {
  test('an ERC-20 is read with balanceOf on that token, for that wallet', async () => {
    const rpc = answering(`0x${(232696).toString(16).padStart(64, '0')}`);
    const read = createSpendBalanceReaderV1({ rpcUrl: 'https://base.example', fetchImpl: rpc.fetchImpl })!;
    assert.equal(await read({ asset: USDC, walletAddress: WALLET }), 232696n);
    assert.deepEqual(rpc.bodies, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            to: USDC.address,
            data: '0x70a082310000000000000000000000008e525bfce1ef40aa8075ef64e45421b5855c8909',
          },
          'latest',
        ],
      },
    ]);
  });

  test('ETH is read with eth_getBalance', async () => {
    const rpc = answering('0x373f63e17268');
    const read = createSpendBalanceReaderV1({ rpcUrl: 'https://base.example', fetchImpl: rpc.fetchImpl })!;
    assert.equal(await read({ asset: ETH, walletAddress: WALLET }), 60745398186600n);
    assert.equal(rpc.bodies[0]!.method, 'eth_getBalance');
  });

  test('a read that did not come back is null, never a zero balance', async () => {
    for (const [result, status] of [
      ['0x', 200],
      [null, 200],
      ['not hex', 200],
      ['0x00', 500],
    ] as const) {
      const read = createSpendBalanceReaderV1({ rpcUrl: 'https://base.example', fetchImpl: answering(result, status).fetchImpl })!;
      assert.equal(await read({ asset: USDC, walletAddress: WALLET }), null, `${String(result)} / ${status}`);
    }
    const thrown = createSpendBalanceReaderV1({
      rpcUrl: 'https://base.example',
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    })!;
    assert.equal(await thrown({ asset: USDC, walletAddress: WALLET }), null);
  });

  test('no reader without a plain https endpoint', () => {
    assert.equal(createSpendBalanceReaderV1({ rpcUrl: undefined }), null);
    assert.equal(createSpendBalanceReaderV1({ rpcUrl: 'http://base.example' }), null);
    assert.equal(createSpendBalanceReaderV1({ rpcUrl: 'https://user:pass@base.example' }), null);
  });
});
