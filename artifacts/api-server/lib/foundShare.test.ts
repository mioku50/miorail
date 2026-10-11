import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from 'viem';
import { InMemoryFoundShareRepositoryV1 } from '@mioagent/route-storage';

import { AERODROME_AERO_V1, type AerodromeClaimPlanV1 } from './aerodromeClaimReader.js';
import { InMemoryBaseMcpActionReceiptRepositoryV1 } from './baseMcpActionReceipts.js';
import type { UniswapCollectPlanV1 } from './baseMcpUniswapCollect.js';
import {
  aerodromeArrivedV1, foundCardSvgV1, foundCardV1, foundShareRuntimeV1, foundShareTextV1, makeFoundShareV1, uniswapArrivedV1,
} from './foundShare.js';
import { UNISWAP_V3_POSITION_MANAGER_V1 } from './uniswapFeesReader.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';
const GAUGE = '0x4444444444444444444444444444444444444444';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const HASH = `0x${'c'.repeat(64)}` as const;
const original = { ...foundShareRuntimeV1 };
afterEach(() => Object.assign(foundShareRuntimeV1, original));

const EVENTS = parseAbi([
  'event Claim(address indexed sender,address indexed recipient,uint256 amount0,uint256 amount1)',
  'event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)',
  'event ClaimRewards(address indexed from,uint256 amount)',
]);
function collectLog(tokenId: bigint, amount0: bigint, amount1: bigint, recipient = WALLET, address = UNISWAP_V3_POSITION_MANAGER_V1) {
  return { address, topics: encodeEventTopics({ abi: EVENTS, eventName: 'Collect', args: { tokenId } }) as Hex[],
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [recipient as Hex, amount0, amount1]) };
}
function chain(logs: ReturnType<typeof collectLog>[]) {
  return { transactionHash: HASH, status: 'success' as const, blockNumber: 37_123_456n, gasUsed: 1n, effectiveGasPriceWei: 1n, logs };
}
const call = (to: string) => ({ index: 0, callType: 'other' as const, to: to as Hex, valueWei: '0', data: '0x' as Hex,
  asset: null, amountAtomic: null, recipient: null, spender: null });
const collectPlan: UniswapCollectPlanV1 = { blockNumber: '100', positionsHeld: 2, positionsLeft: 0, calls: [
  { tokenId: '41', token0: WETH, token1: USDC, fee: 500, amount0: '1', amount1: '1', call: call(UNISWAP_V3_POSITION_MANAGER_V1) },
  { tokenId: '42', token0: WETH, token1: USDC, fee: 500, amount0: '1', amount1: '0', call: call(UNISWAP_V3_POSITION_MANAGER_V1) },
] };

test('what a collect paid comes from its own Collect events, per token, each once', () => {
  const arrived = uniswapArrivedV1(collectPlan, WALLET, chain([
    collectLog(41n, 3_000_000_000_000_000n, 1_530_000n),
    collectLog(42n, 1_200_000_000_000_000n, 0n),
    // Not ours: another recipient, another manager, an unknown position.
    collectLog(41n, 9n, 9n, OTHER), collectLog(42n, 9n, 9n, WALLET, POOL), collectLog(77n, 9n, 9n),
  ]));
  assert.deepEqual(arrived, [{ token: WETH, amountAtomic: 4_200_000_000_000_000n }, { token: USDC, amountAtomic: 1_530_000n }]);
});

