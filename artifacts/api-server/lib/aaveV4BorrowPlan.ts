import { encodeFunctionData, isAddress, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import type { ExecutionCallV1 } from '@mioagent/route-domain';
import { ADDRESSES, STOCKS, type StockId } from '@mioagent/still-engine/registry';
import type { MorphoPlanStepV1 } from '@mioagent/rwa-issuer/morphoBorrowPlan';

// Checked against EIP-1967 storage and Sourcify's verified deployed runtime at
// Base block 53217738 on 2026-10-28. These are the V4 Spoke's DIRECT methods;
// V3 Pool calls and position-manager/router grants are deliberately excluded.
// The server reads code + the implementation slot at the standing's block.
export const AAVE_V4_DEPLOYMENT_PIN_V1 = {
  implementation: '0x81a73c282faa932de3b2541cee19549f4bf13b19',
  implementationCodeHash: '0x919242697bc12c3081610e470b50011f50312fedd852ea04282a1ee5294c3881',
  proxyCodeHash: '0x57db7d2196b3603cef54f6fdeae8332584be1e54b2bd9c2a7c827a89f5482e61',
  implementationSlot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
} as const;

export const aaveV4WriteAbiV1 = parseAbi([
  'function supply(uint256 reserveId,uint256 amount,address onBehalfOf) returns (uint256,uint256)',
  'function setUsingAsCollateral(uint256 reserveId,bool usingAsCollateral,address onBehalfOf)',
  'function borrow(uint256 reserveId,uint256 amount,address onBehalfOf) returns (uint256,uint256)',
  'function repay(uint256 reserveId,uint256 amount,address onBehalfOf) returns (uint256,uint256)',
]);
export const aaveV4ExecutionEventAbiV1 = parseAbi([
  'event Borrow(uint256 indexed reserveId,address indexed caller,address indexed user,uint256 drawnShares,uint256 drawnAmount)',
  'event Repay(uint256 indexed reserveId,address indexed caller,address indexed user,uint256 drawnShares,uint256 totalAmountRepaid,(int256 sharesDelta,int256 offsetRayDelta,uint256 restoredPremiumRay) premiumDelta)',
  'event Supply(uint256 indexed reserveId,address indexed caller,address indexed user,uint256 suppliedShares,uint256 suppliedAmount)',
  'event SetUsingAsCollateral(uint256 indexed reserveId,address indexed caller,address indexed user,bool usingAsCollateral)',
]);
const approvalAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
const MAX = (BigInt(1) << BigInt(256)) - BigInt(1);

export interface AaveV4DeploymentReadV1 {
  chainId: number;
  blockNumber: number;
  implementationAddress: string;
  implementationCodeHash: string;
  proxyCodeHash: string;
}

export type AaveV4DeploymentStatusV1 =
  | 'matched'
  | 'rpc_unavailable'
  | 'block_unavailable'
  | 'slot_unreadable'
  | 'implementation_mismatch'
  | 'code_hash_mismatch';

export function classifyAaveV4DeploymentReadV1(expectedBlockNumber: number, value: AaveV4DeploymentReadV1 | null): AaveV4DeploymentStatusV1 {
  if (!value || value.chainId !== 8453 || !Number.isSafeInteger(value.blockNumber) || value.blockNumber <= 0) return 'rpc_unavailable';
  if (!Number.isSafeInteger(expectedBlockNumber) || expectedBlockNumber <= 0 || value.blockNumber !== expectedBlockNumber) return 'block_unavailable';
  if (value.implementationAddress.toLowerCase() !== AAVE_V4_DEPLOYMENT_PIN_V1.implementation) return 'implementation_mismatch';
  if (value.implementationCodeHash.toLowerCase() !== AAVE_V4_DEPLOYMENT_PIN_V1.implementationCodeHash ||
      value.proxyCodeHash.toLowerCase() !== AAVE_V4_DEPLOYMENT_PIN_V1.proxyCodeHash) return 'code_hash_mismatch';
  return 'matched';
}

export function matchesAaveV4DeploymentV1(value: AaveV4DeploymentReadV1): boolean {
  return classifyAaveV4DeploymentReadV1(value.blockNumber, value) === 'matched';
}

/** Identity comes from the registered Spoke's getReserve at the same read block. */
export interface AaveV4ReserveBindingV1 {
  reserveId: number;
  underlying: string;
  hub: string;
  hubAssetId: number;
  decimals: number;
  dynamicConfigKey: number;
}

export interface AaveV4BorrowPlanInputV1 {
  walletAddress: string;
  stockId: StockId;
  collateralReserve: AaveV4ReserveBindingV1;
  loanReserve: AaveV4ReserveBindingV1;
  collateralSupplyAssets: bigint;
  borrowAssets: bigint;
  walletCollateralAssets: bigint;
  existingSuppliedAssets: bigint;
  collateralAlreadyEnabled: boolean;
  deployment: AaveV4DeploymentReadV1;
}

export interface AaveV4PreparedPlanV1 {
  operation: 'borrow' | 'repay';
  calls: readonly ExecutionCallV1[];
  steps: readonly MorphoPlanStepV1[];
  authorizations: readonly [];
  targets: readonly string[];
  venueSimulation: null;
  forceAtomic: true;
}
export type AaveV4PlanResultV1 =
  | { ok: true; plan: AaveV4PreparedPlanV1 }
  | { ok: false; refusal: 'aave_inputs_invalid' | 'aave_reserve_mismatch' | 'aave_deployment_changed' | 'aave_funding_insufficient' | 'aave_calls_mismatch'; detail: string };

function uint(value: bigint, positive = false): boolean {
  return typeof value === 'bigint' && value >= (positive ? BigInt(1) : BigInt(0)) && value <= MAX;
}
const address = (value: string): value is Address => isAddress(value, { strict: false }) && value.toLowerCase() !== zeroAddress;
const number = (value: number, max = 255): boolean => Number.isSafeInteger(value) && value >= 0 && value <= max;
function binding(value: AaveV4ReserveBindingV1, token: string, decimals: number): boolean {
  return number(value.reserveId) && number(value.hubAssetId, 65535) && number(value.dynamicConfigKey, 4294967295) &&
    value.underlying.toLowerCase() === token.toLowerCase() && value.hub.toLowerCase() === ADDRESSES.aaveHub.toLowerCase() && value.decimals === decimals;
}
const invalid = (detail: string): AaveV4PlanResultV1 => ({ ok: false, refusal: 'aave_inputs_invalid', detail });

function assembler(operation: 'borrow' | 'repay') {
  const calls: ExecutionCallV1[] = [], steps: MorphoPlanStepV1[] = [];
  function push(to: string, data: Hex, callType: ExecutionCallV1['callType'], amount: bigint | null, recipient: string | null, spender: string | null, reading: string) {
    const index = calls.length;
    calls.push({ index, to: to.toLowerCase() as Address, data, valueWei: '0', callType, asset: null,
      amountAtomic: amount?.toString() ?? null, recipient: recipient ? recipient.toLowerCase() as Address : null, spender: spender ? spender.toLowerCase() as Address : null });
    steps.push({ index, to: to.toLowerCase(), selector: data.slice(0, 10), venueDescription: null, decodedByMiorail: true, reading });
  }
  function approve(token: string, amount: bigint) {
    push(token, encodeFunctionData({ abi: approvalAbi, functionName: 'approve', args: [ADDRESSES.aaveSpoke, amount] }),
      'approval', amount, null, ADDRESSES.aaveSpoke,
      amount === BigInt(0) ? 'Clears this token’s allowance to the registered Aave Spoke.' : `Allows only the registered Aave Spoke to move up to ${amount} atomic units in this atomic batch.`);
  }
  function finish(): AaveV4PlanResultV1 {
    return { ok: true, plan: { operation, calls, steps, authorizations: [], targets: [...new Set(calls.map(c => c.to))], venueSimulation: null, forceAtomic: true } };
  }
  return { push, approve, finish };
}

/** Builds code-owned calldata, never accepts a model/provider's recipient or executor. */
export function aaveV4BorrowPlanV1(input: AaveV4BorrowPlanInputV1): AaveV4PlanResultV1 {
  const wallet = input.walletAddress.toLowerCase(), stock = STOCKS.find(s => s.id === input.stockId);
  if (!address(wallet) || !stock || !uint(input.borrowAssets, true) || !uint(input.collateralSupplyAssets) ||
      !uint(input.walletCollateralAssets) || !uint(input.existingSuppliedAssets) ||
      !uint(input.collateralSupplyAssets + input.existingSuppliedAssets) || typeof input.collateralAlreadyEnabled !== 'boolean') return invalid('The exact wallet, registered stock and atomic amounts are required.');
  if (!matchesAaveV4DeploymentV1(input.deployment)) return { ok: false, refusal: 'aave_deployment_changed', detail: 'The current Aave proxy or implementation does not match the reviewed deployment.' };
  if (!binding(input.collateralReserve, stock.token, stock.decimals) || !binding(input.loanReserve, ADDRESSES.usdc, 6) ||
      input.collateralReserve.reserveId === input.loanReserve.reserveId) return { ok: false, refusal: 'aave_reserve_mismatch', detail: 'The exact registered stock and USDC reserves were not established.' };
  if (input.collateralSupplyAssets > input.walletCollateralAssets || input.collateralSupplyAssets + input.existingSuppliedAssets === BigInt(0)) {
    return { ok: false, refusal: 'aave_funding_insufficient', detail: 'Only the selected wallet tokens and the recorded supplied position may secure this loan.' };
  }
  const batch = assembler('borrow');
  if (input.collateralSupplyAssets > BigInt(0)) {
    // Clear any old allowance, set one exact budget, then clear it again after
    // the operation. The final cleanup also bounds nonstandard allowance use.
    batch.approve(stock.token, BigInt(0)); batch.approve(stock.token, input.collateralSupplyAssets);
    batch.push(ADDRESSES.aaveSpoke, encodeFunctionData({ abi: aaveV4WriteAbiV1, functionName: 'supply', args: [BigInt(input.collateralReserve.reserveId), input.collateralSupplyAssets, wallet] }),
      'deposit', input.collateralSupplyAssets, ADDRESSES.aaveHub, null, 'Supplies exactly the selected stock amount for this wallet; the verified Spoke transfers it directly to the Hub.');
  }
  if (!input.collateralAlreadyEnabled) batch.push(ADDRESSES.aaveSpoke,
    encodeFunctionData({ abi: aaveV4WriteAbiV1, functionName: 'setUsingAsCollateral', args: [BigInt(input.collateralReserve.reserveId), true, wallet] }),
    'other', null, wallet, null, 'Enables only the selected supplied stock as collateral for this wallet.');
  batch.push(ADDRESSES.aaveSpoke, encodeFunctionData({ abi: aaveV4WriteAbiV1, functionName: 'borrow', args: [BigInt(input.loanReserve.reserveId), input.borrowAssets, wallet] }),
    'other', input.borrowAssets, wallet, null, 'Borrows the exact selected USDC amount for this wallet; the verified Spoke pays its caller.');
  if (input.collateralSupplyAssets > BigInt(0)) batch.approve(stock.token, BigInt(0));
  return batch.finish();
}

export interface AaveV4RepayPlanInputV1 {
  walletAddress: string;
  loanReserve: AaveV4ReserveBindingV1;
  maximumRepayAssets: bigint;
  walletUsdcAssets: bigint;
  deployment: AaveV4DeploymentReadV1;
}

/** repay(amount) itself takes min(amount,current debt). Never encode an
 * unlimited sentinel: the explicit person's maximum remains the onchain cap. */
export function aaveV4RepayPlanV1(input: AaveV4RepayPlanInputV1): AaveV4PlanResultV1 {
  const wallet = input.walletAddress.toLowerCase();
  if (!address(wallet) || !uint(input.maximumRepayAssets, true) || !uint(input.walletUsdcAssets)) return invalid('A wallet and exact positive maximum USDC debit are required.');
  if (!matchesAaveV4DeploymentV1(input.deployment)) return { ok: false, refusal: 'aave_deployment_changed', detail: 'The current Aave proxy or implementation does not match the reviewed deployment.' };
  if (!binding(input.loanReserve, ADDRESSES.usdc, 6)) return { ok: false, refusal: 'aave_reserve_mismatch', detail: 'The registered USDC reserve was not established.' };
  if (input.maximumRepayAssets > input.walletUsdcAssets) return { ok: false, refusal: 'aave_funding_insufficient', detail: 'The wallet USDC balance is below the confirmed maximum.' };
  const batch = assembler('repay');
  batch.approve(ADDRESSES.usdc, BigInt(0)); batch.approve(ADDRESSES.usdc, input.maximumRepayAssets);
  batch.push(ADDRESSES.aaveSpoke, encodeFunctionData({ abi: aaveV4WriteAbiV1, functionName: 'repay', args: [BigInt(input.loanReserve.reserveId), input.maximumRepayAssets, wallet] }),
    'other', input.maximumRepayAssets, ADDRESSES.aaveHub, null, 'Repays up to the exact confirmed USDC maximum for this wallet without withdrawing collateral or granting a position manager.');
  batch.approve(ADDRESSES.usdc, BigInt(0));
  return batch.finish();
}

export function matchesAaveV4CanonicalCallsV1(expected: AaveV4PreparedPlanV1, calls: readonly ExecutionCallV1[]): boolean {
  // Hashes bind every financial and metadata field, so accept only the exact
  // canonical typed vector rather than a semantically similar re-encoding.
  return JSON.stringify(expected.calls) === JSON.stringify(calls);
}
