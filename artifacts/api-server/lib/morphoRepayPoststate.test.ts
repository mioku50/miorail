import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeFunctionResult, type Address } from 'viem';
import { stableHashV1 } from '@mioagent/route-domain';
import { toSharesDownV1, wMulDownV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { erc20Abi, morphoAbi } from '@mioagent/still-engine/abi';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';
import { buildMorphoRepayProbesV1, verifyMorphoRepayPoststateV1 } from './morphoRepayPoststate.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const BLOCK = 53_100_000;
// Public immutable tuples, pinned by the registered market ids. Balances,
// shares and interest below are synthetic; no borrower or network is read.
const PARAMS = [
  [ADDRESSES.usdc, ADDRESSES.cbbtc, '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9', '0x46415998764C29aB2a25CbeA6254146D50D22687', 860_000_000_000_000_000n],
  [ADDRESSES.usdc, ADDRESSES.weth, '0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4', '0x46415998764C29aB2a25CbeA6254146D50D22687', 860_000_000_000_000_000n],
] as const;
interface Phase {
  params: [Address, Address, Address, Address, bigint]; position: [bigint, bigint, bigint];
  market: [bigint, bigint, bigint, bigint, bigint, bigint]; loanWallet: bigint; collateralWallet: bigint;
}
function fixture(index = 0, all = false, fee = 0n) {
  const asset = CRYPTO[index]!, params = [...PARAMS[index]!] as Phase['params'];
  const identity = { marketId: asset.morphoMarket, walletAddress: WALLET, loanTokenAddress: ADDRESSES.usdc, collateralTokenAddress: asset.token };
  const built = buildMorphoRepayProbesV1(identity); assert(built.ok);
  const request = { chainId: 8453 as const, walletAddress: WALLET, callsHash: `0x${'ab'.repeat(32)}`, observations: built.observations };
  // With virtual offsets the accrued share price here is exactly 1/1e6.
  const before: Phase = { params, position: [123n, 500_000_000_000n, 0n],
    market: [2_000_000n, 2_000_000_000_000n, 999_990n, 1_000_000_000_000n, 1_800_000_000n, fee],
    loanWallet: 1_000_000n, collateralWallet: 777n };
  const interest = 10n, repaidAssets = all ? 500_000n : 200_000n, repaidShares = repaidAssets * 1_000_000n;
  const feeAssets = wMulDownV1(interest, fee);
  const feeShares = fee === 0n ? 0n : toSharesDownV1(feeAssets, before.market[0] + interest - feeAssets, before.market[1]);
  const after: Phase = { params: [...params], position: [123n, before.position[1] - repaidShares, before.position[2]],
    market: [before.market[0] + interest, before.market[1] + feeShares, 1_000_000n - repaidAssets,
      before.market[3] - repaidShares, before.market[4] + 1n, fee],
    loanWallet: before.loanWallet - repaidAssets, collateralWallet: before.collateralWallet };
  const expected = { ...identity, amount: all ? { mode: 'all' as const } : { mode: 'assets' as const, assets: repaidAssets },
    maximumAssets: all ? 500_010n : repaidAssets, position: { collateral: before.position[2], borrowShares: before.position[1] }, blockNumber: BLOCK };
  const response = () => ({ blockNumber: BLOCK + 1, observations: {
    requestHash: stableHashV1('simulation-observations/v1', { chainId: 8453, walletAddress: WALLET, callsHash: request.callsHash,
      before: request.observations.before, after: request.observations.after }),
    results: (['before', 'after'] as const).flatMap(phase => request.observations[phase].map(probe => {
      const state = phase === 'before' ? before : after;
      const returnData = probe.id === 'market_params' ? encodeFunctionResult({ abi: morphoAbi, functionName: 'idToMarketParams', result: state.params })
        : probe.id === 'position' ? encodeFunctionResult({ abi: morphoAbi, functionName: 'position', result: state.position })
          : probe.id === 'market' ? encodeFunctionResult({ abi: morphoAbi, functionName: 'market', result: state.market })
            : encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: probe.id === 'loan_wallet_balance' ? state.loanWallet : state.collateralWallet });
      return { ...probe, phase, status: 'success' as const, returnData };
    })),
  } });
  const verify = () => verifyMorphoRepayPoststateV1({ request, expected, response: response() });
  return { before, after, expected, request, response, verify, repaidAssets, repaidShares };
}
function refuses(f: ReturnType<typeof fixture>) {
  const answer = f.verify(); assert.equal(answer.ok, false);
  assert.equal('calls' in answer, false); assert.equal('before' in answer, false); assert.equal('after' in answer, false);
}

