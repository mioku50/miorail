import { hashApprovedCallsV1, stableHashV1 } from '@mioagent/route-domain';
import { morphoStillDrawV1 } from '@mioagent/still-engine/capacity';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';
import { TERMS } from '@mioagent/still-engine/policy';
import type { SimulationProviderRequestV1 } from '@mioagent/paid-intelligence';
import { readBorrowStandingV1 } from './stillBorrowStanding.js';
import { buildNativeMorphoBorrowPlanV1, nativeMorphoFundingBudgetV1 } from './nativeMorphoBorrowPlan.js';
import { buildMorphoBorrowPoststateProbesV1, verifyMorphoBorrowPoststateV1 } from './morphoBorrowPoststate.js';
import { buildSimulationChainV1, runSimulationChainV1, type SimulationChainV1 } from './swapSimulation.js';
import { lendingSigningTermsFactsV1, type LendingRunV1, type LendingFactsV1 } from './lendingReview.js';

export interface NativeMorphoBorrowRequestV1 { walletAddress: string; supplyAssets: bigint; borrowAssets: bigint }
export interface NativeMorphoBorrowDepsV1 {
  read?: typeof readBorrowStandingV1; chain?: SimulationChainV1; env?: NodeJS.ProcessEnv; now?: () => Date;
}
const fail = (refusal: string, detail: string): LendingRunV1 => ({state:'refused',refusal,detail});

/** Explicit native-only funding. Never substitutes native ETH for a legacy
 * ERC-20 question. Same shared market math, reader, simulator and owned ledger.
 * Bytes are built from the pinned protocol ABI, not an Actions API attestation. */
