import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { encodeFunctionData, erc20Abi, maxUint256, serializeTransaction, type Hex } from 'viem';

import {
  O1_BASE_ROUTER_PROXY_V1,
  O1_ORDER_PATH_V1,
  O1_SWAP_ABI_V1,
  O1SwapRouteAdapter,
  parseO1OrderV1,
  type O1OrderRequestV1,
  type O1RouterPinReaderV1,
} from '../src/index.js';
import { makeIntent, NOW, WALLET } from './fixtures.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
const WETH = '0x4200000000000000000000000000000000000006' as const;
const POOL = '0x2222222222222222222222222222222222222222' as const;
const EXCHANGE = '0x3333333333333333333333333333333333333333' as const;
const OTHER = '0x4444444444444444444444444444444444444444' as const;
const AMOUNT_IN = 100_000_000n;
const MINIMUM_OUT = 37_810_000_000_000_000n;

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

function swapData(
  overrides: {
    tokenOut?: `0x${string}`;
    settlementToken?: `0x${string}`;
    minimumOut?: bigint;
  } = {},
): Hex {
  return encodeFunctionData({
    abi: O1_SWAP_ABI_V1,
    functionName: 'swap',
    args: [
      [
        {
          dexType: 1,
          tokenIn: USDC,
          tokenOut: overrides.tokenOut ?? WETH,
          pool: POOL,
          fee: 500,
          tickSpacing: 10,
          exchange: EXCHANGE,
          extraData: '0x',
        },
      ],
      overrides.settlementToken ?? WETH,
      AMOUNT_IN,
      overrides.minimumOut ?? MINIMUM_OUT,
    ],
  });
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    id: 'o1-order-fixture',
    order: { ...request },
    transactions: [
      {
        id: 'approve',
        unsigned: unsigned(
          USDC,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [O1_BASE_ROUTER_PROXY_V1, maxUint256],
          }),
        ),
      },
      { id: 'swap', unsigned: unsigned(O1_BASE_ROUTER_PROXY_V1, swapData(), 5_000_000n) },
    ],
    ...overrides,
  };
}

function parse(payload: unknown) {
  const intent = makeIntent({ from: 'USDC', to: 'WETH', amount: '100' });
  return parseO1OrderV1({
    payload,
    request,
    inputAsset: intent.fromAsset!,
    outputAsset: intent.toAsset!,
    amountInAtomic: intent.amount.amountAtomic,
  });
}

const verifiedPin: O1RouterPinReaderV1 = {
  async verify() {
    return { ok: true, blockNumber: '49887887' };
  },
};

describe('o1 standard order parser', () => {
  test('derives bounded output and pool provenance from decoded calldata', () => {
    const result = parse(response());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.routerAddress, O1_BASE_ROUTER_PROXY_V1);
    assert.equal(result.value.amountInAtomic, AMOUNT_IN.toString());
    assert.equal(result.value.minimumOutputAtomic, MINIMUM_OUT.toString());
    assert.equal(result.value.expectedOutputAtomic, '38000000000000000');
    assert.equal(result.value.providerApprovalCount, 1);
    assert.equal(result.value.route.length, 1);
    assert.equal(result.value.pools[0]?.address, POOL);
    assert.equal(result.value.liquiditySources[0]?.sourceKey, `eip155:8453/o1-dex-1:${POOL}`);
  });

  test('rejects a request echo mismatch', () => {
    const payload = response({ order: { ...request, signerAddress: OTHER } });
    assert.deepEqual(parse(payload), { ok: false, errorCode: 'o1_order_echo_mismatch' });
  });

  test('rejects Permit2 relay and every non-allowlisted transaction target', () => {
    const permit2 = response();
    (permit2.transactions[0]! as Record<string, unknown>).permit2 = {
      signature: 'never accepted',
    };
    assert.deepEqual(parse(permit2), { ok: false, errorCode: 'o1_permit2_relay_unsupported' });

    const unknown = response();
    unknown.transactions.unshift({ id: 'unknown', unsigned: unsigned(OTHER, '0x12345678') });
    assert.deepEqual(parse(unknown), {
      ok: false,
      errorCode: 'o1_transaction_target_not_allowlisted',
    });
  });

  test('rejects route asset substitution in calldata', () => {
    const payload = response();
    payload.transactions[1]!.unsigned = unsigned(
      O1_BASE_ROUTER_PROXY_V1,
      swapData({ tokenOut: OTHER }),
      5_000_000n,
    );
    assert.deepEqual(parse(payload), { ok: false, errorCode: 'o1_route_asset_mismatch' });
  });

  test('rejects a foreign settlement token hidden in otherwise valid calldata', () => {
    const payload = response();
    payload.transactions[1]!.unsigned = unsigned(
      O1_BASE_ROUTER_PROXY_V1,
      swapData({ settlementToken: OTHER }),
      5_000_000n,
    );
    assert.deepEqual(parse(payload), { ok: false, errorCode: 'o1_swap_calldata_invalid' });
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
    assert.ok(!JSON.stringify(result).includes('fixture-shared-token'));
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
