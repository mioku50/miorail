import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from 'viem';
import { stableHashV1 } from '@mioagent/route-domain';
import { morphoAfterBorrowV1, toSharesDownV1, wMulDownV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { erc20Abi, morphoAbi, morphoOracleAbi } from '@mioagent/still-engine/abi';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';
import {
  buildMorphoBorrowPoststateProbesV1, verifyMorphoBorrowPoststateV1,
  type MorphoBorrowPoststateRefusalV1,
} from './morphoBorrowPoststate.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const BLOCK = 53_100_000;
const ASK = 1_000_000n;
const PRICE = 10n ** 36n;
// Immutable public tuples read once on Base, 2026-10-28, and hashed to the
// registry ids. Tests never use a network or a real borrower's state. The
// prices, balances and debt below are deliberately synthetic fixtures.
const PARAMS = [
  [ADDRESSES.usdc, ADDRESSES.cbbtc, '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9', '0x46415998764C29aB2a25CbeA6254146D50D22687', 860_000_000_000_000_000n],
  [ADDRESSES.usdc, ADDRESSES.weth, '0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4', '0x46415998764C29aB2a25CbeA6254146D50D22687', 860_000_000_000_000_000n],
] as const;
interface RawPhaseV1 {
  params: [Address, Address, Address, Address, bigint];
  position: [bigint, bigint, bigint];
  market: [bigint, bigint, bigint, bigint, bigint, bigint];
  price: bigint;
  collateralWalletBalance: bigint;
}

function fixture(index = 0, fee = 0n, collateralSupplyAssets?: bigint) {
  const asset = CRYPTO[index]!;
  const params = [...PARAMS[index]!] as RawPhaseV1['params'];
  const identity = { marketId: asset.morphoMarket, walletAddress: WALLET, loanTokenAddress: ADDRESSES.usdc, collateralTokenAddress: asset.token, oracleAddress: params[2], collateralSupplyAssets };
  const built = buildMorphoBorrowPoststateProbesV1(identity);
  assert(built.ok);
  const request = { chainId: 8453 as const, walletAddress: WALLET, callsHash: `0x${'ab'.repeat(32)}`, observations: built.observations };
  const position = { collateral: 10_000_000n, borrowShares: 500_000_000_000n };
  const expected = { ...identity, borrowAssets: ASK, position, blockNumber: BLOCK };
  const before: RawPhaseV1 = {
    params, position: [123n, position.borrowShares, position.collateral],
    market: [10_000_000_000n, 10_000_000_000_000_000n, 5_000_000_000n, 5_000_000_000_000_000n, 1_700_000_000n, fee],
    price: PRICE,
    collateralWalletBalance: 20_000_000n,
  };
  const interest = 50_000n;
  const accruedMarket = { collateralPrice: PRICE, lltvWad: params[4], totalSupplyAssets: before.market[0] + interest,
    totalBorrowAssets: before.market[2] + interest, totalBorrowShares: before.market[3], blockNumber: BLOCK + 1 };
  const supply = collateralSupplyAssets ?? 0n;
  const projected = morphoAfterBorrowV1({ market: accruedMarket, position: { ...position, collateral: position.collateral + supply }, assets: ASK });
  assert(projected);
  const feeAssets = wMulDownV1(interest, fee);
  const feeShares = fee === 0n ? 0n : toSharesDownV1(feeAssets, accruedMarket.totalSupplyAssets - feeAssets, before.market[1]);
  const after: RawPhaseV1 = { params: [...params], price: PRICE,
    position: [123n, projected.position.borrowShares, position.collateral + supply],
    collateralWalletBalance: before.collateralWalletBalance - supply,
    market: [accruedMarket.totalSupplyAssets, before.market[1] + feeShares, accruedMarket.totalBorrowAssets + ASK,
      accruedMarket.totalBorrowShares + projected.position.borrowShares - position.borrowShares, before.market[4] + 1n, fee],
  };
  const response = () => ({
    blockNumber: BLOCK + 1,
    observations: {
      requestHash: stableHashV1('simulation-observations/v1', { chainId: 8453, walletAddress: WALLET, callsHash: request.callsHash,
        before: request.observations.before, after: request.observations.after }),
      results: (['before', 'after'] as const).flatMap((phase) => request.observations[phase].map((probe) => {
        const state = phase === 'before' ? before : after;
        const returnData = probe.id === 'market_params' ? encodeFunctionResult({ abi: morphoAbi, functionName: 'idToMarketParams', result: state.params })
          : probe.id === 'position' ? encodeFunctionResult({ abi: morphoAbi, functionName: 'position', result: state.position })
            : probe.id === 'market' ? encodeFunctionResult({ abi: morphoAbi, functionName: 'market', result: state.market })
              : probe.id === 'oracle_price' ? encodeFunctionResult({ abi: morphoOracleAbi, functionName: 'price', result: state.price })
                : encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: state.collateralWalletBalance });
        return { ...probe, phase, status: 'success' as const, returnData };
      })),
    },
  });
  return { before, after, request, expected, response, projected, accruedMarket, identity };
}