export async function runNativeMorphoBorrowV1(q: NativeMorphoBorrowRequestV1, deps: NativeMorphoBorrowDepsV1 = {}): Promise<LendingRunV1> {
  const now = deps.now ?? (()=>new Date());
  const asset = CRYPTO.find(row=>row.id==='ETH')!;
  if (q.borrowAssets <= 0n || q.borrowAssets >= 1n<<128n || q.supplyAssets <= 0n || q.supplyAssets >= 1n<<128n) return fail('native_borrow_inputs_invalid','Choose exact positive ETH collateral and USDC amounts.');
  const read = await (deps.read ?? readBorrowStandingV1)({tokenAddress:asset.token,walletAddress:q.walletAddress,nativeFunding:true});
  if (read.state==='refused') return fail(read.refusal,read.detail ?? 'The native borrowing state could not be read.');
  const s = read.markets.length===1 ? read.markets[0] : null, funding = read.nativeFunding;
  if (!s?.position || !s.health || !funding || s.market.marketId!==asset.morphoMarket ||
      s.market.collateral.address?.toLowerCase()!==asset.token.toLowerCase() ||
      s.market.loan.address?.toLowerCase()!==ADDRESSES.usdc.toLowerCase() ||
      s.market.collateral.decimals!==18 || s.market.loan.decimals!==6) return fail('native_borrow_standing_unread','The exact registered WETH market, native balance and position were not established.');
  if (!nativeMorphoFundingBudgetV1(funding.balance,q.supplyAssets)) return fail('native_fee_reserve_insufficient','The selected ETH would leave less than Still’s native reserve for wallet/network fees.');
  const draw = morphoStillDrawV1({market:s.market.state,position:s.position,borrowAssets:q.borrowAssets,additionalCollateralAssets:q.supplyAssets});
  if (!draw.ok) return fail(draw.refusal,'The selected loan exceeds the measured Still allowance or available market liquidity.');
  const plan = buildNativeMorphoBorrowPlanV1({walletAddress:q.walletAddress,params:funding.params,
    supplyAssets:q.supplyAssets,borrowAssets:q.borrowAssets,deployment:funding.deployment,now:now()});
  if (!plan.ok) return fail(plan.refusal,plan.detail);
  const identity = {marketId:asset.morphoMarket,walletAddress:q.walletAddress.toLowerCase(),loanTokenAddress:ADDRESSES.usdc,
    collateralTokenAddress:asset.token,oracleAddress:funding.params.oracle,collateralSupplyAssets:q.supplyAssets,
    nativeFunding:{balance:funding.balance,authorizedBefore:funding.deployment.authorized}};
  const probes = buildMorphoBorrowPoststateProbesV1(identity);
  if (!probes.ok) return fail(probes.refusal,probes.detail);
  const callsHash = hashApprovedCallsV1(plan.calls);
  const request: SimulationProviderRequestV1 = {chainId:8453,walletAddress:identity.walletAddress,callsHash,calls:plan.calls,
    blueprintHash:stableHashV1('native-morpho-borrow/v1',{wallet:identity.walletAddress,supply:q.supplyAssets.toString(),borrow:q.borrowAssets.toString()}),
    observations:probes.observations};
  const answer = await runSimulationChainV1({chain:deps.chain ?? buildSimulationChainV1(deps.env ?? process.env),
    request,nowIso:now().toISOString(),label:'Native ETH borrowing simulation',logContext:{marketId:asset.morphoMarket,callsHash}});
  if (!answer.ok) return fail(answer.errorCode,'The native-funded loan could not be simulated. No executable review is available.');
  if (answer.response.status!=='success') return fail('native_borrow_simulation_reverted','The atomic wrap, collateral deposit or loan reverted in simulation.');
  const changes = answer.response.assetChanges;
  if (!changes || changes.status!=='available') return fail('native_borrow_effects_unread','The simulation did not establish the wallet’s asset movements.');
  let usdcIn=0n;
  for (const c of changes.changes) {
    if (!/^(0|[1-9][0-9]{0,77})$/.test(c.amountAtomic)) return fail('native_borrow_effects_unread','A wallet movement was not an exact amount.');
    const amount=BigInt(c.amountAtomic); if(amount===0n) continue;
    if(c.token.toLowerCase()!==ADDRESSES.usdc.toLowerCase() || c.direction!=='in' || c.kind!=='erc20_transfer' ||
      c.counterparty?.toLowerCase()!=='0x4d28d900e381ece4b351302f1abe588496793a2b') return fail('native_borrow_unrequested_asset_change','An unrelated wallet token moved or USDC came from an unreviewed source.');
    usdcIn+=amount;
  }
  if(usdcIn!==q.borrowAssets) return fail('native_borrow_arrival_mismatch','The selected USDC amount did not reach this wallet exactly.');
  const measured = verifyMorphoBorrowPoststateV1({request,response:answer.response,
    expected:{...identity,borrowAssets:q.borrowAssets,position:s.position,blockNumber:s.market.state.blockNumber}});
  if(!measured.ok) return fail(measured.refusal,measured.detail);
  const freshDraw=morphoStillDrawV1({market:measured.before.market,position:measured.before.position,
    borrowAssets:q.borrowAssets,additionalCollateralAssets:q.supplyAssets});
  if(!freshDraw.ok) return fail(freshDraw.refusal,'The simulated position exceeds Still’s allowance.');
  const after=measured.after, before=measured.before;
  const facts: LendingFactsV1 = {operation:'borrow',venue:'morpho',collateralTokenAddress:asset.token.toLowerCase(),collateralSymbol:'WETH',
    collateralDecimals:18,marketId:asset.morphoMarket,amountMode:'assets',requestedAssets:q.borrowAssets.toString(),maximumDebitAssets:'0',
    collateralSupplyAssets:q.supplyAssets.toString(),debtBeforeAssets:before.health.borrowedAssets.toString(),debtAfterAssets:after.health.borrowedAssets.toString(),
    collateralBeforeAssets:before.position.collateral.toString(),collateralAfterAssets:after.position.collateral.toString(),
    debtBeforeShares:before.position.borrowShares.toString(),debtAfterShares:after.position.borrowShares.toString(),
    healthBeforeWad:before.health.healthFactorWad?.toString() ?? null,healthAfterWad:after.health.healthFactorWad?.toString() ?? null,
    blockNumber:answer.response.blockNumber,termsVersion:TERMS.version,policyLimitAssets:freshDraw.capacity.limitAssets.toString(),
    nativeFunding:{maximumNativeAssets:q.supplyAssets.toString(),reserveAssets:TERMS.ethGasReserveWei.toString(),
      balanceBeforeAssets:funding.balance.toString(),balanceAfterAssets:(funding.balance-q.supplyAssets).toString(),
      authorizedBefore:funding.deployment.authorized,feeQuoteState:'wallet_quote_required'},
    warnings:['Only the selected native ETH is wrapped and pledged. Wallet-held WETH is not spent.',
      'The ETH left in your wallet is measured before wallet/network fees. Those fees are not quoted here; your wallet calculates them before approval.',
      'The atomic contract enforces the deadline and Still’s crypto LTV cap. Collateral can still be liquidated.',
      'Calls are built from the verified protocol ABI and independently simulated; they are not an Actions API attestation.']};
  const expiry=Math.min(now().getTime()+30_000,Number(plan.deadline)*1000);
  if(expiry<=now().getTime()) return fail('native_borrow_expired','The native-funded loan review expired during measurement.');
  return {state:'ready',facts,calls:plan.calls,callsHash,signingTermsHash:stableHashV1('native-morpho-terms/v1',{wallet:identity.walletAddress,callsHash,facts:lendingSigningTermsFactsV1(facts)}),
    expiresAt:new Date(expiry).toISOString(),atomicRequired:true,steps:plan.steps,
    measured:{provider:answer.providerId,blockNumber:answer.response.blockNumber,loanDeltaAssets:usdcIn.toString()}};
}
