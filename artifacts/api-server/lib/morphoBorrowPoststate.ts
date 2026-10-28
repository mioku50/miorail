import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { stableHashV1 } from '@mioagent/route-domain';
import { SimulationObservationRequestV1Schema, SimulationObservationsV1Schema, type SimulationProviderRequestV1 } from '@mioagent/paid-intelligence';
import {
  morphoAfterBorrowV1, morphoHealthV1, morphoLiquidationPriceV1, toSharesDownV1, wMulDownV1,
  type MorphoHealthV1, type MorphoMarketStateV1, type MorphoMarketTotalsV1, type MorphoPositionV1,
} from '@mioagent/rwa-issuer/morphoBorrowMath';
import { erc20Abi, morphoAbi, morphoOracleAbi } from '@mioagent/still-engine/abi';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';

export interface MorphoBorrowPoststateIdentityV1 {
  marketId: string;
  walletAddress: string;
  loanTokenAddress: string;
  collateralTokenAddress: string;
  oracleAddress: string;
  /** Exact ERC-20 collateral the owner chose to pledge; zero means an
   * existing-collateral-only draw. Native ETH is never inferred here. */
  collateralSupplyAssets?: bigint;
}

export const MORPHO_BORROW_POSTSTATE_REFUSALS_V1 = [
  'poststate_inputs_invalid', 'poststate_observations_unread', 'poststate_binding_mismatch',
  'poststate_market_mismatch', 'poststate_position_mismatch', 'poststate_oracle_changed',
  'poststate_totals_mismatch', 'poststate_borrow_mismatch', 'poststate_funding_mismatch',
] as const;
export type MorphoBorrowPoststateRefusalV1 = typeof MORPHO_BORROW_POSTSTATE_REFUSALS_V1[number];
type RefusedV1 = { ok: false; refusal: MorphoBorrowPoststateRefusalV1; detail: string };
const refused = (refusal: MorphoBorrowPoststateRefusalV1, detail: string): RefusedV1 => ({ ok: false, refusal, detail });
const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const WAD = 10n ** 18n;
const address = (value: string): value is Address => /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);

/** Five fixed getters around the approved calls. These are observations in
 * the same evolving simulated state, never additional wallet transactions. */
export function buildMorphoBorrowPoststateProbesV1(input: MorphoBorrowPoststateIdentityV1):
  | { ok: true; observations: NonNullable<SimulationProviderRequestV1['observations']> }
  | RefusedV1 {
  const marketId = input.marketId.toLowerCase(), wallet = input.walletAddress.toLowerCase();
  const loan = input.loanTokenAddress.toLowerCase(), collateral = input.collateralTokenAddress.toLowerCase();
  const oracle = input.oracleAddress.toLowerCase();
  const supply = input.collateralSupplyAssets ?? 0n;
  const asset = CRYPTO.find((entry) => entry.token.toLowerCase() === collateral && entry.morphoMarket.toLowerCase() === marketId);
  if (!asset || !/^0x[0-9a-f]{64}$/.test(marketId) || !address(wallet) || !address(loan) || !address(collateral) ||
      !address(oracle) || loan !== ADDRESSES.usdc.toLowerCase() || typeof supply !== 'bigint' || supply < 0n || supply > UINT128_MAX) {
    return refused('poststate_inputs_invalid', 'The exact registered market, selected ERC-20 pledge and getter identities were not established.');
  }
  const id = marketId as Hex;
  const probes = [
    { id: 'market_params', to: ADDRESSES.morpho.toLowerCase(), data: encodeFunctionData({ abi: morphoAbi, functionName: 'idToMarketParams', args: [id] }) },
    { id: 'position', to: ADDRESSES.morpho.toLowerCase(), data: encodeFunctionData({ abi: morphoAbi, functionName: 'position', args: [id, wallet] }) },
    { id: 'market', to: ADDRESSES.morpho.toLowerCase(), data: encodeFunctionData({ abi: morphoAbi, functionName: 'market', args: [id] }) },
    { id: 'oracle_price', to: oracle, data: encodeFunctionData({ abi: morphoOracleAbi, functionName: 'price' }) },
    { id: 'collateral_wallet_balance', to: collateral, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }) },
  ];
  return { ok: true, observations: { before: probes, after: probes.map((probe) => ({ ...probe })) } };
}

interface MeasuredPositionV1 {
  market: MorphoMarketStateV1;
  position: MorphoPositionV1;
  health: MorphoHealthV1;
  liquidationPrice: bigint | null;
}
export type MorphoBorrowPoststateV1 =
  | { ok: true; before: MeasuredPositionV1; after: MeasuredPositionV1 }
  | RefusedV1;

type ParamsV1 = readonly [Address, Address, Address, Address, bigint];
type PositionV1 = readonly [bigint, bigint, bigint];
interface PhaseV1 { params: ParamsV1; position: PositionV1; totals: MorphoMarketTotalsV1; price: bigint; collateralWalletBalance: bigint }
const unsigned = (value: bigint, max: bigint): boolean => value >= 0n && value <= max;

