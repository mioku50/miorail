import assert from 'node:assert/strict';
import test from 'node:test';
import { hashApprovedCallsV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import { SimulationProviderResponseV1Schema, type SimulationProviderRequestV1 } from '@mioagent/paid-intelligence';
import {
  createBaseRpcBatchSimulationProviderV1,
  createBaseRpcSwapSimulationProviderV1,
} from './baseRpcSwapSimulation.js';

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

// ---------------------------------------------------------------------------
// The batch tier.
//
// `mainnet.base.org` serves eth_simulateV1 with state evolving across calls —
// measured, not assumed: an `approve` followed by an `allowance` read in one
// request returns the allowance the approve just set. That is the whole
// requirement for proving approve-then-swap, and it is why a paid key is no
// longer a precondition for the routes whose calldata this server writes.
// ---------------------------------------------------------------------------

const BATCH_CALLS: ExecutionCallV1[] = [
  {
    index: 0,
    callType: 'approval',
    to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    valueWei: '0',
    data: '0x095ea7b3',
    asset: null,
    amountAtomic: null,
    recipient: '0x1111111111111111111111111111111111111111',
    spender: '0x2222222222222222222222222222222222222222',
  },
  {
    index: 1,
    callType: 'swap',
    to: '0x2222222222222222222222222222222222222222',
    valueWei: '0',
    data: '0xcac88ea9',
    asset: null,
    amountAtomic: null,
    recipient: '0x1111111111111111111111111111111111111111',
    spender: null,
  },
];

const BATCH_REQUEST: SimulationProviderRequestV1 = {
  chainId: 8453,
  walletAddress: '0x1111111111111111111111111111111111111111',
  blueprintHash: '0x01',
  callsHash: hashApprovedCallsV1(BATCH_CALLS),
  calls: BATCH_CALLS,
};

function simulateOkResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      result: [
        {
          number: '0x2ff9b00',
          calls: [
            { status: '0x1', gasUsed: '0xd88d', returnData: '0x', logs: [] },
            { status: '0x1', gasUsed: '0x7bab', returnData: '0x', logs: [] },
          ],
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('the batch tier sends eth_simulateV1 and proves an ordered approve+swap', async () => {
  let sent: { method?: string; params?: unknown[] } = {};
  const provider = createBaseRpcBatchSimulationProviderV1({
    rpcUrl: 'https://mainnet.base.org',
    fetchImpl: (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      // The response id must echo the request's, so build it from what we saw.
      const body = await simulateOkResponse().json();
      return new Response(JSON.stringify({ ...body, id: (sent as { id?: string }).id }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  assert.ok(provider);
  const result = await provider.simulate(BATCH_REQUEST);
  assert.equal(sent.method, 'eth_simulateV1');
  assert.ok(result.ok, `expected a pass, got ${result.ok ? '' : result.errorCode}`);
  if (result.ok) {
    const parsed = SimulationProviderResponseV1Schema.parse(result.body);
    assert.equal(parsed.status, 'success');
    assert.equal(parsed.callResults?.length, 2, 'both calls must be reported, in Blueprint order');
  }
  // Two calls, ONE block state call: the ordering the wallet will execute.
  const params = sent.params as [{ blockStateCalls: { calls: unknown[] }[] }, string];
  assert.equal(params[0].blockStateCalls.length, 1);
  assert.equal(params[0].blockStateCalls[0].calls.length, 2);
});

test('the batch tier refuses a non-https endpoint rather than failing at call time', () => {
  assert.equal(createBaseRpcBatchSimulationProviderV1({ rpcUrl: 'http://mainnet.base.org' }), null);
  assert.equal(createBaseRpcBatchSimulationProviderV1({ rpcUrl: 'https://user:pw@rpc.example' }), null);
  assert.equal(createBaseRpcBatchSimulationProviderV1({ rpcUrl: '   ' }), null);
});

test('an endpoint without eth_simulateV1 is method_unsupported, not a revert', async () => {
  // Infura's Base endpoint answers exactly this. It must never read as "the
  // swap reverts" — that is a claim about the market, and this is a claim
  // about the endpoint.
  const provider = createBaseRpcBatchSimulationProviderV1({
    rpcUrl: 'https://base-mainnet.example/v3/key',
    fetchImpl: (async (_url, init) => {
      const id = JSON.parse(String(init?.body)).id;
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'The method eth_simulateV1 does not exist/is not available' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  });
  assert.ok(provider);
  const result = await provider.simulate(BATCH_REQUEST);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCode, 'provider_method_unsupported');
});

test('an endpoint that embeds a key never echoes it back through a failure detail', async () => {
  const secretUrl = 'https://base-mainnet.example/v3/super-secret-key';
  const provider = createBaseRpcBatchSimulationProviderV1({
    rpcUrl: secretUrl,
    fetchImpl: (async (_url, init) => {
      const id = JSON.parse(String(init?.body)).id;
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `upstream ${secretUrl} failed` } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  });
  assert.ok(provider);
  const result = await provider.simulate(BATCH_REQUEST);
  assert.equal(result.ok, false);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('super-secret-key'), 'the endpoint key must not survive into a failure');
});
