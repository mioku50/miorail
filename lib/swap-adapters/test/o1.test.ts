import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  maxUint256,
  parseAbi,
  serializeTransaction,
  zeroHash,
  type Hex,
} from 'viem';

import {
  HYDREX_ZEROX_ALLOWANCE_HOLDER_CODE_HASH_V1,
  HYDREX_ZEROX_ALLOWANCE_HOLDER_V1,
  O1_ORDER_PATH_V1,
  O1_ZEROX_ALLOWANCE_HOLDER_CODE_HASH_V1,
  O1_ZEROX_ALLOWANCE_HOLDER_V1,
  O1_ZEROX_DEPLOYER_V1,
  O1_ZEROX_EXEC_ABI_V1,
  O1_ZEROX_SETTLER_EXECUTE_SELECTOR_V1,
  O1SwapRouteAdapter,
  createO1RouterPinReaderV1,
  o1AttributionSuffixOrNothingV1,
  parseO1OrderV1,
  readO1SettlerSlippageV1,
  type O1OrderRequestV1,
  type O1RouterPinReaderV1,
} from '../src/index.js';
import { makeIntent, NOW, WALLET } from './fixtures.js';
import { ZEROX_ALLOWANCE_HOLDER_CODE_FIXTURE } from './zeroexAllowanceHolderCode.js';

// ---------------------------------------------------------------------------
// 2026-11-11. From 2026-10-20 every order o1 returned was an `exec` on 0x's
// AllowanceHolder, and the pin on o1's own router refused all of them: twenty
// days of comparisons with one router fewer. The boundary below is the one the
// operator approved in its place. The fixtures are shaped as o1 answers today:
// an unlimited approval to AllowanceHolder, then `exec` running the Settler
// that 0x's registry names.
// ---------------------------------------------------------------------------

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
const WETH = '0x4200000000000000000000000000000000000006' as const;
const SETTLER = '0x2222222222222222222222222222222222222222' as const;
const PREVIOUS_SETTLER = '0x3333333333333333333333333333333333333333' as const;
const OTHER = '0x4444444444444444444444444444444444444444' as const;
const OLD_O1_ROUTER = '0x7293d41c28e5fc2292e62d26fec60e22a145d1a5' as const;
const AMOUNT_IN = 100_000_000n;
const MINIMUM_OUT = 37_810_000_000_000_000n;
/** The 29 bytes o1 appended to every order on 2026-11-11. */
const O1_LIVE_SUFFIX = `62635f347261666669616a0b00${'8021'.repeat(8)}`;

const SETTLER_ABI = parseAbi([
  'function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zid) payable returns (bool)',
  'function executeWithPermit((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zid, bytes permitData) payable returns (bool)',
]);

const request: O1OrderRequestV1 = {
  networkId: 8453,
  signerAddress: WALLET,
  tokenAddress: WETH,
  quoteTokenAddress: USDC,
  uiAmount: '100',
  direction: 'buy',
  slippageBps: 50,
  mevProtection: false,
};

function unsigned(to: `0x${string}`, data: Hex, gas = 100_000n): Hex {
  return serializeTransaction({
    chainId: 8453,
    type: 'eip1559',
    nonce: 0,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 0n,
    gas,
    to,
    value: 0n,
    data,
  });
}

type SwapOverridesV1 = {
  operator?: `0x${string}`;
  target?: `0x${string}`;
  token?: `0x${string}`;
  amount?: bigint;
  recipient?: `0x${string}`;
  buyToken?: `0x${string}`;
  minimumOut?: bigint;
  withPermit?: boolean;
};

function settlerCall(overrides: SwapOverridesV1 = {}): Hex {
  const slippage = {
    recipient: overrides.recipient ?? WALLET,
    buyToken: overrides.buyToken ?? WETH,
    minAmountOut: overrides.minimumOut ?? MINIMUM_OUT,
  };
  // The actions are whatever 0x's API chose; nothing here reads them.
  const actions = ['0xc1fb425e00000000000000000000000000000000000000000000000000000000000000aa', '0x38c9c147bb'] as Hex[];
  return overrides.withPermit
    ? encodeFunctionData({ abi: SETTLER_ABI, functionName: 'executeWithPermit', args: [slippage, actions, zeroHash, '0x01'] })
    : encodeFunctionData({ abi: SETTLER_ABI, functionName: 'execute', args: [slippage, actions, zeroHash] });
}

