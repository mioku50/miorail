import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashApprovedCallsV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import {
  ALCHEMY_BASE_MAINNET_HOST_V1,
  ALCHEMY_SIMULATION_PROVIDER_ID_V1,
  buildAlchemySafeRequestV1,
  createAlchemySimulationProviderV1,
  toHexQuantityV1,
} from '../src/providers/alchemy.js';
import { SimulationProviderResponseV1Schema } from '../src/schemas.js';
import type { SimulationProviderRequestV1 } from '../src/provider.js';
import { T59_BLUEPRINT_FIXTURE, WALLET_ADDRESS } from './fixtures.js';

// ---------------------------------------------------------------------------
// T63B §10 — the Alchemy eth_simulateV1 adapter, driven entirely by recorded
// JSON-RPC payloads. The global fetch is replaced with a detonator for the
// whole file: an adapter that reached the network instead of using its
// injected fetch fails the suite loudly.
// ---------------------------------------------------------------------------

globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

const API_KEY = 'test-alchemy-key-DO-NOT-LEAK';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const COUNTERPARTY = '0x2222222222222222222222222222222222222222';
const WETH = '0x4200000000000000000000000000000000000006';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';

const BLUEPRINT_CALLS = T59_BLUEPRINT_FIXTURE.calls;

