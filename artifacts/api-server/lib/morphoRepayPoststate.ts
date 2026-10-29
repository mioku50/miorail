import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { stableHashV1 } from '@mioagent/route-domain';
import { SimulationObservationRequestV1Schema, SimulationObservationsV1Schema, type SimulationProviderRequestV1 } from '@mioagent/paid-intelligence';
import { toAssetsUpV1, toSharesDownV1, wMulDownV1, type MorphoMarketTotalsV1, type MorphoPositionV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { morphoRepayProjectionV1, type MorphoRepayAmountV1 } from '@mioagent/rwa-issuer/morphoRepayMath';
import { erc20Abi, morphoAbi } from '@mioagent/still-engine/abi';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';

export interface MorphoRepayIdentityV1 {
  marketId: string;
  walletAddress: string;
  loanTokenAddress: string;
  collateralTokenAddress: string;
}
type RefusalV1 = 'repay_inputs_invalid' | 'repay_observations_unread' | 'repay_binding_mismatch' |
  'repay_market_mismatch' | 'repay_position_mismatch' | 'repay_funding_mismatch' | 'repay_totals_mismatch' | 'repay_amount_mismatch';
type RefusedV1 = { ok: false; refusal: RefusalV1; detail: string };
const fail = (refusal: RefusalV1, detail: string): RefusedV1 => ({ ok: false, refusal, detail });
const UINT128_MAX = (1n << 128n) - 1n;
const WAD = 10n ** 18n;
const address = (value: string): value is Address => /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const uint128 = (value: bigint): boolean => typeof value === 'bigint' && value >= 0n && value <= UINT128_MAX;

/** Repayment needs no price or health threshold. These five same-state getters
 * establish the owner's debt, preserved collateral and exact USDC debit. */
export function buildMorphoRepayProbesV1(input: MorphoRepayIdentityV1):
  | { ok: true; observations: NonNullable<SimulationProviderRequestV1['observations']> }
  | RefusedV1 {
  const marketId = input.marketId.toLowerCase(), wallet = input.walletAddress.toLowerCase();
  const loan = input.loanTokenAddress.toLowerCase(), collateral = input.collateralTokenAddress.toLowerCase();
  if (!CRYPTO.some(row => row.token.toLowerCase() === collateral && row.morphoMarket.toLowerCase() === marketId) ||
      !/^0x[0-9a-f]{64}$/.test(marketId) || !address(wallet) || !address(loan) || !address(collateral) ||
      loan !== ADDRESSES.usdc.toLowerCase()) return fail('repay_inputs_invalid', 'The registered market and exact repayment wallet were not established.');
  const id = marketId as Hex;
  const probes = [
    { id: 'market_params', to: ADDRESSES.morpho.toLowerCase(), data: encodeFunctionData({ abi: morphoAbi, functionName: 'idToMarketParams', args: [id] }) },
    { id: 'position', to: ADDRESSES.morpho.toLowerCase(), data: encodeFunctionData({ abi: morphoAbi, functionName: 'position', args: [id, wallet] }) },
    { id: 'market', to: ADDRESSES.morpho.toLowerCase(), data: encodeFunctionData({ abi: morphoAbi, functionName: 'market', args: [id] }) },
    { id: 'loan_wallet_balance', to: loan, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }) },
    { id: 'collateral_wallet_balance', to: collateral, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }) },
  ];
  return { ok: true, observations: { before: probes, after: probes.map(row => ({ ...row })) } };
}