describe('repayment proves the debt decrease in one evolving simulation', () => {
  for (const index of [0, 1]) for (const all of [false, true]) {
    it(`proves ${all ? 'full' : 'partial'} repayment in registered ${index === 0 ? 'cbBTC' : 'WETH'}`, () => {
      const f = fixture(index, all), answer = f.verify(); assert(answer.ok);
      assert.equal(answer.repaidAssets, f.repaidAssets);
      assert.equal(answer.repaidShares, f.repaidShares);
      assert.equal(answer.before.debtAssets, 500_000n);
      assert.equal(answer.after.debtAssets, all ? 0n : 300_000n);
      assert.equal(answer.after.position.collateral, 0n, 'repayment requires no positive collateral value');
      assert.equal(f.request.observations.before.length, 5);
      assert(f.request.observations.before.every(row => row.id !== 'oracle_price'));
    });
  }
  it('accepts only the supply shares earned by actual accrued interest fees', () => {
    const f = fixture(0, true, 100_000_000_000_000_000n);
    assert(f.after.market[1] > f.before.market[1]); assert(f.verify().ok);
  });
  it('does not use empty market liquidity or debt above supply to block repayment', () => {
    const f = fixture(); f.before.market[0] = 0n; f.after.market[0] = 10n;
    assert(f.verify().ok);
  });
  it('proves the protocol one-atom zero-floor full repayment edge', () => {
    const f = fixture(0, true);
    f.before.position[1] = 2_000_000n; f.expected.position.borrowShares = 2_000_000n;
    f.before.market[2] = 1n; f.before.market[3] = 2_000_000n;
    f.after.market[0] = f.before.market[0]; f.after.market[2] = 0n; f.after.market[3] = 0n;
    f.after.loanWallet = f.before.loanWallet - 2n;
    assert(f.verify().ok);
  });
  for (const [name, change] of [
    ['a larger debit', (f: ReturnType<typeof fixture>) => { f.after.loanWallet--; }],
    ['a smaller debit', (f: ReturnType<typeof fixture>) => { f.after.loanWallet++; }],
    ['no debit', (f: ReturnType<typeof fixture>) => { f.after.loanWallet = f.before.loanWallet; }],
    ['insufficient gross funding even when the net debit fits', (f: ReturnType<typeof fixture>) => { f.before.loanWallet = 500_000n; f.after.loanWallet = 0n; }],
    ['a loan-token credit', (f: ReturnType<typeof fixture>) => { f.after.loanWallet = f.before.loanWallet + 1n; }],
    ['withdrawn collateral', (f: ReturnType<typeof fixture>) => { f.before.position[2] = 1n; f.expected.position.collateral = 1n; }],
    ['new collateral', (f: ReturnType<typeof fixture>) => { f.after.position[2]++; }],
    ['changed collateral wallet balance', (f: ReturnType<typeof fixture>) => { f.after.collateralWallet++; }],
    ['new supply shares for the owner', (f: ReturnType<typeof fixture>) => { f.after.position[0]++; }],
    ['a stale owner position', (f: ReturnType<typeof fixture>) => { f.expected.position.borrowShares++; }],
    ['an unchanged owner debt', (f: ReturnType<typeof fixture>) => { f.after.position[1] = f.before.position[1]; }],
    ['a new owner debt', (f: ReturnType<typeof fixture>) => { f.after.position[1] = f.before.position[1] + 1n; }],
    ['one share left after all', (f: ReturnType<typeof fixture>) => { f.after.position[1] = 1n; f.after.market[3]++; }],
    ['a different global debt-share decrease', (f: ReturnType<typeof fixture>) => { f.after.market[3]--; }],
    ['a different global asset decrease', (f: ReturnType<typeof fixture>) => { f.after.market[2]--; }],
    ['a changed fee', (f: ReturnType<typeof fixture>) => { f.after.market[5]++; }],
    ['an unexpected supply-share change', (f: ReturnType<typeof fixture>) => { f.after.market[1]++; }],
    ['supply assets decreasing as an unrelated withdrawal', (f: ReturnType<typeof fixture>) => { f.after.market[0] = f.before.market[0] - 1n; }],
    ['a market clock moving backward', (f: ReturnType<typeof fixture>) => { f.after.market[4] = f.before.market[4] - 1n; }],
    ['different immutable parameters', (f: ReturnType<typeof fixture>) => { f.after.params[4]--; }],
    ['a different maximum', (f: ReturnType<typeof fixture>) => { f.expected.maximumAssets = 499_999n; }],
    ['a different requested mode or amount', (f: ReturnType<typeof fixture>) => { f.expected.amount = { mode: 'assets', assets: 499_999n }; }],
  ] as const) it(`refuses ${name}`, () => { const f = fixture(0, true); change(f); refuses(f); });

  for (const part of ['phase', 'id', 'to', 'data', 'returnData'] as const) it(`refuses a changed getter ${part}`, () => {
    const f = fixture(), response = f.response(), row = response.observations.results[0]!;
    if (part === 'phase') row.phase = 'after';
    else if (part === 'id') row.id = 'not_requested';
    else if (part === 'to') row.to = WALLET;
    else if (part === 'data') row.data = '0x12345678';
    else row.returnData = '0x';
    assert.equal(verifyMorphoRepayPoststateV1({ request: f.request, expected: f.expected, response }).ok, false);
  });
  it('refuses missing, duplicate or reordered observations and a different approved calls hash', () => {
    for (const which of ['missing', 'duplicate', 'reorder', 'hash'] as const) {
      const f = fixture(), response = f.response();
      if (which === 'missing') response.observations.results.pop();
      if (which === 'duplicate') response.observations.results[1] = { ...response.observations.results[0]! };
      if (which === 'reorder') response.observations.results.reverse();
      if (which === 'hash') f.request.callsHash = `0x${'cd'.repeat(32)}`;
      assert.equal(verifyMorphoRepayPoststateV1({ request: f.request, expected: f.expected, response }).ok, false);
    }
  });
  it('refuses a response from before the initial reading or a different chain', () => {
    const f = fixture(), response = f.response(); response.blockNumber = BLOCK - 1;
    assert.equal(verifyMorphoRepayPoststateV1({ request: f.request, expected: f.expected, response }).ok, false);
    const wrongChain = { ...f.request, chainId: 1 as 8453 };
    assert.equal(verifyMorphoRepayPoststateV1({ request: wrongChain, expected: f.expected, response: f.response() }).ok, false);
  });
  it('binds the requested getter wallet and registered collateral, not only the returned numbers', () => {
    const f = fixture(); f.request.walletAddress = '0x2222222222222222222222222222222222222222'; refuses(f);
    const bad = buildMorphoRepayProbesV1({ ...fixture().expected, walletAddress: WALLET, collateralTokenAddress: WALLET });
    assert.equal(bad.ok, false);
  });
  it('rejects trailing return bytes instead of accepting a partial ABI reading', () => {
    const f = fixture(), response = f.response(); response.observations.results[0]!.returnData += '00'.repeat(32);
    assert.equal(verifyMorphoRepayPoststateV1({ request: f.request, expected: f.expected, response }).ok, false);
  });
});