function topicAddress(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

function amountWord(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function requestFor(calls: readonly ExecutionCallV1[] = BLUEPRINT_CALLS): SimulationProviderRequestV1 {
  return {
    chainId: 8453,
    walletAddress: WALLET_ADDRESS,
    blueprintHash: T59_BLUEPRINT_FIXTURE.blueprintHash,
    callsHash: hashApprovedCallsV1(calls),
    calls,
  };
}

const SINGLE_CALL: readonly ExecutionCallV1[] = [BLUEPRINT_CALLS[0]];

interface FetchRecord {
  url: string;
  init: RequestInit | undefined;
}

function rpcFetch(
  buildBody: (rpcId: string) => unknown,
  options: { status?: number; raw?: string; records?: FetchRecord[] } = {},
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    options.records?.push({ url: String(url), init });
    const requestId = JSON.parse(String(init?.body)).id as string;
    const payload = options.raw ?? JSON.stringify(buildBody(requestId));
    return new Response(payload, {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function throwingFetch(error: Error): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

function callResult(overrides: Record<string, unknown> = {}) {
  return { status: '0x1', gasUsed: '0x11170', returnData: '0x', logs: [], ...overrides };
}

function okResponse(calls: unknown[], blockNumber = '0x2ed1f16') {
  return (id: string) => ({ jsonrpc: '2.0', id, result: [{ number: blockNumber, calls }] });
}

function provider(fetchImpl: typeof fetch, apiKey: string | undefined = API_KEY) {
  return createAlchemySimulationProviderV1({ apiKey, fetchImpl });
}

function failure(result: { ok: boolean; errorCode?: string; detail?: string }): { code: string; detail: string } {
  assert.equal(result.ok, false, 'expected a typed failure');
  return { code: String(result.errorCode), detail: String(result.detail) };
}

function body(result: { ok: boolean; body?: unknown }) {
  assert.equal(result.ok, true, 'expected a successful simulation');
  return SimulationProviderResponseV1Schema.parse(result.body);
}

describe('createAlchemySimulationProviderV1 — request mapping', () => {
  it('maps a single persisted call to eth_simulateV1 with canonical hex quantities', async () => {
    const records: FetchRecord[] = [];
    const result = await provider(rpcFetch(okResponse([callResult()]), { records })).simulate(requestFor(SINGLE_CALL));
    assert.equal(result.ok, true);

    assert.equal(records.length, 1);
    assert.equal(records[0].url, `https://${ALCHEMY_BASE_MAINNET_HOST_V1}/v2/${API_KEY}`);
    const sent = JSON.parse(String(records[0].init?.body));
    assert.equal(sent.jsonrpc, '2.0');
    assert.equal(sent.method, 'eth_simulateV1');
    assert.equal(sent.params[1], 'latest');
    const [params] = sent.params;
    // No state overrides, no transfer tracing, no validation — the chain's real
    // balances/allowances, and no synthesised native transfer logs.
    assert.equal(params.stateOverrides, undefined);
    assert.equal(params.traceTransfers, false);
    assert.equal(params.validation, false);
    assert.equal(params.blockStateCalls.length, 1);

    const [call] = params.blockStateCalls[0].calls;
    assert.equal(call.from, WALLET_ADDRESS.toLowerCase());
    assert.equal(call.to, SINGLE_CALL[0].to);
    assert.equal(call.data, SINGLE_CALL[0].data);
    // 500000000000000000 wei -> canonical hex quantity, no leading zeros.
    assert.equal(call.value, '0x6f05b59d3b20000');
    assert.equal(BigInt(call.value).toString(), SINGLE_CALL[0].valueWei);
  });

  it('keeps multi-call Blueprint order (deposit then swap) in one block state call', async () => {
    const records: FetchRecord[] = [];
    const result = await provider(
      rpcFetch(okResponse([callResult(), callResult({ gasUsed: '0x5208' })]), { records }),
    ).simulate(requestFor());
    const parsed = body(result);

    const sent = JSON.parse(String(records[0].init?.body));
    const calls = sent.params[0].blockStateCalls[0].calls;
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((call: { to: string; data: string }) => [call.to, call.data]),
      BLUEPRINT_CALLS.map((call) => [call.to, call.data]),
    );
    // …and the per-call results come back in that same order.
    assert.deepEqual(parsed.callResults?.map((entry) => entry.index), [0, 1]);
    assert.equal(parsed.gasUsed, String(0x11170 + 0x5208));
  });

  it('toHexQuantityV1 rejects anything that is not an unsigned integer', () => {
    assert.equal(toHexQuantityV1('0'), '0x0');
    assert.equal(toHexQuantityV1('255'), '0xff');
    assert.equal(toHexQuantityV1('-1'), null);
    assert.equal(toHexQuantityV1('1.5'), null);
    assert.equal(toHexQuantityV1('0x10'), null);
    assert.equal(buildAlchemySafeRequestV1(WALLET_ADDRESS, BLUEPRINT_CALLS)?.calls.length, 2);
  });

  it('refuses a request whose calls do not hash to the claimed callsHash', async () => {
    const tampered = { ...requestFor(), callsHash: `0x${'9'.repeat(64)}` } as SimulationProviderRequestV1;
    assert.equal(failure(await provider(rpcFetch(okResponse([]))).simulate(tampered)).code, 'provider_blueprint_mismatch');
  });

  it('refuses any chain other than Base mainnet', async () => {
    const wrongChain = { ...requestFor(), chainId: 1 as unknown as 8453 };
    assert.equal(failure(await provider(rpcFetch(okResponse([]))).simulate(wrongChain)).code, 'provider_chain_mismatch');
  });

  it('reports provider_not_configured without a key, and never opens a socket', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    // Built directly (not via the helper) so `undefined` really is undefined.
    const missing = createAlchemySimulationProviderV1({ apiKey: undefined, fetchImpl });
    assert.equal(failure(await missing.simulate(requestFor())).code, 'provider_not_configured');
    assert.equal(called, false);
    const blank = createAlchemySimulationProviderV1({ apiKey: '   ', fetchImpl });
    assert.equal(failure(await blank.simulate(requestFor())).code, 'provider_not_configured');
    assert.equal(called, false);
  });
});

describe('createAlchemySimulationProviderV1 — response validation', () => {
  it('normalizes an all-success run into a passed simulation', async () => {
    const parsed = body(
      await provider(rpcFetch(okResponse([callResult(), callResult({ gasUsed: '0x5208' })]))).simulate(requestFor()),
    );
    assert.equal(parsed.status, 'success');
    assert.equal(parsed.blockNumber, 0x2ed1f16);
    assert.equal(parsed.failedCallIndex, null);
    assert.equal(parsed.revertReason, null);
    assert.deepEqual(
      parsed.callResults?.map((entry) => entry.status),
      ['success', 'success'],
    );
  });

  it('a reverted SECOND call reverts the whole simulation and names the failing index', async () => {
    const parsed = body(
      await provider(
        rpcFetch(
          okResponse([
            callResult(),
            callResult({ status: '0x0', gasUsed: '0x5208', error: { message: 'ERC20: transfer amount exceeds balance' } }),
          ]),
        ),
      ).simulate(requestFor()),
    );
    assert.equal(parsed.status, 'reverted');
    assert.equal(parsed.failedCallIndex, 1);
    assert.equal(parsed.revertReason, 'ERC20: transfer amount exceeds balance');
    assert.deepEqual(parsed.callResults?.map((entry) => entry.status), ['success', 'reverted']);
    // Gas is still reported for both calls — a revert is a real, paid-for answer.
    assert.equal(parsed.gasUsed, String(0x11170 + 0x5208));
    // A reverted run changes no state, so nothing is claimed about assets.
    assert.equal(parsed.assetChanges?.status, 'unavailable');
    assert.equal(parsed.assetChanges?.unavailableReason, 'simulation_reverted_no_state_change');
  });

  it('an UNKNOWN call status is a schema failure — never a success', async () => {
    for (const status of ['0x2', '0x', 'success', '0x01']) {
      const result = await provider(rpcFetch(okResponse([callResult({ status })]))).simulate(requestFor(SINGLE_CALL));
      assert.equal(failure(result).code, 'provider_invalid_schema', `status ${status} must not be accepted`);
    }
  });

  it('rejects a call-count mismatch instead of simulating a partial Blueprint', async () => {
    const result = await provider(rpcFetch(okResponse([callResult()]))).simulate(requestFor());
    const { code, detail } = failure(result);
    assert.equal(code, 'provider_call_count_mismatch');
    assert.match(detail, /simulated 1 of 2/);
  });

  it('rejects a missing or non-positive block number', async () => {
    const noBlock = await provider(
      rpcFetch((id) => ({ jsonrpc: '2.0', id, result: [{ calls: [callResult()] }] })),
    ).simulate(requestFor(SINGLE_CALL));
    assert.equal(failure(noBlock).code, 'provider_invalid_schema');

    const zeroBlock = await provider(rpcFetch(okResponse([callResult()], '0x0'))).simulate(requestFor(SINGLE_CALL));
    assert.equal(failure(zeroBlock).code, 'provider_invalid_schema');
  });

  it('rejects an invalid gas quantity', async () => {
    for (const gasUsed of ['145000', '0x', '0xzz', '']) {
      const result = await provider(rpcFetch(okResponse([callResult({ gasUsed })]))).simulate(requestFor(SINGLE_CALL));
      assert.equal(failure(result).code, 'provider_invalid_schema', `gas ${gasUsed} must not be accepted`);
    }
  });

  it('rejects a malformed JSON-RPC envelope, a wrong id, and a non-JSON body', async () => {
    const wrongVersion = await provider(
      rpcFetch((id) => ({ jsonrpc: '1.0', id, result: [{ number: '0x1', calls: [callResult()] }] })),
    ).simulate(requestFor(SINGLE_CALL));
    assert.equal(failure(wrongVersion).code, 'provider_invalid_schema');

    const wrongId = await provider(
      rpcFetch(() => ({ jsonrpc: '2.0', id: 'someone-elses-request', result: [{ number: '0x1', calls: [callResult()] }] })),
    ).simulate(requestFor(SINGLE_CALL));
    assert.equal(failure(wrongId).code, 'provider_invalid_schema');

    const notJson = await provider(rpcFetch(okResponse([]), { raw: '<html>gateway</html>' })).simulate(
      requestFor(SINGLE_CALL),
    );
    assert.equal(failure(notJson).code, 'provider_invalid_schema');

    const emptyResult = await provider(rpcFetch((id) => ({ jsonrpc: '2.0', id, result: [] }))).simulate(
      requestFor(SINGLE_CALL),
    );
    assert.equal(failure(emptyResult).code, 'provider_invalid_schema');
  });

  it('maps a JSON-RPC error, rate limits, HTTP failures and timeouts to distinct codes', async () => {
    const rpcError = await provider(
      rpcFetch((id) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: 'execution reverted' } })),
    ).simulate(requestFor(SINGLE_CALL));
    assert.equal(failure(rpcError).code, 'provider_rpc_error');

    const rpcRateLimit = await provider(
      rpcFetch((id) => ({ jsonrpc: '2.0', id, error: { code: -32029, message: 'Your app has exceeded its throughput limit' } })),
    ).simulate(requestFor(SINGLE_CALL));
    assert.equal(failure(rpcRateLimit).code, 'provider_rate_limited');

    const httpRateLimit = await provider(rpcFetch(okResponse([]), { status: 429 })).simulate(requestFor(SINGLE_CALL));
    assert.equal(failure(httpRateLimit).code, 'provider_rate_limited');

    const httpError = await provider(rpcFetch(okResponse([]), { status: 502 })).simulate(requestFor(SINGLE_CALL));
    assert.equal(failure(httpError).code, 'provider_http_error');

    const timeout = await provider(
      throwingFetch(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })),
    ).simulate(requestFor(SINGLE_CALL));
    assert.equal(failure(timeout).code, 'provider_timeout');

    const transport = await provider(throwingFetch(new Error('ECONNRESET'))).simulate(requestFor(SINGLE_CALL));
    assert.equal(failure(transport).code, 'network_error');
  });
});