interface PhaseV1 {
  params: readonly [Address, Address, Address, Address, bigint];
  position: readonly [bigint, bigint, bigint];
  totals: MorphoMarketTotalsV1;
  loanWallet: bigint;
  collateralWallet: bigint;
}
function decodePhaseV1(rows: ReadonlyMap<string, Hex>): PhaseV1 | null {
  try {
    const exact = (id: string, words: number): Hex => {
      const data = rows.get(id);
      if (!data || !new RegExp(`^0x[0-9a-fA-F]{${words * 64}}$`).test(data)) throw new Error('getter_length');
      return data;
    };
    const paramsData = exact('market_params', 5);
    if (!/^0x(?:0{24}[0-9a-fA-F]{40}){4}[0-9a-fA-F]{64}$/.test(paramsData)) return null;
    const params = decodeFunctionResult({ abi: morphoAbi, functionName: 'idToMarketParams', data: paramsData });
    const position = decodeFunctionResult({ abi: morphoAbi, functionName: 'position', data: exact('position', 3) });
    const values = decodeFunctionResult({ abi: morphoAbi, functionName: 'market', data: exact('market', 6) });
    if (!values.every(uint128) || !uint128(position[1]) || !uint128(position[2])) return null;
    return { params, position, totals: {
      totalSupplyAssets: values[0], totalSupplyShares: values[1], totalBorrowAssets: values[2], totalBorrowShares: values[3], lastUpdate: values[4], fee: values[5],
    }, loanWallet: decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: exact('loan_wallet_balance', 1) }),
    collateralWallet: decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: exact('collateral_wallet_balance', 1) }) };
  } catch { return null; }
}

export type MorphoRepayPoststateV1 = RefusedV1 | {
  ok: true;
  repaidAssets: bigint;
  repaidShares: bigint;
  before: { position: MorphoPositionV1; totals: MorphoMarketTotalsV1; debtAssets: bigint };
  after: { position: MorphoPositionV1; totals: MorphoMarketTotalsV1; debtAssets: bigint };
};

/** Proof of a repayment in the very simulation that executes the approved
 * wallet calls. Fresh eth_call reads against the original chain are not an
 * after-state. There is deliberately no Still borrowing-cap or oracle gate. */
