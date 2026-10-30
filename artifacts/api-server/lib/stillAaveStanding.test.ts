import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADDRESSES } from '@mioagent/still-engine/registry';
import { calendar } from '../../../lib/still-engine/test/fixtures.js';
import { aaveReadFixture, AAVE_TEST_WALLET } from './aaveV4BorrowFixtures.testhelper.js';
import { AAVE_V4_DEPLOYMENT_PIN_V1 } from './aaveV4BorrowPlan.js';
import { inspectAaveV4DeploymentAtV1, readAaveStandingV1, readAaveV4DeploymentAtV1, readStillAaveStandingV1, stillAaveCapacityV1, type AaveV4DeploymentProviderClientV1 } from './stillAaveStanding.js';

const input = (r = aaveReadFixture()) => ({ walletAddress: AAVE_TEST_WALLET, operation: 'borrow' as const, stockId: 'NVDAc' as const, collateralSupplyAssets: BigInt(0),
  deps: { now: () => new Date('2026-10-21T15:00:00Z'), snapshot: async () => r, calendar: async () => calendar() } });
describe('Still Aave bounded same-block standing', () => {
  it('counts only pledged/enabled stock and explicitly selected wallet supply', async () => {
    const base = input(), r = await readStillAaveStandingV1(base), extra = await readStillAaveStandingV1({ ...base, collateralSupplyAssets: BigInt(100_000_000) });
    assert.equal(r.state, 'read'); assert.equal(extra.state, 'read'); if (r.state !== 'read' || extra.state !== 'read') return;
    assert(r.standing.capacity!.limitAssets > BigInt(0));
    assert(extra.standing.capacity!.limitAssets > r.standing.capacity!.limitAssets);
    const unchanged = aaveReadFixture(); unchanged.snapshot.balances.set(ADDRESSES.cbbtc.toLowerCase(), { ok: true, value: BigInt(100_000_000_000) });
    const otherWallet = await readStillAaveStandingV1(input(unchanged)); assert.equal(otherWallet.state, 'read');
    if (otherWallet.state === 'read') assert.equal(otherWallet.standing.capacity!.limitAssets, r.standing.capacity!.limitAssets);
  });
  it('uses 40 percent for unread earnings and a closed-market window', () => {
    const r = aaveReadFixture(), common = { ...r, selectedStockId: 'NVDAc' as const, additionalCollateralAssets: BigInt(0) };
    const day = stillAaveCapacityV1({ ...common, calendar: calendar(), now: new Date('2026-10-21T15:00:00Z') });
    const unread = stillAaveCapacityV1({ ...common, calendar: { ok: false }, now: new Date('2026-10-21T15:00:00Z') });
    const weekend = stillAaveCapacityV1({ ...common, calendar: calendar(), now: new Date('2026-10-24T15:00:00Z') });
    assert.equal(day.shareBpsByStock.NVDAc, 5000); assert.equal(unread.shareBpsByStock.NVDAc, 4000); assert.equal(weekend.shareBpsByStock.NVDAc, 4000);
    assert(unread.limitAssets < day.limitAssets);
  });
  it('does not require a health factor, oracle or borrow allowance for repayment', async () => {
    const r = aaveReadFixture(); if (!r.snapshot.aave) throw Error('fixture');
    r.snapshot.aave.account = { ok: false, reason: 'reverted' };
    for (const reserve of r.snapshot.aave.reserves) reserve.price = { ok: false, reason: 'reverted' };
    const result = await readStillAaveStandingV1({ ...input(r), operation: 'repay' });
    assert.equal(result.state, 'read'); if (result.state === 'read') { assert.equal(result.standing.capacity, null); assert.equal(result.standing.debtAssets, BigInt(10_000_000)); }
  });
  it('refuses missing required balances, changed deployment and unknown reserves', async () => {
    const noUsdc = aaveReadFixture(); noUsdc.snapshot.balances.delete(ADDRESSES.usdc.toLowerCase());
    assert.equal((await readStillAaveStandingV1(input(noUsdc))).state, 'refused');
    const changed = aaveReadFixture(); changed.deployment.implementationAddress = ADDRESSES.usdc;
    assert.equal((await readStillAaveStandingV1(input(changed))).state, 'refused');
    const foreign = aaveReadFixture(); foreign.reserves[0]!.underlying = ADDRESSES.cbbtc;
    assert.equal((await readStillAaveStandingV1(input(foreign))).state, 'refused');
  });
  it('the address entry accepts an exact stock and USDC-only repayment', async () => {
    const r = aaveReadFixture(), base = input(r), stock = r.reserves.find(s => s.reserveId === 5)!;
    assert.equal((await readAaveStandingV1({ walletAddress: AAVE_TEST_WALLET, tokenAddress: stock.underlying, operation: 'borrow', deps: base.deps })).state, 'read');
    assert.equal((await readAaveStandingV1({ walletAddress: AAVE_TEST_WALLET, tokenAddress: ADDRESSES.usdc, operation: 'repay', deps: base.deps })).state, 'read');
    assert.equal((await readAaveStandingV1({ walletAddress: AAVE_TEST_WALLET, tokenAddress: ADDRESSES.cbbtc, operation: 'borrow', deps: base.deps })).state, 'refused');
  });
});