function decodePhase(rows: ReadonlyMap<string, Hex>): PhaseV1 | null {
  try {
    // Every getter has a static ABI. Accepting trailing bytes would claim a
    // decoded answer without having established the entire return value.
    const exact = (id: string, words: number): Hex => {
      const value = rows.get(id);
      if (!value || !new RegExp(`^0x[0-9a-fA-F]{${words * 64}}$`).test(value)) throw new Error('getter_length');
      return value;
    };
    const paramsData = exact('market_params', 5);
    if (!/^0x(?:0{24}[0-9a-fA-F]{40}){4}[0-9a-fA-F]{64}$/.test(paramsData)) return null;
    const params = decodeFunctionResult({ abi: morphoAbi, functionName: 'idToMarketParams', data: paramsData });
    const position = decodeFunctionResult({ abi: morphoAbi, functionName: 'position', data: exact('position', 3) });
    const values = decodeFunctionResult({ abi: morphoAbi, functionName: 'market', data: exact('market', 6) });
    const price = decodeFunctionResult({ abi: morphoOracleAbi, functionName: 'price', data: exact('oracle_price', 1) });
    const collateralWalletBalance = decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: exact('collateral_wallet_balance', 1) });
    if (!values.every((value) => unsigned(value, UINT128_MAX)) || !unsigned(position[0], UINT256_MAX) ||
        !unsigned(position[1], UINT128_MAX) || !unsigned(position[2], UINT128_MAX) ||
        !unsigned(params[4], UINT256_MAX) || !unsigned(price, UINT256_MAX) || !unsigned(collateralWalletBalance, UINT256_MAX)) return null;
    return { params, position, price, collateralWalletBalance, totals: {
      totalSupplyAssets: values[0], totalSupplyShares: values[1], totalBorrowAssets: values[2],
      totalBorrowShares: values[3], lastUpdate: values[4], fee: values[5],
    } };
  } catch { return null; }
}

/** An unsigned venue batch must produce this wallet's exact debt change in
 * the same simulated state that proved its USDC arrival. A second eth_call
 * against the original chain would not be an after-state and is never used. */
