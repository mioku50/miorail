import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Address } from 'viem';
import { morphoAccruedTotalsV1, toAssetsUpV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';
import { snapshot, universe, ok, reverted } from '../../../lib/still-engine/test/fixtures.js';
import { readRepayStandingV1, STILL_REPAY_BLUE_BUNDLES_RUNTIME_HASH_V1, type StillRepaySnapshotV1 } from './stillRepayStanding.js';

const WALLET = `0x${'1'.repeat(40)}` as Address;
const NOW = new Date('2026-10-28T18:00:00Z');
// Exact parameters publicly read from the registered Base market on 2026-10-28.
// Their hash is the registry id; the wallet and balances below are synthetic.
const PARAMS = {
  loanToken: ADDRESSES.usdc, collateralToken: ADDRESSES.cbbtc,
  oracle: '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9' as Address,
  irm: '0x46415998764C29aB2a25CbeA6254146D50D22687' as Address, lltv: 860_000_000_000_000_000n,
};
function fixture(): StillRepaySnapshotV1 {
  const s = snapshot({ wallet: { cbBTC: 200_000n }, morpho: { cbBTC: { collateral: 1_000_000n, borrowShares: 1_000_000n } } });
  const u = universe(); const known = u.morpho.find(row => row.ok && row.market.asset.id === 'cbBTC')!;
  assert(known.ok); known.market.params = { ...PARAMS };
  s.morpho.get('cbBTC')!.info.params = { ...PARAMS };
  s.balances.set(ADDRESSES.usdc.toLowerCase(), ok(4_000_000n));
  return { universe: u, snapshot: s, chainId: 8453, blueBundlesRuntimeHash: STILL_REPAY_BLUE_BUNDLES_RUNTIME_HASH_V1 };
}
const read = (f: StillRepaySnapshotV1) => readRepayStandingV1({ collateralTokenAddress: ADDRESSES.cbbtc, marketId: CRYPTO[0]!.morphoMarket, walletAddress: WALLET,
  deps: { now: () => NOW, snapshot: async address => { assert.equal(address, WALLET); return f; } } });

describe('Repay reads one exact registered market without borrowing gates', () => {
  it('retains exact params, block, debt shares, accrued debt, USDC and collateral balances', async () => {
    const f = fixture(); f.snapshot.block.timestamp += 3600n;
    const result = await read(f); assert.equal(result.state, 'read'); if (result.state !== 'read') return;
    const r = result.standing; const source = f.snapshot.morpho.get('cbBTC')!;
    assert(source.market.ok && source.borrowRatePerSecond.ok);
    const accrued = morphoAccruedTotalsV1(source.market.value, source.borrowRatePerSecond.value, f.snapshot.block.timestamp);
    assert.deepEqual(r.params, PARAMS); assert.deepEqual(r.position, { borrowShares: 1_000_000n, collateral: 1_000_000n });
    assert.equal(r.marketId, CRYPTO[0]!.morphoMarket); assert.equal(r.chainId, 8453); assert.equal(r.walletAddress, WALLET);
    assert.deepEqual(r.block, f.snapshot.block); assert.deepEqual(r.accruedTotals, accrued);
    assert.equal(r.debtAssets, toAssetsUpV1(1_000_000n, accrued.totalBorrowAssets, accrued.totalBorrowShares));
    assert.equal(r.walletLoanAssets, 4_000_000n); assert.equal(r.walletCollateralAssets, 200_000n);
    assert.equal(r.blueBundlesRuntimeHash, STILL_REPAY_BLUE_BUNDLES_RUNTIME_HASH_V1);
    assert.equal(result.readAt, NOW.toISOString());
  });
  it('permits repayment state with an unread oracle, no liquidity and debt above a new-loan limit', async () => {
    const f = fixture(); const source = f.snapshot.morpho.get('cbBTC')!;
    source.price = reverted(); source.position = ok({ collateral: 0n, borrowShares: 1_000_000n });
    assert(source.market.ok); source.market.value.totalSupplyAssets = source.market.value.totalBorrowAssets;
    const result = await read(f); assert.equal(result.state, 'read');
    if (result.state === 'read') assert.equal(result.standing.position.collateral, 0n);
  });
  it('keeps a confirmed zero debt as a read, rather than inventing repayment calls', async () => {
    const f = fixture(); f.snapshot.morpho.get('cbBTC')!.position = ok({ collateral: 0n, borrowShares: 0n });
    const result = await read(f); assert.equal(result.state, 'read');
    if (result.state === 'read') { assert.equal(result.standing.debtAssets, 0n); assert.equal(result.standing.position.borrowShares, 0n); }
  });
  for (const field of ['position', 'market', 'borrowRatePerSecond'] as const) {
    it(`does not substitute zero for an unread ${field}`, async () => {
      const f = fixture(); Object.assign(f.snapshot.morpho.get('cbBTC')!, { [field]: reverted() });
      const result = await read(f); assert.equal(result.state, 'refused'); assert.equal('standing' in result, false);
    });
  }
  for (const token of [ADDRESSES.usdc, ADDRESSES.cbbtc]) {
    it(`refuses unread wallet balance for ${token === ADDRESSES.usdc ? 'USDC' : 'collateral'}`, async () => {
      const f = fixture(); f.snapshot.balances.delete(token.toLowerCase());
      const result = await read(f); assert.equal(result.state, 'refused');
      if (result.state === 'refused') assert.equal(result.refusal, 'repay_balance_unread');
    });
  }
  for (const mutation of ['chain', 'runtime', 'market', 'loan', 'params', 'clock', 'shares', 'rate', 'fee'] as const) {
    it(`refuses inconsistent ${mutation} instead of treating it as no debt`, async () => {
      const f = fixture(); const source = f.snapshot.morpho.get('cbBTC')!;
      assert(source.market.ok && source.position.ok);
      if (mutation === 'chain') f.chainId = 1;
      if (mutation === 'runtime') f.blueBundlesRuntimeHash = `0x${'1'.repeat(64)}`;
      if (mutation === 'market') source.info.id = `0x${'1'.repeat(64)}`;
      if (mutation === 'loan') source.info.params.loanToken = ADDRESSES.weth;
      if (mutation === 'params') source.info.params.oracle = `0x${'3'.repeat(40)}`;
      if (mutation === 'clock') source.market.value.lastUpdate = f.snapshot.block.timestamp + 1n;
      if (mutation === 'shares') source.position.value.borrowShares = source.market.value.totalBorrowShares + 1n;
      if (mutation === 'rate') source.borrowRatePerSecond = ok(-1n);
      if (mutation === 'fee') source.market.value.fee = 10n ** 18n + 1n;
      assert.equal((await read(f)).state, 'refused');
    });
  }
  it('refuses arbitrary markets and invalid wallets before reading any state', async () => {
    let reads = 0;
    for (const patch of [{ marketId: `0x${'1'.repeat(64)}` }, { collateralTokenAddress: ADDRESSES.weth }, { walletAddress: null }, { walletAddress: `0x${'0'.repeat(40)}` }]) {
      const result = await readRepayStandingV1({ collateralTokenAddress: ADDRESSES.cbbtc, marketId: CRYPTO[0]!.morphoMarket, walletAddress: WALLET, ...patch,
        deps: { snapshot: async () => { reads++; return fixture(); } } });
      assert.equal(result.state, 'refused');
    }
    assert.equal(reads, 0);
  });
  it('does not expose provider failures or secrets in the refusal', async () => {
    const result = await readRepayStandingV1({ collateralTokenAddress: ADDRESSES.cbbtc, marketId: CRYPTO[0]!.morphoMarket, walletAddress: WALLET,
      deps: { snapshot: async () => { throw new Error('private provider credential'); } } });
    assert.equal(result.state, 'refused'); assert.doesNotMatch(JSON.stringify(result), /private provider credential/);
  });
});