describe('createAlchemySimulationProviderV1 — asset changes', () => {
  it('decodes an ERC-20 Transfer to the authenticated wallet as a proven inbound change', async () => {
    const logs = [
      {
        address: USDC,
        topics: [TRANSFER_TOPIC, topicAddress(COUNTERPARTY), topicAddress(WALLET_ADDRESS)],
        data: amountWord(1_500_000n),
      },
    ];
    const parsed = body(
      await provider(rpcFetch(okResponse([callResult({ logs })]))).simulate(requestFor(SINGLE_CALL)),
    );
    assert.equal(parsed.assetChanges?.status, 'available');
    assert.deepEqual(parsed.assetChanges?.changes, [
      {
        kind: 'erc20_transfer',
        token: USDC,
        direction: 'in',
        amountAtomic: '1500000',
        counterparty: COUNTERPARTY,
        callIndex: 0,
      },
    ]);
    // Mirrored into the existing T59 stateChanges field, in base units only —
    // no symbol or decimals are known from a log, so none are invented.
    assert.equal(parsed.stateChanges.length, 1);
    assert.equal(parsed.stateChanges[0].address, USDC);
    assert.equal(parsed.stateChanges[0].kind, 'token');
    assert.match(parsed.stateChanges[0].summary, /receives 1500000 base units/);
    assert.doesNotMatch(parsed.stateChanges[0].summary, /USDC|\$/);
  });

  it('decodes an outbound Transfer and a pinned-WETH Deposit, and ignores third-party movement', async () => {
    const logs = [
      // wallet -> counterparty (outbound)
      {
        address: USDC,
        topics: [TRANSFER_TOPIC, topicAddress(WALLET_ADDRESS), topicAddress(COUNTERPARTY)],
        data: amountWord(900n),
      },
      // canonical Base WETH deposit by the wallet
      { address: WETH, topics: [DEPOSIT_TOPIC, topicAddress(WALLET_ADDRESS)], data: amountWord(500_000_000_000_000_000n) },
      // two third parties — nothing to do with this wallet
      {
        address: USDC,
        topics: [TRANSFER_TOPIC, topicAddress(COUNTERPARTY), topicAddress('0x3333333333333333333333333333333333333333')],
        data: amountWord(42n),
      },
      // the SAME Deposit topic from an impostor contract is not wrapped ETH
      {
        address: '0x4444444444444444444444444444444444444444',
        topics: [DEPOSIT_TOPIC, topicAddress(WALLET_ADDRESS)],
        data: amountWord(999n),
      },
    ];
    const parsed = body(
      await provider(rpcFetch(okResponse([callResult({ logs })]))).simulate(requestFor(SINGLE_CALL)),
    );
    assert.equal(parsed.assetChanges?.status, 'available');
    assert.deepEqual(
      parsed.assetChanges?.changes.map((change) => [change.kind, change.direction, change.amountAtomic]),
      [
        ['erc20_transfer', 'out', '900'],
        ['weth_deposit', 'in', '500000000000000000'],
      ],
    );
    assert.equal(parsed.callResults?.[0].logCount, 4);
  });

  it('a native-ETH-only run leaves asset changes UNAVAILABLE rather than empty', async () => {
    // A plain value transfer emits no log at all — there is nothing to prove.
    const parsed = body(
      await provider(rpcFetch(okResponse([callResult({ logs: [] })]))).simulate(requestFor(SINGLE_CALL)),
    );
    assert.equal(parsed.status, 'success');
    assert.equal(parsed.assetChanges?.status, 'unavailable');
    assert.equal(parsed.assetChanges?.unavailableReason, 'no_logs_emitted');
    assert.deepEqual(parsed.assetChanges?.changes, []);
    assert.deepEqual(parsed.stateChanges, []);
  });

  it('an undecodable log makes the whole asset-change block unavailable', async () => {
    const logs = [
      // Transfer topic with a malformed amount word: recognised but unprovable.
      {
        address: USDC,
        topics: [TRANSFER_TOPIC, topicAddress(COUNTERPARTY), topicAddress(WALLET_ADDRESS)],
        data: '0x1234',
      },
    ];
    const parsed = body(
      await provider(rpcFetch(okResponse([callResult({ logs })]))).simulate(requestFor(SINGLE_CALL)),
    );
    assert.equal(parsed.status, 'success');
    assert.equal(parsed.assetChanges?.status, 'unavailable');
    assert.equal(parsed.assetChanges?.unavailableReason, 'undecodable_logs_present');
    assert.equal(parsed.callResults?.[0].logCount, 1);
  });

  it('logs from a REVERTED call are never decoded into asset changes', async () => {
    const logs = [
      {
        address: USDC,
        topics: [TRANSFER_TOPIC, topicAddress(COUNTERPARTY), topicAddress(WALLET_ADDRESS)],
        data: amountWord(1n),
      },
    ];
    const parsed = body(
      await provider(rpcFetch(okResponse([callResult({ status: '0x0', logs })]))).simulate(requestFor(SINGLE_CALL)),
    );
    assert.equal(parsed.status, 'reverted');
    assert.deepEqual(parsed.assetChanges?.changes, []);
  });
});