function execData(overrides: SwapOverridesV1 = {}): Hex {
  const operator = overrides.operator ?? SETTLER;
  return encodeFunctionData({
    abi: O1_ZEROX_EXEC_ABI_V1,
    functionName: 'exec',
    args: [operator, overrides.token ?? USDC, overrides.amount ?? AMOUNT_IN, overrides.target ?? operator, settlerCall(overrides)],
  });
}

function response(overrides: SwapOverridesV1 = {}, spender: `0x${string}` = O1_ZEROX_ALLOWANCE_HOLDER_V1) {
  return {
    success: true,
    id: 'o1-order-fixture',
    order: { ...request },
    transactions: [
      {
        id: 'approve',
        description: 'Token Approval',
        unsigned: unsigned(USDC, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256] })),
      },
      { id: 'swap', description: 'Swap', unsigned: unsigned(O1_ZEROX_ALLOWANCE_HOLDER_V1, execData(overrides), 230_466n) },
    ] as { id: string; description?: string; unsigned: Hex; permit2?: unknown }[],
  };
}

function parse(payload: unknown, settlers: readonly string[] = [SETTLER, PREVIOUS_SETTLER]) {
  const intent = makeIntent({ from: 'USDC', to: 'WETH', amount: '100' });
  return parseO1OrderV1({
    payload,
    request,
    inputAsset: intent.fromAsset!,
    outputAsset: intent.toAsset!,
    amountInAtomic: intent.amount.amountAtomic,
    settlers,
  });
}

const verifiedPin: O1RouterPinReaderV1 = {
  async verify() {
    return { ok: true, blockNumber: '56131136', settlers: [SETTLER, PREVIOUS_SETTLER] };
  },
};

