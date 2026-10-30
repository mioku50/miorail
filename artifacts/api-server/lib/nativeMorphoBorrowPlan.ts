import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from 'viem';
import type { ExecutionCallV1 } from '@mioagent/route-domain';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';
import { TERMS } from '@mioagent/still-engine/policy';
import { MORPHO_BLUE_BUNDLES_BASE_V1, MORPHO_BLUE_BUNDLES_RUNTIME_HASH_V1, type MorphoRepayMarketParamsV1 } from '@mioagent/rwa-issuer/morphoRepayPlan';
import { nativeMorphoBorrowAbiV1 } from './nativeMorphoAbi.js';

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
const address = (v: string): v is Address => /^0x[0-9a-f]{40}$/.test(v) && !/^0x0{40}$/.test(v);

/** Reserve is ETH deliberately NOT forwarded as collateral. Wallet/network
 * fees are paid from the remaining ETH and are not quoted by this builder. */
export function nativeMorphoFundingBudgetV1(balance: bigint | null, amount: bigint): boolean {
  return balance !== null && typeof balance === 'bigint' && balance >= 0n && balance < 1n << 256n &&
    valid(amount) && balance >= amount + TERMS.ethGasReserveWei;
}
export function buildNativeMorphoBorrowPlanV1(input: {
  walletAddress: string; params: MorphoRepayMarketParamsV1; supplyAssets: bigint; borrowAssets: bigint;
  deployment: NativeMorphoDeploymentV1; now: Date;
}): { ok: true; calls: ExecutionCallV1[]; deadline: bigint; steps: { index: number; to: string; reading: string }[] }
  | { ok: false; refusal: string; detail: string } {
  const fail = (refusal: string, detail: string) => ({ ok: false as const, refusal, detail });
  const wallet = input.walletAddress.toLowerCase(), p = input.params;
  const loan = p.loanToken.toLowerCase(), collateral = p.collateralToken.toLowerCase(), oracle = p.oracle.toLowerCase(), irm = p.irm.toLowerCase();
  if (!address(wallet) || !address(loan) || !address(collateral) || !address(oracle) || !address(irm) ||
      loan !== ADDRESSES.usdc.toLowerCase() || collateral !== ADDRESSES.weth.toLowerCase() ||
      !valid(input.supplyAssets) || !valid(input.borrowAssets) || typeof p.lltv !== 'bigint' || p.lltv <= 0n || p.lltv > 10n ** 18n ||
      !Number.isFinite(input.now.getTime())) return fail('native_borrow_inputs_invalid', 'The native ETH contribution, loan and exact WETH market must be established.');
  const market = CRYPTO.find(row => row.id === 'ETH')!;
  const id = keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address'},{type:'uint256'}], [loan,collateral,oracle,irm,p.lltv]));
  if (id !== market.morphoMarket) return fail('native_borrow_market_mismatch', 'The immutable parameters do not derive Still’s registered WETH/USDC market.');
  if (!nativeMorphoDeploymentMatchesV1(input.deployment)) return fail('native_borrow_runtime_unverified', 'The native wrapper, observation reader or Morpho bundle runtime changed or could not be read.');
  const deadline = BigInt(Math.floor(input.now.getTime() / 1000) + 300);
  const zero = `0x${'0'.repeat(64)}` as Hex;
  const action = { to: MORPHO_BLUE_BUNDLES_BASE_V1, value: input.supplyAssets.toString(),
    data: encodeFunctionData({abi:nativeMorphoBorrowAbiV1,functionName:'blueBundlesV1SupplyCollateralAndBorrow',args:[
      {loanToken:loan,collateralToken:collateral,oracle,irm,lltv:p.lltv},input.supplyAssets,input.borrowAssets,
      p.lltv * TERMS.shareOfProtocolBps / 10_000n,
      {kind:0,data:'0x'},{signature:{v:0,r:zero,s:zero},nonce:0n,deadline:0n},[],0n,'0x0000000000000000000000000000000000000000',deadline,
    ]}) };
  const authorize = (flag: boolean) => ({to:ADDRESSES.morpho.toLowerCase() as Address,value:'0',
    data:encodeFunctionData({abi:nativeMorphoAuthorizationAbiV1,functionName:'setAuthorization',args:[MORPHO_BLUE_BUNDLES_BASE_V1,flag]})});
  // Restore existing authority. A pre-existing grant is never revoked; a new
  // grant exists only between these calls in the required atomic batch.
  const raw = input.deployment.authorized ? [action] : [authorize(true),action,authorize(false)];
  const calls: ExecutionCallV1[] = raw.map((call,index)=>({index,callType:'other',to:call.to,data:call.data,valueWei:call.value,
    asset:null,amountAtomic:null,recipient:wallet,spender:null}));
  return {ok:true,calls,deadline,steps:calls.map(call=>({index:call.index,to:call.to,reading:call.to===MORPHO_BLUE_BUNDLES_BASE_V1
    ? 'Wraps exactly the selected ETH into WETH, pledges it to the registered Morpho market and borrows the selected USDC for your wallet. No fee, permit, reallocation or different recipient. The contract enforces the deadline and Still’s crypto LTV cap.'
    : call.index===0 ? 'Temporarily authorizes the pinned Morpho bundle for this atomic transaction.' : 'Restores the Morpho bundle authorization to its previous disabled state.'}))};
}
