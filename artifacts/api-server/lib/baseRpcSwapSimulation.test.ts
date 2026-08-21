import assert from 'node:assert/strict';
import test from 'node:test';
import { SimulationProviderResponseV1Schema, type SimulationProviderRequestV1 } from '@mioagent/paid-intelligence';
import { createBaseRpcSwapSimulationProviderV1 } from './baseRpcSwapSimulation.js';

const REQUEST: SimulationProviderRequestV1 = {
  chainId: 8453,
  walletAddress: '0x1111111111111111111111111111111111111111',
  blueprintHash: '0x01',
  callsHash: '0x02',
  calls: [{
    index: 0,
    callType: 'swap',
    to: '0x2222222222222222222222222222222222222222',
    valueWei: '1000000000000000',
    data: '0x1234',
    asset: null,
    amountAtomic: null,
    recipient: '0x1111111111111111111111111111111111111111',
    spender: null,
  }],
};

test('the Base RPC fallback proves one call at a real Base block', async () => {
  let sent: unknown = null;
  const provider = createBaseRpcSwapSimulationProviderV1({
    rpcUrl: 'https://mainnet.base.org',
    fetchImpl: (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify([
        { jsonrpc: '2.0', id: 1, result: '0x2105' },
        { jsonrpc: '2.0', id: 2, result: '0x' },
        { jsonrpc: '2.0', id: 3, result: '0x5208' },
        { jsonrpc: '2.0', id: 4, result: '0x2ff9b00' },
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  assert.ok(provider);
  const result = await provider.simulate(REQUEST);
  assert.ok(result.ok);
  if (result.ok) {
    const parsed = SimulationProviderResponseV1Schema.parse(result.body);
    assert.equal(parsed.status, 'success');
    assert.equal(parsed.blockNumber, 50_305_792);
  }
  const batch = sent as Array<{ method: string; params: unknown[] }>;
  assert.deepEqual(batch.map((entry) => entry.method), ['eth_chainId', 'eth_call', 'eth_estimateGas', 'eth_blockNumber']);
  const call = batch[1]?.params[0] as Record<string, unknown>;
  assert.deepEqual(call, {
    from: REQUEST.walletAddress,
    to: REQUEST.calls[0]!.to,
    value: '0x38d7ea4c68000',
    data: '0x1234',
  });
});

test('the fallback refuses an ordered approval+swap batch before HTTP', async () => {
  let called = false;
  const provider = createBaseRpcSwapSimulationProviderV1({
    rpcUrl: 'https://mainnet.base.org',
    fetchImpl: (async () => {
      called = true;
      throw new Error('must not be called');
    }) as typeof fetch,
  });
  assert.ok(provider);
  const result = await provider.simulate({ ...REQUEST, calls: [...REQUEST.calls, REQUEST.calls[0]!] });
  assert.deepEqual(result, {
    ok: false,
    errorCode: 'provider_method_unsupported',
    detail: 'Fallback RPC proves only a single call, not an ordered batch',
  });
  assert.equal(called, false);
});

test('a reverted eth_call is evidence of failure, never a transport pass', async () => {
  const provider = createBaseRpcSwapSimulationProviderV1({
    rpcUrl: 'https://mainnet.base.org',
    fetchImpl: (async () => new Response(JSON.stringify([
      { jsonrpc: '2.0', id: 1, result: '0x2105' },
      { jsonrpc: '2.0', id: 2, error: { code: 3, message: 'execution reverted: TOO_LITTLE_RECEIVED' } },
      { jsonrpc: '2.0', id: 3, error: { code: 3, message: 'execution reverted' } },
      { jsonrpc: '2.0', id: 4, result: '0x2ff9b00' },
    ]), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  assert.ok(provider);
  const result = await provider.simulate(REQUEST);
  assert.ok(result.ok);
  if (result.ok) {
    const parsed = SimulationProviderResponseV1Schema.parse(result.body);
    assert.equal(parsed.status, 'reverted');
    assert.match(parsed.revertReason ?? '', /TOO_LITTLE_RECEIVED/);
  }
});