describe('o1 standard order parser', () => {
  test('reads the allowance and the Settler’s own final check from the bytes', () => {
    const result = parse(response());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.routerAddress, O1_ZEROX_ALLOWANCE_HOLDER_V1);
    assert.equal(result.value.settler, SETTLER);
    assert.equal(result.value.swapCall.to, O1_ZEROX_ALLOWANCE_HOLDER_V1);
    assert.equal(result.value.swapCall.value, '0');
    assert.equal(result.value.amountInAtomic, AMOUNT_IN.toString());
    assert.equal(result.value.minimumOutputAtomic, MINIMUM_OUT.toString());
    assert.equal(result.value.expectedOutputAtomic, '38000000000000000');
    assert.equal(result.value.providerApprovalCount, 1);
    // The Settler's actions are not decoded, so no pool is claimed.
    assert.deepEqual(result.value.pools, []);
    assert.equal(result.value.liquiditySources.length, 1);
    assert.equal(result.value.liquiditySources[0]?.sourceKey, `eip155:8453/o1-exchange:zerox:${SETTLER}`);
  });

  test('the Settler before the current one is accepted while 0x still uses it', () => {
    const result = parse(response({ operator: PREVIOUS_SETTLER }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.settler, PREVIOUS_SETTLER);
  });

  test('a contract the registry did not name is never handed the allowance', () => {
    assert.deepEqual(parse(response({ operator: OTHER })), { ok: false, errorCode: 'o1_settler_not_in_registry' });
    // The order naming an address does not make it one: with nothing read from the registry, nothing passes.
    assert.deepEqual(parse(response(), []), { ok: false, errorCode: 'o1_settler_not_in_registry' });
  });

  test('the allowance is the exact input, of the input token, for the Settler it runs', () => {
    for (const overrides of [{ target: OTHER }, { token: OTHER }, { amount: AMOUNT_IN + 1n }, { amount: AMOUNT_IN - 1n }] as SwapOverridesV1[]) {
      assert.deepEqual(parse(response(overrides)), { ok: false, errorCode: 'o1_swap_calldata_invalid' }, JSON.stringify(overrides, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    }
  });

  test('behind the arguments: o1’s Builder Code suffix, and nothing else', () => {
    const withTail = (tail: string) => {
      const payload = response();
      payload.transactions[1]!.unsigned = unsigned(O1_ZEROX_ALLOWANCE_HOLDER_V1, `${execData()}${tail}` as Hex, 230_466n);
      return parse(payload);
    };
    // What o1 sends today, byte for byte: "bc_4raffiaj", its length, schema 0, the ERC-8021 marker.
    const live = withTail(O1_LIVE_SUFFIX);
    assert.equal(live.ok, true);
    if (live.ok) assert.ok(live.value.swapCall.data.endsWith(O1_LIVE_SUFFIX), 'the suffix stays in the call the wallet signs');
    for (const tail of [
      '00'.repeat(32),                                  // padding that is not padding
      '8021'.repeat(8),                                 // a marker with no code before it
      `62635f340c00${'8021'.repeat(8)}`,                // a length that is not the code's
      `62635f00340400${'8021'.repeat(8)}`,              // a byte that is not printable
      `${O1_LIVE_SUFFIX}00`,                            // something after the marker
      `${'ab'.repeat(20)}${O1_LIVE_SUFFIX}`,            // an address slipped in before the code
    ]) {
      assert.deepEqual(withTail(tail), { ok: false, errorCode: 'o1_swap_calldata_invalid' }, tail);
    }
  });

  test('the Settler must pay this wallet the token asked for, and say a floor', () => {
    assert.deepEqual(parse(response({ recipient: OTHER })), { ok: false, errorCode: 'o1_route_asset_mismatch' });
    assert.deepEqual(parse(response({ buyToken: OTHER })), { ok: false, errorCode: 'o1_route_asset_mismatch' });
    assert.deepEqual(parse(response({ minimumOut: 0n })), { ok: false, errorCode: 'o1_minimum_output_invalid' });
  });

  test('only execute is accepted: a call that would spend a permit is not', () => {
    assert.deepEqual(parse(response({ withPermit: true })), { ok: false, errorCode: 'o1_settler_call_invalid' });
  });

  test('rejects a request echo mismatch', () => {
    const payload = { ...response(), order: { ...request, signerAddress: OTHER } };
    assert.deepEqual(parse(payload), { ok: false, errorCode: 'o1_order_echo_mismatch' });
  });

  test('rejects Permit2 relay, an approval for anybody else, and every other target', () => {
    const permit2 = response();
    permit2.transactions[0]!.permit2 = { signature: 'never accepted' };
    assert.deepEqual(parse(permit2), { ok: false, errorCode: 'o1_permit2_relay_unsupported' });

    assert.deepEqual(parse(response({}, OTHER)), { ok: false, errorCode: 'o1_provider_approval_invalid' });

    const unknown = response();
    unknown.transactions.unshift({ id: 'unknown', unsigned: unsigned(OTHER, '0x12345678') });
    assert.deepEqual(parse(unknown), { ok: false, errorCode: 'o1_transaction_target_not_allowlisted' });

    // o1's own router is no longer part of the boundary: an order that names it again is a review event.
    const old = response();
    old.transactions[1]!.unsigned = unsigned(OLD_O1_ROUTER, '0xe6cb474f', 5_000_000n);
    assert.deepEqual(parse(old), { ok: false, errorCode: 'o1_transaction_target_not_allowlisted' });
  });
});

describe('the Settler’s final check is read where the Settler reads it', () => {
  test('three words after the selector, whatever follows them', () => {
    const read = readO1SettlerSlippageV1(settlerCall());
    assert.deepEqual(read, { recipient: WALLET.toLowerCase(), buyToken: WETH, minAmountOut: MINIMUM_OUT });
    assert.equal(settlerCall().slice(0, 10), O1_ZEROX_SETTLER_EXECUTE_SELECTOR_V1);
    // The same three words with the tail cut to its two offsets still read the same.
    assert.deepEqual(readO1SettlerSlippageV1(settlerCall().slice(0, 10 + 5 * 64)), read);
  });

  test('an attribution suffix is one code, its length, a zero and the marker', () => {
    assert.equal(o1AttributionSuffixOrNothingV1(''), true);
    assert.equal(o1AttributionSuffixOrNothingV1(O1_LIVE_SUFFIX), true);
    assert.equal(o1AttributionSuffixOrNothingV1(O1_LIVE_SUFFIX.toUpperCase()), true);
    // Two codes with a comma between them are one suffix too.
    assert.equal(o1AttributionSuffixOrNothingV1(`61622c63640500${'8021'.repeat(8)}`), true);
    assert.equal(o1AttributionSuffixOrNothingV1(`0000${'8021'.repeat(8)}`), false, 'no code at all');
    assert.equal(o1AttributionSuffixOrNothingV1(`61620201${'8021'.repeat(8)}`), false, 'another schema');
    assert.equal(o1AttributionSuffixOrNothingV1('6162'), false);
  });

  test('a short call, another selector or a word that is not an address reads as nothing', () => {
    assert.equal(readO1SettlerSlippageV1(settlerCall().slice(0, 10 + 4 * 64)), null);
    assert.equal(readO1SettlerSlippageV1(settlerCall({ withPermit: true })), null);
    const dirty = settlerCall();
    assert.equal(readO1SettlerSlippageV1(`${dirty.slice(0, 10)}ff${dirty.slice(12)}`), null);
    assert.equal(readO1SettlerSlippageV1('0x'), null);
  });
});

describe('o1 route adapter', () => {
  test('uses only the fixed order endpoint and emits an honest candidate', async () => {
    let observedUrl = '';
    let observedAuth = '';
    const adapter = new O1SwapRouteAdapter({
      sharedToken: 'fixture-shared-token',
      pinReader: verifiedPin,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        observedUrl = String(url);
        observedAuth = String(new Headers(init?.headers).get('authorization'));
        return new Response(JSON.stringify(response()), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    const result = await adapter.quote({
      intent: makeIntent({ from: 'USDC', to: 'WETH', amount: '100' }),
      walletAddress: WALLET,
      requestId: 'o1-quote-1',
      now: NOW,
    });
    assert.equal(observedUrl, `https://api.o1.exchange${O1_ORDER_PATH_V1}`);
    assert.equal(observedAuth, 'Bearer fixture-shared-token');
    assert.equal(result.outcome, 'quoted');
    if (result.outcome !== 'quoted') return;
    assert.equal(result.candidate.provider.id, 'o1-exchange');
    assert.equal(result.candidate.priceImpact, null);
    assert.equal(result.candidate.minimumOutput.amountAtomic, MINIMUM_OUT.toString());
    assert.equal(result.candidate.trustMetadata.sourceIndependence, 'overlapping');
    assert.ok(result.candidate.trustMetadata.riskFlags.includes('price_impact_unmeasured'));
    assert.ok(result.candidate.trustMetadata.riskFlags.includes('nested_upstream_calldata'));
    assert.equal(result.candidate.liquiditySources[0]?.sourceKey, `eip155:8453/o1-exchange:zerox:${SETTLER}`);
    assert.ok(!JSON.stringify(result).includes('fixture-shared-token'));
  });

  test('a gas meter replaces the order gas LIMIT with a measured, priced figure', async () => {
    // 2026-10-19: the order states a gas limit and no dollar figure, so an o1
    // route could never be ranked even once its router pin passed again.
    const measured = {
      gasUnits: '402118', maxFeePerGasWei: null, estimatedCostNative: '0.000002412708', estimatedCostUsd: '0.0057928',
    };
    const asked: { approval: unknown; call: { to: string } }[] = [];
    const quote = (measure: () => Promise<typeof measured | null>) => new O1SwapRouteAdapter({
      sharedToken: 'fixture-shared-token',
      pinReader: verifiedPin,
      gasMeter: { async measure(input) { asked.push(input); return measure(); } },
      fetchImpl: (async () => new Response(JSON.stringify(response()), {
        status: 201, headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    }).quote({ intent: makeIntent({ from: 'USDC', to: 'WETH', amount: '100' }), walletAddress: WALLET, requestId: 'o1-gas', now: NOW });

    const priced = await quote(async () => measured);
    assert.equal(priced.outcome, 'quoted');
    if (priced.outcome !== 'quoted') return;
    assert.deepEqual(priced.candidate.estimatedGas, measured);
    assert.ok(priced.candidate.trustMetadata.riskFlags.includes('gas_simulated'));
    assert.ok(!priced.candidate.trustMetadata.riskFlags.includes('gas_limit_not_estimate'));
    assert.equal(asked[0]!.call.to, O1_ZEROX_ALLOWANCE_HOLDER_V1, 'the exact swap the order returned');
    assert.deepEqual(asked[0]!.approval, { token: USDC, spender: O1_ZEROX_ALLOWANCE_HOLDER_V1, amountAtomic: '100000000' });

    const limitOnly = await quote(async () => null);
    assert.equal(limitOnly.outcome, 'quoted');
    if (limitOnly.outcome !== 'quoted') return;
    assert.equal(limitOnly.candidate.estimatedGas.estimatedCostUsd, null);
    assert.ok(limitOnly.candidate.trustMetadata.riskFlags.includes('gas_limit_not_estimate'));
  });

  test('does not call o1 when the onchain pin no longer matches', async () => {
    let called = false;
    const adapter = new O1SwapRouteAdapter({
      sharedToken: 'fixture-shared-token',
      pinReader: {
        async verify() {
          return { ok: false, reason: 'mismatch' };
        },
      },
      fetchImpl: (async () => {
        called = true;
        throw new Error('must not be called');
      }) as typeof fetch,
    });
    const result = await adapter.quote({
      intent: makeIntent({ from: 'USDC', to: 'WETH', amount: '100' }),
      walletAddress: WALLET,
      requestId: 'o1-quote-pin-fail',
      now: NOW,
    });
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.errorCode, 'provider_router_mismatch');
    assert.equal(called, false);
  });
});

describe('the o1 pin read: AllowanceHolder’s code and 0x’s registry', () => {
  const DEPLOYER_ABI = parseAbi([
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function prev(uint128 featureId) view returns (address)',
  ]);
  type ChainV1 = {
    code?: string | null;
    /** An address answers; `revert` is the contract refusing; `down` is the endpoint failing. */
    ownerOf?: `0x${string}` | 'revert' | 'down';
    prev?: `0x${string}` | 'revert';
  };

  /** A JSON-RPC endpoint that knows one AllowanceHolder and one registry. */
  async function withChain<T>(chain: ChainV1, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    const answer = (call: { id: number; method: string; params: unknown[] }) => {
      const result = (value: unknown) => ({ jsonrpc: '2.0', id: call.id, result: value });
      const reverted = { jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted', data: '0x' } };
      if (call.method === 'eth_blockNumber') return result('0x3587f80');
      if (call.method === 'eth_chainId') return result('0x2105');
      if (call.method === 'eth_getCode') return result(chain.code === undefined ? ZEROX_ALLOWANCE_HOLDER_CODE_FIXTURE : (chain.code ?? '0x'));
      if (call.method === 'eth_call') {
        const { to, data } = call.params[0] as { to: string; data: Hex };
        assert.equal(to.toLowerCase(), O1_ZEROX_DEPLOYER_V1, 'only the registry is called');
        const decoded = decodeFunctionData({ abi: DEPLOYER_ABI, data });
        assert.equal(decoded.args[0], 2n, 'feature 2: the Settler a taker submits');
        const value = decoded.functionName === 'ownerOf' ? (chain.ownerOf ?? SETTLER) : (chain.prev ?? PREVIOUS_SETTLER);
        if (value === 'down') return null;
        if (value === 'revert') return reverted;
        return result(encodeFunctionResult({ abi: DEPLOYER_ABI, functionName: decoded.functionName, result: value }));
      }
      return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'method not found' } };
    };
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
      const answers = (Array.isArray(body) ? body : [body]).map(answer);
      if (answers.includes(null)) return new Response('busy', { status: 503 });
      return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  }
  const read = (chain: ChainV1) => withChain(chain, () => createO1RouterPinReaderV1({ rpcUrl: 'https://rpc.example' }).verify());

  test('passes with the current Settler and the one before it', async () => {
    assert.deepEqual(await read({}), { ok: true, blockNumber: '56131456', settlers: [SETTLER, PREVIOUS_SETTLER] });
  });

  test('a registry with no previous Settler names one', async () => {
    assert.deepEqual(await read({ prev: 'revert' }), { ok: true, blockNumber: '56131456', settlers: [SETTLER] });
    assert.deepEqual(await read({ prev: SETTLER }), { ok: true, blockNumber: '56131456', settlers: [SETTLER] });
  });

  test('a paused Settler is a refusal, and the one before it does not soften it', async () => {
    assert.deepEqual(await read({ ownerOf: 'revert' }), { ok: false, reason: 'mismatch' });
  });

  test('other code at AllowanceHolder’s address, or none, is a refusal', async () => {
    assert.deepEqual(await read({ code: '0x6080604052' }), { ok: false, reason: 'mismatch' });
    assert.deepEqual(await read({ code: null }), { ok: false, reason: 'mismatch' });
  });

  test('an endpoint that does not answer is unavailable, never a pass and never a refusal', async () => {
    assert.deepEqual(await read({ ownerOf: 'down' }), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await createO1RouterPinReaderV1({ rpcUrl: ' ' }).verify(), { ok: false, reason: 'not_configured' });
  });

  test('the pinned code is the code Hydrex’s boundary already pins', () => {
    assert.equal(O1_ZEROX_ALLOWANCE_HOLDER_V1, HYDREX_ZEROX_ALLOWANCE_HOLDER_V1);
    assert.equal(O1_ZEROX_ALLOWANCE_HOLDER_CODE_HASH_V1, HYDREX_ZEROX_ALLOWANCE_HOLDER_CODE_HASH_V1);
  });
});
