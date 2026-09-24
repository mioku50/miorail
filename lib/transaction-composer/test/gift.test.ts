import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { encodeFunctionData, erc20Abi } from 'viem';
import type { AssetRefV1, ExecutionCallV1 } from '@mioagent/route-domain';

import { blueprintIdV1, classifySwapCallV1 } from '../src/blueprint.js';
import { narrowUniswapApprovalsV1 } from '../src/adapters/uniswap.js';
import {
  encodeGiftTransferV1,
  giftDeclarationFromCallsV1,
  giftTransferCallV1,
  validateGiftTransferV1,
} from '../src/gift.js';
import { runSafetyKernel } from '../src/safetyKernel.js';
import { NOW, USDC_BASE, WALLET, makeIntent } from './fixtures.js';

// ---------------------------------------------------------------------------
// A gift: the ordinary swap to the wallet, then one transfer of exactly the
// swap's guaranteed minimum to the declared recipient — and nothing else.
// ---------------------------------------------------------------------------

const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43' as const;
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const;
const FRIEND = '0x8e525bfce1c0ffee00000000000000000000beef' as const;
const MINIMUM = '44006';

const NVDA_BASE: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0xb20000000000000000000078ee7ce2fe4908108c',
  chainId: 8453,
  kind: 'erc20',
  address: '0xb20000000000000000000078ee7ce2fe4908108c',
  symbol: 'NVDAc',
  decimals: 8,
};

const intent = makeIntent({ toAsset: NVDA_BASE, amountDecimal: '0.1', verificationDepth: 'enhanced' });
const quoteExpiry = new Date(NOW.getTime() + 10 * 60_000).toISOString();

/** A real Uniswap batch shape, narrowed and classified the way the composer does it. */
function swapPart(): ExecutionCallV1[] {
  const expirySec = Math.floor(Date.parse(quoteExpiry) / 1000);
  const word = (value: bigint | string) =>
    (typeof value === 'string' ? value.replace(/^0x/, '').toLowerCase() : value.toString(16)).padStart(64, '0');
  const amount = BigInt(intent.amount.amountAtomic);
  const raw = narrowUniswapApprovalsV1(
    [
      { to: USDC_BASE.address!, value: '0', data: `0x095ea7b3${word(PERMIT2)}${word((1n << 256n) - 1n)}` },
      {
        to: PERMIT2,
        value: '0',
        data: `0x87517c45${word(USDC_BASE.address!)}${word(ROUTER)}${word(amount)}${word(BigInt(expirySec))}`,
      },
      { to: ROUTER, value: '0', data: '0x3593564c' },
    ],
    { inputToken: USDC_BASE.address!, amountAtomic: intent.amount.amountAtomic, expiresAtSec: expirySec },
  );
  return raw.map((call, index) =>
    classifySwapCallV1({ index, call: call as never, routerAddress: ROUTER, inputAsset: USDC_BASE, walletAddress: WALLET }),
  );
}

function giftBatch(over: Partial<{ recipient: `0x${string}`; amountAtomic: string }> = {}): ExecutionCallV1[] {
  const swap = swapPart();
  return [
    ...swap,
    giftTransferCallV1({
      index: swap.length,
      token: NVDA_BASE,
      recipient: over.recipient ?? FRIEND,
      amountAtomic: over.amountAtomic ?? MINIMUM,
    }),
  ];
}

function kernel(calls: ExecutionCallV1[], over: Partial<Parameters<typeof runSafetyKernel>[0]> = {}) {
  return runSafetyKernel({
    provider: 'uniswap',
    routerAddress: ROUTER,
    chainId: 8453,
    walletAddress: WALLET,
    intent,
    calls,
    quoteExpiry,
    now: NOW,
    contractSecurityRequired: true,
    contractSecurityProvider: 'goplus',
    contractSecurityResults: [
      { address: USDC_BASE.address!, provider: 'goplus', status: 'ok', summary: 'clean' },
      { address: NVDA_BASE.address!, provider: 'goplus', status: 'ok', summary: 'clean' },
    ],
    contractSecurityAddresses: [USDC_BASE.address as `0x${string}`, NVDA_BASE.address as `0x${string}`],
    simulationAcceptable: true,
    simulationDetail: 'ok',
    intentHash: intent.intentHash,
    selectedCandidateHash: `0x${'1'.repeat(64)}`,
    swapMinimumOutputAtomic: MINIMUM,
    ...over,
  }).result;
}

describe('the gift call', () => {
  test('is an exact ERC-20 transfer of the bought token, and reads back as its declaration', () => {
    const call = giftTransferCallV1({ index: 3, token: NVDA_BASE, recipient: FRIEND, amountAtomic: MINIMUM });
    assert.equal(call.callType, 'transfer');
    assert.equal(call.to, NVDA_BASE.address);
    assert.equal(call.valueWei, '0');
    assert.equal(
      call.data,
      encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [FRIEND, BigInt(MINIMUM)] }),
    );
    assert.deepEqual(giftDeclarationFromCallsV1([...swapPart(), call]), { recipient: FRIEND, amountAtomic: MINIMUM });
    assert.equal(giftDeclarationFromCallsV1(swapPart()), null);
  });

  test('only an ERC-20 can be given', () => {
    assert.throws(() =>
      giftTransferCallV1({
        index: 0,
        token: { assetId: 'eip155:8453/native:eth', chainId: 8453, kind: 'native', address: null, symbol: 'ETH', decimals: 18 },
        recipient: FRIEND,
        amountAtomic: '1',
      }),
    );
  });
});