export function verifyMorphoBorrowPoststateV1(input: {
  request: Pick<SimulationProviderRequestV1, 'chainId' | 'walletAddress' | 'callsHash' | 'observations'>;
  response: { blockNumber: number; observations?: unknown };
  expected: Omit<MorphoBorrowPoststateIdentityV1, 'walletAddress'> & {
    borrowAssets: bigint;
    position: MorphoPositionV1;
    blockNumber: number | null;
  };
}): MorphoBorrowPoststateV1 {
  const { expected, request, response } = input;
  const supply = expected.collateralSupplyAssets ?? 0n;
  const built = buildMorphoBorrowPoststateProbesV1({ ...expected, walletAddress: request.walletAddress });
  if (!built.ok) return built;
  if (request.chainId !== 8453 || !/^0x[0-9a-f]{64}$/i.test(request.callsHash) ||
      expected.borrowAssets <= 0n || expected.borrowAssets > UINT128_MAX ||
      !unsigned(expected.position.collateral, UINT128_MAX) || !unsigned(expected.position.borrowShares, UINT128_MAX) ||
      expected.position.collateral + supply > UINT128_MAX ||
      !Number.isSafeInteger(expected.blockNumber) || expected.blockNumber === null || expected.blockNumber <= 0 ||
      !Number.isSafeInteger(response.blockNumber) || response.blockNumber < expected.blockNumber) {
    return refused('poststate_inputs_invalid', 'The measured block, position or exact borrow amount was not established.');
  }
  const wanted = built.observations;
  const probeRequest = SimulationObservationRequestV1Schema.safeParse(request.observations);
  if (!probeRequest.success) return refused('poststate_binding_mismatch', 'The requested probes were not a bounded getter contract.');
  const normalized = (phase: 'before' | 'after') => probeRequest.data[phase].map(({ id, to, data }) => ({ id, to: to.toLowerCase(), data: data.toLowerCase() }));
  if (JSON.stringify(normalized('before')) !== JSON.stringify(wanted.before) || JSON.stringify(normalized('after')) !== JSON.stringify(wanted.after)) {
    return refused('poststate_binding_mismatch', 'The requested probes did not match the exact market and wallet.');
  }
  const observed = SimulationObservationsV1Schema.safeParse(response.observations);
  if (!observed.success) return refused('poststate_observations_unread', 'The simulation did not establish every before and after getter.');
  const requestHash = stableHashV1('simulation-observations/v1', {
    chainId: 8453, walletAddress: request.walletAddress.toLowerCase(), callsHash: request.callsHash,
    before: normalized('before'), after: normalized('after'),
  });
  if (observed.data.requestHash !== requestHash || observed.data.results.length !== wanted.before.length + wanted.after.length) {
    return refused('poststate_binding_mismatch', 'The simulated observations were not bound to these approved calls.');
  }
  const expectedRows = (['before', 'after'] as const).flatMap((phase) => wanted[phase].map((probe) => ({ ...probe, phase })));
  const phases = { before: new Map<string, Hex>(), after: new Map<string, Hex>() };
  for (const [index, row] of observed.data.results.entries()) {
    const target = expectedRows[index]!;
    if (row.phase !== target.phase || row.id !== target.id || row.to.toLowerCase() !== target.to || row.data.toLowerCase() !== target.data) {
      return refused('poststate_binding_mismatch', 'The simulation changed a getter identity or its order.');
    }
    phases[row.phase].set(row.id, row.returnData as Hex);
  }
  const before = decodePhase(phases.before), after = decodePhase(phases.after);
  if (!before || !after) return refused('poststate_observations_unread', 'A simulated getter was not a complete ABI answer.');
  const params = before.params;
  const marketId = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }], params,
  ));
  if (params[0].toLowerCase() !== expected.loanTokenAddress.toLowerCase() || params[1].toLowerCase() !== expected.collateralTokenAddress.toLowerCase() ||
      params[2].toLowerCase() !== expected.oracleAddress.toLowerCase() || params[4] <= 0n || params[4] > WAD ||
      marketId !== expected.marketId.toLowerCase() || JSON.stringify(params.map(String)) !== JSON.stringify(after.params.map(String))) {
    return refused('poststate_market_mismatch', 'The simulated immutable parameters did not match this registered market.');
  }
  if (before.price <= 0n || before.price !== after.price) return refused('poststate_oracle_changed', 'The market oracle changed within the simulated action or did not answer positively.');
  if (before.position[2] !== expected.position.collateral || before.position[1] !== expected.position.borrowShares ||
      after.position[2] !== before.position[2] + supply || after.position[0] !== before.position[0]) {
    return refused('poststate_position_mismatch', 'The simulated position did not establish only the selected collateral pledge and preserve this wallet’s measured supply shares.');
  }
  if (before.collateralWalletBalance < supply || after.collateralWalletBalance !== before.collateralWalletBalance - supply) {
    return refused('poststate_funding_mismatch', 'The simulated ERC-20 collateral debit did not equal the exact pledge chosen from this wallet’s balance.');
  }
  const pre = before.totals, post = after.totals;
  const interest = post.totalBorrowAssets - pre.totalBorrowAssets - expected.borrowAssets;
  const shareIncrease = after.position[1] - before.position[1];
  if (interest < 0n || post.totalSupplyAssets - pre.totalSupplyAssets !== interest ||
      post.lastUpdate < pre.lastUpdate || post.fee !== pre.fee || post.fee > WAD ||
      pre.totalBorrowAssets > pre.totalSupplyAssets || post.totalBorrowAssets > post.totalSupplyAssets ||
      before.position[1] > pre.totalBorrowShares || after.position[1] > post.totalBorrowShares ||
      shareIncrease <= 0n || post.totalBorrowShares - pre.totalBorrowShares !== shareIncrease) {
    return refused('poststate_totals_mismatch', 'The market totals did not establish only this exact new borrow and accrued interest.');
  }
  const feeAssets = wMulDownV1(interest, pre.fee);
  const feeShares = pre.fee === 0n ? 0n : toSharesDownV1(feeAssets, post.totalSupplyAssets - feeAssets, pre.totalSupplyShares);
  if (post.totalSupplyShares !== pre.totalSupplyShares + feeShares) {
    return refused('poststate_totals_mismatch', 'The market supply shares changed beyond measured interest fees.');
  }
  // borrow() accrues interest before minting debt shares. The after getter
  // measured those accrued totals; subtract only the exact requested draw,
  // then use the shared protocol projection rather than another debt formula.
  const beforeMarket: MorphoMarketStateV1 = {
    collateralPrice: before.price, lltvWad: params[4], totalSupplyAssets: post.totalSupplyAssets,
    totalBorrowAssets: post.totalBorrowAssets - expected.borrowAssets, totalBorrowShares: pre.totalBorrowShares,
    blockNumber: response.blockNumber,
  };
  const beforePosition: MorphoPositionV1 = { collateral: before.position[2], borrowShares: before.position[1] };
  const projected = morphoAfterBorrowV1({
    market: beforeMarket, position: { ...beforePosition, collateral: beforePosition.collateral + supply }, assets: expected.borrowAssets,
  });
  if (!projected || projected.position.borrowShares !== after.position[1]) {
    return refused('poststate_borrow_mismatch', 'The observed debt shares did not equal the protocol-rounded shares for the exact draw.');
  }
  const afterMarket: MorphoMarketStateV1 = { ...beforeMarket, totalBorrowAssets: post.totalBorrowAssets, totalBorrowShares: post.totalBorrowShares };
  const afterPosition: MorphoPositionV1 = { collateral: after.position[2], borrowShares: after.position[1] };
  const measured = (market: MorphoMarketStateV1, position: MorphoPositionV1): MeasuredPositionV1 => ({
    market, position, health: morphoHealthV1({ market, position }), liquidationPrice: morphoLiquidationPriceV1({ market, position }),
  });
  return { ok: true, before: measured(beforeMarket, beforePosition), after: measured(afterMarket, afterPosition) };
}