test('what an Aerodrome claim paid: pool fees from Claim or Collect, AERO from ClaimRewards', () => {
  const plan = { calls: [
    { kind: 'basic_fees', pool: POOL, tokenId: '0', token0: WETH, token1: USDC, amount0: '1', amount1: '1', aero: '0', call: call(POOL) },
    { kind: 'basic_aero', pool: POOL, tokenId: '0', token0: WETH, token1: USDC, amount0: '0', amount1: '0', aero: '1', call: call(GAUGE) },
  ] } as unknown as AerodromeClaimPlanV1;
  const claim = { address: POOL, topics: encodeEventTopics({ abi: EVENTS, eventName: 'Claim', args: { sender: WALLET, recipient: WALLET } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [5n, 6n]) };
  const rewards = { address: GAUGE, topics: encodeEventTopics({ abi: EVENTS, eventName: 'ClaimRewards', args: { from: WALLET } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [7n]) };
  assert.deepEqual(aerodromeArrivedV1(plan, WALLET, chain([claim, rewards] as never)), [
    { token: WETH, amountAtomic: 5n }, { token: USDC, amountAtomic: 6n }, { token: AERODROME_AERO_V1, amountAtomic: 7n },
  ]);
  // A reward event from somewhere other than the call's own target pays nothing here.
  assert.deepEqual(aerodromeArrivedV1(plan, WALLET, chain([claim, { ...rewards, address: POOL }] as never)),
    [{ token: WETH, amountAtomic: 5n }, { token: USDC, amountAtomic: 6n }]);
});

async function completedReceipt(repository: InMemoryBaseMcpActionReceiptRepositoryV1, over: { status?: 'completed' | 'approval_required' } = {}) {
  const created = (await repository.create({ tenantId: 'tenant-a', walletAddress: WALLET, idempotencyKey: 'k', actionType: 'uniswap_collect',
    intent: { operation: 'collect', recipient: WALLET }, now: '2026-10-11T21:00:00.000Z' })).receipt;
  await repository.update({ id: created.id, tenantId: 'tenant-a', status: 'approval_required', reconciliationState: 'not_started',
    durableProof: { collectPlan }, now: '2026-10-11T21:00:01.000Z' });
  if (over.status === 'approval_required') return created.id;
  await repository.update({ id: created.id, tenantId: 'tenant-a', status: 'reconciling', reconciliationState: 'pending', now: '2026-10-11T21:01:00.000Z' });
  await repository.update({ id: created.id, tenantId: 'tenant-a', status: 'completed', reconciliationState: 'matched',
    transactionHash: HASH, blockNumber: '37123456', finalizedAt: '2026-10-11T21:02:00.000Z', now: '2026-10-11T21:02:00.000Z' });
  return created.id;
}

function setup() {
  const receipts = new InMemoryBaseMcpActionReceiptRepositoryV1();
  const shares = new InMemoryFoundShareRepositoryV1();
  let reads = 0;
  foundShareRuntimeV1.receipts = receipts;
  foundShareRuntimeV1.shares = () => shares;
  foundShareRuntimeV1.receiptReader = () => ({ getTransactionReceipt: async () => {
    reads += 1;
    return chain([collectLog(41n, 3_000_000_000_000_000n, 1_530_000n), collectLog(42n, 1_200_000_000_000_000n, 0n)]);
  } });
  foundShareRuntimeV1.value = async (token, amount) => ({ token, symbol: token === WETH ? 'WETH' : 'USDC', decimals: token === WETH ? 18 : 6,
    amountAtomic: amount.toString(), usdcAtomic: token === WETH ? '10000000' : amount.toString() });
  foundShareRuntimeV1.origin = () => 'https://miorail.xyz';
  foundShareRuntimeV1.now = () => new Date('2026-10-11T22:00:00.000Z');
  return { receipts, shares, reads: () => reads };
}

test('a completed collect becomes one card, from what arrived, for its owner only', async () => {
  const { receipts, reads } = setup();
  const id = await completedReceipt(receipts);
  const made = await makeFoundShareV1({ receiptId: id, tenantId: 'tenant-a', walletAddress: WALLET });
  assert.equal(made.ok, true);
  if (!made.ok) return;
  assert.equal(made.share.usdCents, 1_153);
  assert.deepEqual(made.share.tokens, [{ symbol: 'WETH', amount: '0.0042' }, { symbol: 'USDC', amount: '1.53' }]);
  assert.equal(made.share.blockNumber, '37123456');
  assert.equal(made.url, `https://miorail.xyz/found/${made.share.code}`);
  assert.equal(made.text, 'Collected $11.53 in Uniswap fees that were sitting in my wallet. Found with Miorail.');
  // A second click reads the same card back; the chain is not read again.
  const again = await makeFoundShareV1({ receiptId: id, tenantId: 'tenant-a', walletAddress: WALLET });
  assert.deepEqual(again.ok && again.share, made.share);
  assert.equal(reads(), 1);
  assert.deepEqual(await makeFoundShareV1({ receiptId: id, tenantId: 'tenant-b', walletAddress: WALLET }),
    { ok: false, status: 404, errorCode: 'found_share_receipt_not_found' });
  assert.deepEqual(await makeFoundShareV1({ receiptId: id, tenantId: 'tenant-a', walletAddress: OTHER }),
    { ok: false, status: 404, errorCode: 'found_share_receipt_not_found' });
});

test('no card before the receipt completed on its events, and none when the chain cannot be read', async () => {
  const { receipts } = setup();
  const waiting = await completedReceipt(receipts, { status: 'approval_required' });
  assert.deepEqual(await makeFoundShareV1({ receiptId: waiting, tenantId: 'tenant-a', walletAddress: WALLET }),
    { ok: false, status: 409, errorCode: 'found_share_not_completed' });
  const fresh = setup();
  const id = await completedReceipt(fresh.receipts);
  foundShareRuntimeV1.receiptReader = () => ({ getTransactionReceipt: async () => null });
  assert.deepEqual(await makeFoundShareV1({ receiptId: id, tenantId: 'tenant-a', walletAddress: WALLET }),
    { ok: false, status: 503, errorCode: 'found_share_receipt_unavailable' });
});

test('the card shows the amount, what arrived and the block, and names no wallet', () => {
  const share = { code: 'AbCdEfGhIjKl', receiptId: 'x', protocol: 'uniswap' as const, usdCents: 1_153,
    tokens: [{ symbol: 'WETH', amount: '0.0042' }, { symbol: 'USDC', amount: '1.53' }], blockNumber: '37123456', createdAt: '2026-10-11T22:00:00.000Z' };
  const card = foundCardV1(share);
  assert.equal(card.amount, '$11.53');
  assert.equal(card.footer, 'verified on Base · block 37,123,456 · found with miorail.xyz');
  assert.match(card.alt, /0\.0042 WETH, 1\.53 USDC/);
  for (const shape of ['link', 'embed'] as const) {
    const svg = foundCardSvgV1(card, shape);
    assert.match(svg, shape === 'link' ? /height="630"/ : /height="800"/);
    assert.match(svg, /\$11\.53/);
    assert.doesNotMatch(svg, /0x[0-9a-f]{6,}/i, 'no address or hash on the card');
  }
  assert.match(foundCardSvgV1(foundCardV1({ ...share, tokens: [{ symbol: '<b>&', amount: '1' }] })), /&lt;b&gt;&amp;/);
  assert.equal(foundShareTextV1({ protocol: 'aerodrome', usdCents: 738 }), 'Claimed $7.38 in Aerodrome fees and rewards that were sitting in my wallet. Found with Miorail.');
});