describe('Aave V4 simulation-block deployment verification diagnostics', () => {
  const BLOCK = 53_298_711;
  const PIN_SLOT = `0x000000000000000000000000${AAVE_V4_DEPLOYMENT_PIN_V1.implementation.slice(2)}` as const;
  const PROXY_BYTECODE = '0x6001' as const;
  const IMPL_BYTECODE = '0x6002' as const;
  const hashBytecode = (code: `0x${string}`) => {
    if (code === PROXY_BYTECODE) return AAVE_V4_DEPLOYMENT_PIN_V1.proxyCodeHash;
    if (code === IMPL_BYTECODE) return AAVE_V4_DEPLOYMENT_PIN_V1.implementationCodeHash;
    return `0x${'ff'.repeat(32)}`;
  };
  function makeClient(overrides: Partial<AaveV4DeploymentProviderClientV1> = {}): AaveV4DeploymentProviderClientV1 {
    return {
      async getChainId() { return 8453; },
      async getBlockNumber() { return BigInt(BLOCK); },
      async getStorageAt({ blockNumber }) {
        assert.equal(blockNumber, BigInt(BLOCK));
        return PIN_SLOT;
      },
      async getBytecode({ address, blockNumber }) {
        assert.equal(blockNumber, BigInt(BLOCK));
        return address.toLowerCase() === ADDRESSES.aaveSpoke.toLowerCase() ? PROXY_BYTECODE : IMPL_BYTECODE;
      },
      ...overrides,
    };
  }

  it('establishes matched deployment at the exact simulation block', async () => {
    const res = await inspectAaveV4DeploymentAtV1(BLOCK, { providers: [{ client: makeClient() }], hashBytecode, retryDelayMs: 0 });
    assert.equal(res.status, 'matched');
    assert.equal(res.deployment?.blockNumber, BLOCK);
    assert.equal(res.deployment?.implementationAddress.toLowerCase(), AAVE_V4_DEPLOYMENT_PIN_V1.implementation);
    const read = await readAaveV4DeploymentAtV1(BLOCK, { providers: [{ client: makeClient() }], hashBytecode, retryDelayMs: 0 });
    assert.equal(read?.blockNumber, BLOCK);
  });

  it('recovers when eth_simulateV1 returns block P+1 and the RPC catches up on bounded same-block retry', async () => {
    let storageCalls = 0;
    const queriedBlocks: bigint[] = [];
    const client = makeClient({
      async getBlockNumber() { return BigInt(storageCalls < 2 ? BLOCK - 1 : BLOCK); },
      async getStorageAt({ blockNumber }) {
        queriedBlocks.push(blockNumber);
        storageCalls++;
        if (storageCalls === 1) throw new Error('Requested resource not found.');
        return PIN_SLOT;
      },
    });
    const res = await inspectAaveV4DeploymentAtV1(BLOCK, { providers: [{ client }], hashBytecode, maxAttempts: 3, retryDelayMs: 0 });
    assert.equal(res.status, 'matched');
    assert.equal(storageCalls, 2);
    assert.deepEqual(queriedBlocks, [BigInt(BLOCK), BigInt(BLOCK)]);
  });

  it('fails closed with block_unavailable when the simulation block stays ahead of RPC providers', async () => {
    let attempts = 0;
    const client = makeClient({
      async getBlockNumber() { return BigInt(BLOCK - 1); },
      async getStorageAt() {
        attempts++;
        throw new Error('header not found');
      },
    });
    const res = await inspectAaveV4DeploymentAtV1(BLOCK, { providers: [{ client }], hashBytecode, maxAttempts: 3, retryDelayMs: 0 });
    assert.equal(res.status, 'block_unavailable');
    assert.equal(res.deployment, null);
    assert.equal(attempts, 3);
  });

  it('separates rpc_unavailable, slot_unreadable, implementation_mismatch and code_hash_mismatch without retrying state mismatches', async () => {
    const rpcErr = await inspectAaveV4DeploymentAtV1(BLOCK, {
      providers: [{ client: makeClient({ async getStorageAt() { throw new Error('socket hang up'); } }) }],
      hashBytecode, maxAttempts: 3, retryDelayMs: 0,
    });
    assert.equal(rpcErr.status, 'rpc_unavailable');

    let slotCalls = 0;
    const badSlot = await inspectAaveV4DeploymentAtV1(BLOCK, {
      providers: [{ client: makeClient({ async getStorageAt() { slotCalls++; return `0x${'00'.repeat(32)}`; } }) }],
      hashBytecode, maxAttempts: 3, retryDelayMs: 0,
    });
    assert.equal(badSlot.status, 'slot_unreadable');
    assert.equal(slotCalls, 1);

    let implCalls = 0;
    const wrongImpl = await inspectAaveV4DeploymentAtV1(BLOCK, {
      providers: [{ client: makeClient({ async getStorageAt() { implCalls++; return `0x000000000000000000000000${ADDRESSES.usdc.slice(2)}`; } }) }],
      hashBytecode, maxAttempts: 3, retryDelayMs: 0,
    });
    assert.equal(wrongImpl.status, 'implementation_mismatch');
    assert.equal(implCalls, 1);

    let hashCalls = 0;
    const wrongCode = await inspectAaveV4DeploymentAtV1(BLOCK, {
      providers: [{ client: makeClient({ async getBytecode({ address }) { hashCalls++; return address.toLowerCase() === ADDRESSES.aaveSpoke.toLowerCase() ? PROXY_BYTECODE : '0x6003'; } }) }],
      hashBytecode, maxAttempts: 3, retryDelayMs: 0,
    });
    assert.equal(wrongCode.status, 'code_hash_mismatch');
    assert.equal(hashCalls, 2);
  });
});