describe('createAlchemySimulationProviderV1 — secret handling', () => {
  it('never lets the API key reach the response body, an error detail, or a hash input', async () => {
    const records: FetchRecord[] = [];
    const ok = await provider(rpcFetch(okResponse([callResult()]), { records })).simulate(requestFor(SINGLE_CALL));
    assert.equal(ok.ok, true);
    // The key appears ONLY in the endpoint the adapter builds internally.
    assert.match(records[0].url, new RegExp(API_KEY));
    assert.doesNotMatch(JSON.stringify(records[0].init?.body), new RegExp(API_KEY));
    assert.doesNotMatch(JSON.stringify(ok), new RegExp(API_KEY));

    // …and on every failure path, where a naive implementation would echo the URL.
    const failures = await Promise.all([
      provider(rpcFetch(okResponse([]), { status: 502 })).simulate(requestFor(SINGLE_CALL)),
      provider(rpcFetch(okResponse([]), { status: 429 })).simulate(requestFor(SINGLE_CALL)),
      provider(throwingFetch(new Error(`connect ECONNREFUSED https://${ALCHEMY_BASE_MAINNET_HOST_V1}/v2/${API_KEY}`))).simulate(
        requestFor(SINGLE_CALL),
      ),
      provider(rpcFetch((id) => ({ jsonrpc: '2.0', id, error: { message: `key ${API_KEY} rejected` } }))).simulate(
        requestFor(SINGLE_CALL),
      ),
    ]);
    for (const result of failures) {
      assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY));
    }

    // The safe request — the only representation that may be hashed or logged.
    const safe = buildAlchemySafeRequestV1(WALLET_ADDRESS, SINGLE_CALL);
    assert.doesNotMatch(JSON.stringify(safe), new RegExp(API_KEY));
    assert.doesNotMatch(JSON.stringify(safe), /alchemy/i);
  });

  it('advertises the pinned provider id', () => {
    assert.equal(ALCHEMY_SIMULATION_PROVIDER_ID_V1, 'alchemy-eth-simulate-v1');
    assert.equal(provider(rpcFetch(okResponse([]))).providerId, 'alchemy-eth-simulate-v1');
  });
});