export function verifyMorphoRepayPoststateV1(input: {
  request: Pick<SimulationProviderRequestV1, 'chainId' | 'walletAddress' | 'callsHash' | 'observations'>;
  response: { blockNumber: number; observations?: unknown };
  expected: Omit<MorphoRepayIdentityV1, 'walletAddress'> & {
    amount: MorphoRepayAmountV1;
    maximumAssets: bigint;
    position: MorphoPositionV1;
    blockNumber: number;
  };
}): MorphoRepayPoststateV1 {
  const { request, response, expected } = input;
  const built = buildMorphoRepayProbesV1({ ...expected, walletAddress: request.walletAddress });
  if (!built.ok) return built;
  if (request.chainId !== 8453 || !/^0x[0-9a-f]{64}$/i.test(request.callsHash) ||
      !uint128(expected.maximumAssets) || expected.maximumAssets === 0n || !uint128(expected.position.collateral) ||
      !uint128(expected.position.borrowShares) || expected.position.borrowShares === 0n ||
      !Number.isSafeInteger(expected.blockNumber) || expected.blockNumber <= 0 || !Number.isSafeInteger(response.blockNumber) ||
      response.blockNumber < expected.blockNumber) return fail('repay_inputs_invalid', 'The exact repayment maximum, debt and reading block were not established.');
  const probes = SimulationObservationRequestV1Schema.safeParse(request.observations);
  if (!probes.success) return fail('repay_binding_mismatch', 'The requested before and after getters were not bounded.');
  const normalized = (phase: 'before' | 'after') => probes.data[phase].map(({ id, to, data }) => ({ id, to: to.toLowerCase(), data: data.toLowerCase() }));
  if (JSON.stringify(normalized('before')) !== JSON.stringify(built.observations.before) ||
      JSON.stringify(normalized('after')) !== JSON.stringify(built.observations.after)) return fail('repay_binding_mismatch', 'The getter identities do not match this wallet and market.');
  const observed = SimulationObservationsV1Schema.safeParse(response.observations);
  if (!observed.success) return fail('repay_observations_unread', 'The simulation did not establish every required repayment getter.');
  const requestHash = stableHashV1('simulation-observations/v1', {
    chainId: 8453, walletAddress: request.walletAddress.toLowerCase(), callsHash: request.callsHash,
    before: normalized('before'), after: normalized('after'),
  });
  const wanted = (['before', 'after'] as const).flatMap(phase => built.observations[phase].map(row => ({ ...row, phase })));
  if (observed.data.requestHash !== requestHash || observed.data.results.length !== wanted.length) return fail('repay_binding_mismatch', 'The observations were not bound to the approved repayment calls.');
  const phases = { before: new Map<string, Hex>(), after: new Map<string, Hex>() };
  for (const [index, row] of observed.data.results.entries()) {
    const target = wanted[index]!;
    if (row.phase !== target.phase || row.id !== target.id || row.to.toLowerCase() !== target.to || row.data.toLowerCase() !== target.data) {
      return fail('repay_binding_mismatch', 'A repayment getter identity or order changed.');
    }
    phases[row.phase].set(row.id, row.returnData as Hex);
  }
  const before = decodePhaseV1(phases.before), after = decodePhaseV1(phases.after);
  if (!before || !after) return fail('repay_observations_unread', 'A repayment getter was not a complete ABI answer.');
  const params = before.params;
  const marketId = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }], params,
  ));
  if (marketId !== expected.marketId.toLowerCase() || params[0].toLowerCase() !== expected.loanTokenAddress.toLowerCase() ||
      params[1].toLowerCase() !== expected.collateralTokenAddress.toLowerCase() || params[4] <= 0n || params[4] > WAD ||
      JSON.stringify(params.map(String)) !== JSON.stringify(after.params.map(String))) return fail('repay_market_mismatch', 'The immutable parameters do not match this registered repayment market.');
  if (before.position[2] !== expected.position.collateral || before.position[1] !== expected.position.borrowShares ||
      after.position[2] !== before.position[2] || after.position[0] !== before.position[0] ||
      after.position[1] >= before.position[1]) return fail('repay_position_mismatch', 'The simulated debt did not decrease while preserving collateral and supply shares.');
  const repaidAssets = before.loanWallet - after.loanWallet;
  if (repaidAssets <= 0n || repaidAssets > expected.maximumAssets || before.loanWallet < expected.maximumAssets ||
      before.collateralWallet !== after.collateralWallet) return fail('repay_funding_mismatch', 'The exact USDC debit, funding maximum or unchanged wallet collateral was not established.');
  const pre = before.totals, post = after.totals;
  const interest = post.totalSupplyAssets - pre.totalSupplyAssets;
  const repaidShares = before.position[1] - after.position[1];
  const accruedBorrowAssets = pre.totalBorrowAssets + interest;
  if (interest < 0n || !uint128(accruedBorrowAssets) || post.lastUpdate < pre.lastUpdate || post.fee !== pre.fee || post.fee > WAD ||
      before.position[1] > pre.totalBorrowShares || after.position[1] > post.totalBorrowShares ||
      pre.totalBorrowShares - post.totalBorrowShares !== repaidShares) return fail('repay_totals_mismatch', 'The market did not establish only this repayment and accrued interest.');
  const feeAssets = wMulDownV1(interest, pre.fee);
  const feeShares = pre.fee === 0n ? 0n : toSharesDownV1(feeAssets, post.totalSupplyAssets - feeAssets, pre.totalSupplyShares);
  if (post.totalSupplyShares !== pre.totalSupplyShares + feeShares) return fail('repay_totals_mismatch', 'Supply shares changed beyond measured interest fees.');
  const accrued: MorphoMarketTotalsV1 = { ...pre, totalBorrowAssets: accruedBorrowAssets,
    totalSupplyAssets: post.totalSupplyAssets, totalSupplyShares: post.totalSupplyShares, lastUpdate: post.lastUpdate };
  const beforePosition: MorphoPositionV1 = { collateral: before.position[2], borrowShares: before.position[1] };
  const projected = morphoRepayProjectionV1({ totals: accrued, position: beforePosition, amount: expected.amount, maximumAssets: expected.maximumAssets });
  if (!projected.ok || projected.repaidAssets !== repaidAssets || projected.repaidShares !== repaidShares ||
      projected.position.borrowShares !== after.position[1] || projected.totals.totalBorrowShares !== post.totalBorrowShares ||
      projected.totals.totalBorrowAssets !== post.totalBorrowAssets) return fail('repay_amount_mismatch', 'The observed debit and debt shares do not equal the exact requested repayment.');
  const debt = (p: MorphoPositionV1, t: MorphoMarketTotalsV1) => toAssetsUpV1(p.borrowShares, t.totalBorrowAssets, t.totalBorrowShares);
  return { ok: true, repaidAssets, repaidShares,
    before: { position: beforePosition, totals: accrued, debtAssets: debt(beforePosition, accrued) },
    after: { position: projected.position, totals: post, debtAssets: debt(projected.position, post) } };
}