describe('the kernel', () => {
  test('passes a declared gift, and the provider guard still checks the swap it follows', () => {
    const result = kernel(giftBatch(), { gift: { recipient: FRIEND, amountAtomic: MINIMUM } });
    assert.equal(result.verdict, 'allowed', result.blockedReason ?? '');
    const ids = result.checks.map((entry) => entry.id);
    assert.ok(ids.includes('gift_transfer_exact'));
    assert.equal(result.checks.find((entry) => entry.id === 'provider_guard_uniswap')?.status, 'passed');
  });

  test('an ordinary swap keeps exactly the checks it had', () => {
    const result = kernel(swapPart());
    assert.equal(result.verdict, 'allowed', result.blockedReason ?? '');
    assert.equal(result.checks.some((entry) => entry.id === 'gift_transfer_exact'), false);
  });

  test('a transfer nobody declared is refused three times over', () => {
    const result = kernel(giftBatch());
    assert.equal(result.verdict, 'blocked');
    const failed = result.checks.filter((entry) => entry.status === 'failed').map((entry) => entry.id);
    assert.deepEqual(failed.sort(), ['call_order_and_count', 'gift_transfer_exact', 'provider_guard_uniswap'].sort());
  });

  test('a declared gift with no transfer in the batch is refused', () => {
    const result = kernel(swapPart(), { gift: { recipient: FRIEND, amountAtomic: MINIMUM } });
    assert.equal(result.verdict, 'blocked');
    assert.match(result.blockedReason ?? '', /gift_transfer_missing/);
  });

  test('a gift sends exactly the guaranteed minimum — not a unit more, not a unit less', () => {
    for (const amountAtomic of ['44007', '44005']) {
      const result = kernel(giftBatch({ amountAtomic }), { gift: { recipient: FRIEND, amountAtomic } });
      assert.equal(result.verdict, 'blocked', amountAtomic);
      assert.match(result.blockedReason ?? '', /gift_amount_not_minimum/);
    }
    const noMinimum = kernel(giftBatch(), { gift: { recipient: FRIEND, amountAtomic: MINIMUM }, swapMinimumOutputAtomic: null });
    assert.match(noMinimum.blockedReason ?? '', /gift_amount_not_minimum/);
  });

  test('the recipient is someone else: not this wallet, the router, Permit2 or either token', () => {
    for (const recipient of [WALLET, ROUTER, PERMIT2, NVDA_BASE.address!, USDC_BASE.address!] as `0x${string}`[]) {
      const result = kernel(giftBatch({ recipient }), { gift: { recipient, amountAtomic: MINIMUM } });
      assert.equal(result.verdict, 'blocked', recipient);
      assert.match(result.blockedReason ?? '', /gift_recipient_invalid/);
    }
  });

  test('the transfer goes last, after the swap', () => {
    const [approve, permit, swap, transfer] = giftBatch();
    const reordered = [approve!, permit!, { ...transfer!, index: 2 }, { ...swap!, index: 3 }];
    const result = kernel(reordered, { gift: { recipient: FRIEND, amountAtomic: MINIMUM } });
    assert.equal(result.verdict, 'blocked');
  });

  test('the bytes decide, not the labels on the call', () => {
    const batch = giftBatch();
    const last = batch.at(-1)!;
    // Labels say FRIEND; the calldata pays someone else.
    const forged = { ...last, data: encodeGiftTransferV1('0x000000000000000000000000000000000000dEaD', MINIMUM) };
    const result = kernel([...batch.slice(0, -1), forged], { gift: { recipient: FRIEND, amountAtomic: MINIMUM } });
    assert.equal(result.verdict, 'blocked');
    assert.match(result.blockedReason ?? '', /gift_calldata_mismatch/);
    const other = validateGiftTransferV1({
      calls: [...batch.slice(0, -1), { ...last, to: USDC_BASE.address as `0x${string}` }],
      intent,
      walletAddress: WALLET,
      routerAddress: ROUTER,
      gift: { recipient: FRIEND, amountAtomic: MINIMUM },
      swapMinimumOutputAtomic: MINIMUM,
    });
    assert.deepEqual(other.ok ? null : other.code, 'gift_wrong_token');
  });
});

test('a gift recipient is part of the blueprint id, and an ordinary id is unchanged', () => {
  const base = {
    tenantId: 'tenant',
    walletAddress: WALLET,
    routeRunId: 'run-1',
    routeCardHash: `0x${'2'.repeat(64)}` as const,
    selectedCandidateHash: `0x${'3'.repeat(64)}` as const,
    requestId: 'req-1',
  };
  const plain = blueprintIdV1(base);
  assert.equal(blueprintIdV1({ ...base, giftRecipient: null }), plain);
  const gift = blueprintIdV1({ ...base, giftRecipient: FRIEND });
  assert.notEqual(gift, plain);
  assert.notEqual(blueprintIdV1({ ...base, giftRecipient: '0x1111111111111111111111111111111111111111' }), gift);
  assert.equal(blueprintIdV1({ ...base, giftRecipient: FRIEND.toUpperCase().replace('0X', '0x') as `0x${string}` }), gift);
});
