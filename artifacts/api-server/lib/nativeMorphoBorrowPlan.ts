import { parseAbi } from 'viem';
import { TERMS } from '@mioagent/still-engine/policy';
import { formatTokenAmount } from '@mioagent/still-engine/format';
import { MORPHO_BLUE_BUNDLES_RUNTIME_HASH_V1 } from '@mioagent/rwa-issuer/morphoRepayPlan';

export const NATIVE_WETH_RUNTIME_HASH_V1 = '0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c';
export const NATIVE_MULTICALL_RUNTIME_HASH_V1 = '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891';
export const nativeMorphoAuthorizationAbiV1 = parseAbi([
  'function isAuthorized(address authorizer,address authorized) view returns (bool)',
  'function setAuthorization(address authorized,bool newIsAuthorized)',
]);
export interface NativeMorphoDeploymentV1 {
  chainId: number; blueBundlesRuntimeHash: string; wethRuntimeHash: string; multicallRuntimeHash: string; authorized: boolean;
}
export function nativeMorphoDeploymentMatchesV1(pin: NativeMorphoDeploymentV1): boolean {
  return pin.chainId === 8453 && typeof pin.authorized === 'boolean' &&
    pin.blueBundlesRuntimeHash.toLowerCase() === MORPHO_BLUE_BUNDLES_RUNTIME_HASH_V1 &&
    pin.wethRuntimeHash.toLowerCase() === NATIVE_WETH_RUNTIME_HASH_V1 &&
    pin.multicallRuntimeHash.toLowerCase() === NATIVE_MULTICALL_RUNTIME_HASH_V1;
}
const UINT128 = (1n << 128n) - 1n;
const valid = (v: bigint) => typeof v === 'bigint' && v > 0n && v <= UINT128;

/** Reserve is ETH deliberately NOT forwarded as collateral. Wallet/network
 * fees are paid from the remaining ETH and are not quoted by this builder. */
export function nativeMorphoFundingBudgetV1(balance: bigint | null, amount: bigint): boolean {
  return balance !== null && typeof balance === 'bigint' && balance >= 0n && balance < 1n << 256n &&
    valid(amount) && balance >= amount + TERMS.ethGasReserveWei;
}

/** ETH as a person reads it: floored, so a "you can add up to" figure is
 * never more than the wallet can add. */
const ethV1 = (wei: bigint) => `${formatTokenAmount(wei, 18, 6).replace(/\.?0+$/, '')} ETH`;

/**
 * Why the selected ETH cannot be pledged, with the numbers that say what can.
 *
 * One sentence used to cover both cases, "the native balance is unread or the
 * selected ETH would spend Still's reserve", so on 2026-10-31 a wallet holding
 * 0.0033 ETH that asked to pledge 0.0033 was told neither which it was nor
 * that 0.0028 would have worked.
 */
export function nativeMorphoFundingRefusalV1(balance: bigint | null, amount: bigint): null | {
  refusal: 'native_balance_unread' | 'native_fee_reserve_insufficient';
  detail: string;
  walletNativeAtomic?: string;
  maximumNativeAtomic?: string;
} {
  if (nativeMorphoFundingBudgetV1(balance, amount)) return null;
  if (balance === null || typeof balance !== 'bigint' || balance < 0n || balance >= 1n << 256n) {
    return { refusal: 'native_balance_unread', detail: 'Still could not read this wallet’s ETH balance just now, so no limit was read. Read it again in a moment.' };
  }
  const reserve = TERMS.ethGasReserveWei;
  // Floored to what the sentence shows, so pressing "use it" asks for exactly
  // the figure the person read.
  const step = 10n ** 12n;
  const maximum = balance > reserve ? ((balance - reserve) / step) * step : 0n;
  return {
    refusal: 'native_fee_reserve_insufficient',
    detail: maximum > 0n
      ? `This wallet holds ${ethV1(balance)}. Still leaves ${ethV1(reserve)} in it for network fees, so you can add up to ${ethV1(maximum)}.`
      : `This wallet holds ${ethV1(balance)}, and Still leaves ${ethV1(reserve)} in it for network fees, so there is no ETH to add. Add ETH to this wallet, or choose WETH or cbBTC.`,
    walletNativeAtomic: balance.toString(),
    maximumNativeAtomic: maximum.toString(),
  };
}