function refusal(input: Parameters<typeof verifyMorphoBorrowPoststateV1>[0], code: MorphoBorrowPoststateRefusalV1) {
  const result = verifyMorphoBorrowPoststateV1(input);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal, code);
  assert.equal('calls' in result, false);
  assert.equal('before' in result, false);
  assert.equal('after' in result, false);
}

describe('Morpho borrowing observes the exact evolving position', () => {
  for (const index of [0, 1]) {
    it(`uses five code-owned getters per phase for the ${index === 0 ? 'cbBTC' : 'WETH'} market`, () => {
      const f = fixture(index);
      assert.equal(f.request.observations.before.length, 5);
      assert.deepEqual(f.request.observations.before, f.request.observations.after);
      assert(f.request.observations.before.slice(0, 3).every((row) => row.to === ADDRESSES.morpho.toLowerCase()));
      assert.equal(f.request.observations.before[3]!.to, f.expected.oracleAddress.toLowerCase());
      const balance = f.request.observations.before[4]!;
      assert.equal(balance.to, f.expected.collateralTokenAddress.toLowerCase());
      const decoded = decodeFunctionData({ abi: erc20Abi, data: balance.data as Hex });
      assert.equal(decoded.functionName, 'balanceOf');
      assert.equal(decoded.args![0].toLowerCase(), WALLET);
      const result = verifyMorphoBorrowPoststateV1({ request: f.request, expected: f.expected, response: f.response() });
      assert(result.ok);
      assert.deepEqual(result.before.market, f.accruedMarket);
      assert.deepEqual(result.before.position, f.expected.position);
      assert.deepEqual(result.after.position, f.projected.position);
      assert.deepEqual(result.after.health, f.projected.health);
      assert.equal(result.after.liquidationPrice, f.projected.liquidationPrice);
      assert.equal('calls' in result, false);
    });
  }
  it('allows only protocol fee supply shares created by the observed accrued interest', () => {
    const f = fixture(0, 100_000_000_000_000_000n);
    const result = verifyMorphoBorrowPoststateV1({ request: f.request, expected: f.expected, response: f.response() });
    assert(result.ok);
    assert(f.after.market[1] > f.before.market[1]);
    assert.equal(result.after.position.collateral, f.before.position[2]);
  });
  for (const index of [0, 1]) {
    it(`proves the exact selected ${index === 0 ? 'cbBTC' : 'WETH'} ERC-20 pledge and its wallet debit`, () => {
      const supply = 5_000_000n;
      const f = fixture(index, 100_000_000_000_000_000n, supply);
      const result = verifyMorphoBorrowPoststateV1({ request: f.request, expected: f.expected, response: f.response() });
      assert(result.ok);
      assert.deepEqual(result.before.position, f.expected.position, 'before is the actual position before supplying collateral');
      assert.equal(result.after.position.collateral, f.expected.position.collateral + supply);
      assert.deepEqual(result.after.position, f.projected.position);
      assert.deepEqual(result.after.health, f.projected.health);
      assert.equal(f.before.collateralWalletBalance - f.after.collateralWalletBalance, supply);
      assert(f.after.market[1] > f.before.market[1], 'interest fee shares do not become collateral funding');
    });
  }
  it('allows an exact pledge of the entire selected ERC-20 balance', () => {
    const supply = 5_000_000n;
    const f = fixture(0, 0n, supply);
    f.before.collateralWalletBalance = supply;
    f.after.collateralWalletBalance = 0n;
    assert(verifyMorphoBorrowPoststateV1({ request: f.request, expected: f.expected, response: f.response() }).ok);
  });
  for (const [label, change, code] of [
    ['no consent to the observed pledge', (f: ReturnType<typeof fixture>) => { f.expected.collateralSupplyAssets = undefined; }, 'poststate_position_mismatch'],
    ['an unperformed selected pledge', (f: ReturnType<typeof fixture>) => { f.after.position[2] = f.before.position[2]; }, 'poststate_position_mismatch'],
    ['a larger pledge than selected', (f: ReturnType<typeof fixture>) => { f.after.position[2]++; }, 'poststate_position_mismatch'],
    ['a smaller pledge than selected', (f: ReturnType<typeof fixture>) => { f.after.position[2]--; }, 'poststate_position_mismatch'],
    ['a debit larger than selected', (f: ReturnType<typeof fixture>) => { f.after.collateralWalletBalance--; }, 'poststate_funding_mismatch'],
    ['a debit smaller than selected', (f: ReturnType<typeof fixture>) => { f.after.collateralWalletBalance++; }, 'poststate_funding_mismatch'],
    ['collateral supplied from somebody else', (f: ReturnType<typeof fixture>) => { f.after.collateralWalletBalance = f.before.collateralWalletBalance; }, 'poststate_funding_mismatch'],
    ['an insufficient wallet balance', (f: ReturnType<typeof fixture>) => { f.before.collateralWalletBalance = 4_999_999n; f.after.collateralWalletBalance = 0n; }, 'poststate_funding_mismatch'],
    ['a wallet supply-share movement during funding', (f: ReturnType<typeof fixture>) => { f.after.position[0]++; }, 'poststate_position_mismatch'],
    ['a changed price during funding', (f: ReturnType<typeof fixture>) => { f.after.price++; }, 'poststate_oracle_changed'],
    ['a changed immutable funding asset', (f: ReturnType<typeof fixture>) => { f.after.params[1] = ADDRESSES.weth; }, 'poststate_market_mismatch'],
  ] as const) {
    it(`refuses ${label}`, () => {
      const f = fixture(0, 0n, 5_000_000n); change(f);
      refusal({ request: f.request, expected: f.expected, response: f.response() }, code);
    });
  }
  it('does not permit an ERC-20 debit when no new collateral was selected', () => {
    const f = fixture();
    f.after.collateralWalletBalance--;
    refusal({ request: f.request, expected: f.expected, response: f.response() }, 'poststate_funding_mismatch');
  });
  for (const supply of [-1n, 1n << 128n]) {
    it(`refuses an out-of-range selected pledge (${supply < 0n ? 'negative' : 'uint128 overflow'})`, () => {
      const f = fixture();
      assert.equal(buildMorphoBorrowPoststateProbesV1({ ...f.identity, collateralSupplyAssets: supply }).ok, false);
      f.expected.collateralSupplyAssets = supply;
      refusal({ request: f.request, expected: f.expected, response: f.response() }, 'poststate_inputs_invalid');
    });
  }
  it('refuses a selected pledge that would overflow the stored collateral position', () => {
    const f = fixture();
    f.expected.collateralSupplyAssets = (1n << 128n) - 1n;
    refusal({ request: f.request, expected: f.expected, response: f.response() }, 'poststate_inputs_invalid');
  });
  for (const phase of ['before', 'after'] as const) {
    for (const kind of ['empty', 'truncated', 'trailing', 'missing'] as const) {
      it(`refuses an unread ${phase} collateral balance (${kind})`, () => {
        const f = fixture(0, 0n, 5_000_000n), response = f.response();
        const row = response.observations.results.find((entry) => entry.phase === phase && entry.id === 'collateral_wallet_balance')!;
        if (kind === 'missing') delete (row as { returnData?: Hex }).returnData;
        else row.returnData = (kind === 'empty' ? '0x' : kind === 'truncated' ? row.returnData.slice(0, -2) : `${row.returnData}${'0'.repeat(64)}`) as Hex;
        refusal({ request: f.request, expected: f.expected, response }, 'poststate_observations_unread');
      });
    }
  }
  it('binds the balance getter to the selected token and owner', () => {
    const f = fixture(0, 0n, 5_000_000n), response = f.response();
    const row = response.observations.results.find((entry) => entry.phase === 'before' && entry.id === 'collateral_wallet_balance')!;
    row.to = ADDRESSES.weth;
    refusal({ request: f.request, expected: f.expected, response }, 'poststate_binding_mismatch');
  });
  it('refuses an unregistered market rather than probing arbitrary client targets', () => {
    const f = fixture();
    assert.equal(buildMorphoBorrowPoststateProbesV1({ ...f.identity, marketId: `0x${'12'.repeat(32)}` }).ok, false);
    assert.equal(buildMorphoBorrowPoststateProbesV1({ ...f.identity, loanTokenAddress: ADDRESSES.weth }).ok, false);
    assert.equal(buildMorphoBorrowPoststateProbesV1({ ...f.identity, oracleAddress: `0x${'0'.repeat(40)}` }).ok, false);
  });
  for (const [label, mutate] of [
    ['zero ask', (f: ReturnType<typeof fixture>) => { f.expected.borrowAssets = 0n; }],
    ['negative ask', (f: ReturnType<typeof fixture>) => { f.expected.borrowAssets = -1n; }],
    ['unread block', (f: ReturnType<typeof fixture>) => { f.expected.blockNumber = 0; }],
    ['negative measured position', (f: ReturnType<typeof fixture>) => { f.expected.position.borrowShares = -1n; }],
  ] as const) {
    it(`refuses ${label}`, () => {
      const f = fixture(); mutate(f);
      refusal({ request: f.request, expected: f.expected, response: f.response() }, 'poststate_inputs_invalid');
    });
  }
  it('refuses a simulated block older than the position read', () => {
    const f = fixture(); const response = f.response(); response.blockNumber = BLOCK - 1;
    refusal({ request: f.request, expected: f.expected, response }, 'poststate_inputs_invalid');
  });
  it('refuses observations absent from a successful transfer-only simulation', () => {
    const f = fixture();
    refusal({ request: f.request, expected: f.expected, response: { blockNumber: BLOCK } }, 'poststate_observations_unread');
  });
  for (const [label, mutate] of [
    ['another calls hash', (r: ReturnType<ReturnType<typeof fixture>['response']>) => { r.observations.requestHash = `0x${'00'.repeat(32)}`; }],
    ['missing getter', (r: ReturnType<ReturnType<typeof fixture>['response']>) => { r.observations.results.pop(); }],
    ['another phase order', (r: ReturnType<ReturnType<typeof fixture>['response']>) => { [r.observations.results[0], r.observations.results[1]] = [r.observations.results[1]!, r.observations.results[0]!]; }],
    ['another target', (r: ReturnType<ReturnType<typeof fixture>['response']>) => { r.observations.results[0]!.to = ADDRESSES.weth; }],
    ['another calldata', (r: ReturnType<ReturnType<typeof fixture>['response']>) => { r.observations.results[0]!.data = '0x12345678'; }],
  ] as const) {
    it(`rejects ${label} in the observation binding`, () => {
      const f = fixture(); const response = f.response(); mutate(response);
      refusal({ request: f.request, expected: f.expected, response }, 'poststate_binding_mismatch');
    });
  }
  it('does not trust an internally consistent hash for a getter on a different wallet', () => {
    const f = fixture();
    const other = buildMorphoBorrowPoststateProbesV1({ ...f.identity, walletAddress: '0x2222222222222222222222222222222222222222' });
    assert(other.ok);
    f.request.observations = other.observations;
    refusal({ request: f.request, expected: f.expected, response: f.response() }, 'poststate_binding_mismatch');
  });
  for (const kind of ['truncated', 'trailing', 'empty', 'address_padding', 'uint128_overflow'] as const) {
    it(`refuses ${kind} getter return data`, () => {
      const f = fixture(); const response = f.response();
      const row = response.observations.results.find((entry) => entry.phase === 'before' && entry.id === (kind === 'uint128_overflow' ? 'market' : 'market_params'))!;
      row.returnData = (kind === 'truncated' ? row.returnData.slice(0, -2) : kind === 'trailing' ? `${row.returnData}${'0'.repeat(64)}`
        : kind === 'empty' ? '0x' : `0x1${row.returnData.slice(3)}`) as Hex;
      refusal({ request: f.request, expected: f.expected, response }, 'poststate_observations_unread');
    });
  }
  const changes: Array<[string, (f: ReturnType<typeof fixture>) => void, MorphoBorrowPoststateRefusalV1]> = [
    ['another immutable IRM', (f) => { f.before.params[3] = ADDRESSES.weth; f.after.params[3] = ADDRESSES.weth; }, 'poststate_market_mismatch'],
    ['changed LLTV', (f) => { f.after.params[4]--; }, 'poststate_market_mismatch'],
    ['another oracle contract', (f) => { f.before.params[2] = ADDRESSES.weth; f.after.params[2] = ADDRESSES.weth; }, 'poststate_market_mismatch'],
    ['changed oracle price', (f) => { f.after.price++; }, 'poststate_oracle_changed'],
    ['zero oracle price', (f) => { f.before.price = 0n; f.after.price = 0n; }, 'poststate_oracle_changed'],
    ['a changed initial collateral balance', (f) => { f.before.position[2]++; }, 'poststate_position_mismatch'],
    ['a changed initial debt position', (f) => { f.before.position[1]++; }, 'poststate_position_mismatch'],
    ['collateral withdrawal', (f) => { f.after.position[2]--; }, 'poststate_position_mismatch'],
    ['collateral supply without consent', (f) => { f.after.position[2]++; }, 'poststate_position_mismatch'],
    ['wallet supply share movement', (f) => { f.after.position[0]++; }, 'poststate_position_mismatch'],
    ['unmatched global debt share increase', (f) => { f.after.market[3]++; }, 'poststate_totals_mismatch'],
    ['different global interest deltas', (f) => { f.after.market[0]++; }, 'poststate_totals_mismatch'],
    ['borrow assets smaller than the ask', (f) => { f.after.market[2] = f.before.market[2]; }, 'poststate_totals_mismatch'],
    ['changed fee', (f) => { f.after.market[5] = 1n; }, 'poststate_totals_mismatch'],
    ['a backwards accrual clock', (f) => { f.after.market[4] = f.before.market[4] - 1n; }, 'poststate_totals_mismatch'],
    ['unaccounted global supply shares', (f) => { f.after.market[1]++; }, 'poststate_totals_mismatch'],
    ['borrow-share rounding disagreement', (f) => { f.after.position[1]++; f.after.market[3]++; }, 'poststate_borrow_mismatch'],
  ];
  for (const [label, mutate, code] of changes) {
    it(`refuses ${label}`, () => {
      const f = fixture(); mutate(f);
      refusal({ request: f.request, expected: f.expected, response: f.response() }, code);
    });
  }
});
