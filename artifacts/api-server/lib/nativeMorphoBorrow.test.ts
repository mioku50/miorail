import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {encodeFunctionResult} from 'viem';
import {TERMS} from '@mioagent/still-engine/policy';
import {ADDRESSES} from '@mioagent/still-engine/registry';
import {MORPHO_BLUE_BUNDLES_BASE_V1} from '@mioagent/rwa-issuer/morphoRepayPlan';
import {multicall3Abi,erc20Abi,morphoAbi} from '@mioagent/still-engine/abi';
import type {SimulationProviderResponseV1} from '@mioagent/paid-intelligence';
import {issueLendingDraftV1,verifyLendingDraftV1} from './lendingDraft.js';
import {nativeMorphoHarness,NATIVE_PARAMS,NATIVE_NOW,NATIVE_WALLET} from './nativeMorphoFixtures.testhelper.js';
import {nativeMorphoFundingBudgetV1,nativeMorphoFundingRefusalV1,nativeMorphoAuthorizationAbiV1} from './nativeMorphoBorrowPlan.js';
import {runNativeMorphoBorrowV1} from './nativeMorphoBorrowRunner.js';

describe('explicit native ETH collateral',()=>{
  it('bounds the contribution before the fee reserve, including a one-wei boundary and unread balances',()=>{
    const reserve=TERMS.ethGasReserveWei;
    assert(nativeMorphoFundingBudgetV1(reserve+1n,1n));
    assert(!nativeMorphoFundingBudgetV1(reserve,1n));
    assert(!nativeMorphoFundingBudgetV1(null,1n));
    assert(!nativeMorphoFundingBudgetV1(reserve,0n));
    assert(!nativeMorphoFundingBudgetV1(-1n,1n));
  });
  it('names the balance, the reserve and what can be added, floored to what it shows',()=>{
    const reserve=TERMS.ethGasReserveWei;
    assert.equal(nativeMorphoFundingRefusalV1(reserve+1n,1n),null);
    // 2026-10-31: a wallet holding 0.0033 ETH that asked to pledge all of it.
    assert.deepEqual(nativeMorphoFundingRefusalV1(3_300_000_000_000_000n,3_300_000_000_000_000n),{
      refusal:'native_fee_reserve_insufficient',
      detail:'This wallet holds 0.0033 ETH. Still leaves 0.0005 ETH in it for network fees, so you can add up to 0.0028 ETH.',
      walletNativeAtomic:'3300000000000000',maximumNativeAtomic:'2800000000000000'});
    // Never more than the wallet can add: a balance below the shown precision floors.
    const odd=nativeMorphoFundingRefusalV1(3_300_000_999_999_999n,4_000_000_000_000_000n)!;
    assert.equal(odd.maximumNativeAtomic,'2800000000000000');
    assert(nativeMorphoFundingBudgetV1(3_300_000_999_999_999n,BigInt(odd.maximumNativeAtomic!)));
    const empty=nativeMorphoFundingRefusalV1(reserve,1n)!;
    assert.equal(empty.maximumNativeAtomic,'0');
    assert.match(empty.detail,/there is no ETH to add/);
    assert.equal(nativeMorphoFundingRefusalV1(null,1n)!.refusal,'native_balance_unread');
  });
  // 2026-11-07, the operator: «да делай прямые вызовы для всех кошельков». The wallet wraps exactly the chosen ETH
  // itself, then pledges and borrows in its own calls to Morpho Blue: no bundle, and no authorization, granted or not.
  for(const authorized of [false,true]) it('wraps, pledges and borrows as the wallet’s own calls, whatever authorization was there before ('+authorized+')',async()=>{
    const h=nativeMorphoHarness(authorized),r=await runNativeMorphoBorrowV1(h.q,h.deps);
    assert.equal(r.state,'ready',r.state==='refused'?r.refusal+':'+r.detail:'');
    if(r.state!=='ready')return;
    const weth=ADDRESSES.weth.toLowerCase(),morpho=ADDRESSES.morpho.toLowerCase();
    assert.deepEqual(r.calls.map(c=>[c.to,c.callType,c.valueWei]),[[weth,'other',h.q.supplyAssets.toString()],[weth,'approval','0'],[weth,'approval','0'],
      [morpho,'deposit','0'],[morpho,'other','0'],[weth,'approval','0']]);
    assert.equal(r.calls[0]!.data,'0xd0e30db0');
    assert.equal(r.calls.some(c=>c.to===MORPHO_BLUE_BUNDLES_BASE_V1),false);
    assert.equal(r.calls.some(c=>c.data.startsWith('0xeecea000')),false,'no setAuthorization');
    assert.equal(r.facts.nativeFunding!.authorizedBefore,authorized);
    assert.match(r.facts.warnings.join(' '),/Your wallet calls Morpho Blue itself, so no contract is given the right to act for it\./);
    assert.equal(r.expiresAt,new Date(NATIVE_NOW.getTime()+30_000).toISOString());
  });
  it('in steps, wraps first and then sends the same pledge and loan as a WETH loan, with no clearing calls',async()=>{
    const h=nativeMorphoHarness(),r=await runNativeMorphoBorrowV1({...h.q,delivery:'sequential'},h.deps);
    assert.equal(r.state,'ready',r.state==='refused'?r.refusal+':'+r.detail:'');
    if(r.state!=='ready')return;
    assert.equal(r.atomicRequired,false);assert.equal(r.delivery,'sequential');
    assert.deepEqual(r.calls.map(c=>c.callType),['other','approval','deposit','other']);
    assert.match(r.facts.warnings.join(' '),/Your wallet sends this as 4 steps, one transaction each/);
    // Audit LEND-5: stopped after the wrap, the wallet holds WETH where it held ETH, and the review says so.
    assert.match(r.facts.warnings.at(-1)!,/The first step wraps your ETH: stopping after it leaves that amount in your wallet as WETH, not ETH, and not pledged\.$/);
    const unread=nativeMorphoHarness();unread.reading.markets[0]!.collateralAllowanceToMorphoAssets=null;
    const refused=await runNativeMorphoBorrowV1({...unread.q,delivery:'sequential'},unread.deps);
    assert.equal(refused.state,'refused');assert.equal(unread.simulations(),0);
  });
  it('refuses a changed WETH or observation runtime, and a non-native market, before producing calls',async()=>{
    for(const field of ['chainId','wethRuntimeHash','multicallRuntimeHash'] as const){
      const h=nativeMorphoHarness();Object.assign(h.deployment,{[field]:field==='chainId'?1:'0x'+'00'.repeat(32)});
      const r=await runNativeMorphoBorrowV1(h.q,h.deps);
      assert.equal(r.state,'refused',field);assert(!('calls' in r));assert.equal(h.simulations(),0);
    }
    // The bundle is no longer called, so its runtime no longer decides anything.
    const bundle=nativeMorphoHarness();bundle.deployment.blueBundlesRuntimeHash='0x'+'00'.repeat(32) as never;
    assert.equal((await runNativeMorphoBorrowV1(bundle.q,bundle.deps)).state,'ready');
    const h=nativeMorphoHarness();h.reading.nativeFunding!.params={...NATIVE_PARAMS,collateralToken:ADDRESSES.cbbtc};
    assert.equal((await runNativeMorphoBorrowV1(h.q,h.deps)).state,'refused');assert.equal(h.simulations(),0);
  });
  it('uses a v2 signed question; v1 cannot be reinterpreted as native funding',()=>{
    const secret='native-question-fixture-secret-not-production', owner={walletAddress:NATIVE_WALLET,tenantId:'eip155:8453:'+NATIVE_WALLET};
    const question={operation:'borrow' as const,collateralTokenAddress:ADDRESSES.weth.toLowerCase(),borrowAssets:'3000000',collateralSupplyAssets:'10000000000000000'};
    const old=issueLendingDraftV1({...owner,question,secret,now:NATIVE_NOW});
    const current=issueLendingDraftV1({...owner,question:{...question,nativeFundingAssets:question.collateralSupplyAssets},secret,now:NATIVE_NOW});
    assert(old.draft.startsWith('miorail-lending-v1.'));assert(current.draft.startsWith('miorail-lending-v2.'));
    const verify=(draft:string)=>verifyLendingDraftV1({...owner,secret,now:NATIVE_NOW,draft});
    assert(verify(old.draft).ok);assert(verify(current.draft).ok);
    assert(!verify(current.draft.replace('miorail-lending-v2','miorail-lending-v1')).ok);
    for(const patch of [{nativeFundingAssets:'1'},{collateralTokenAddress:ADDRESSES.cbbtc.toLowerCase()},{collateralSupplyAssets:'0',nativeFundingAssets:'0'}]){
      assert.throws(()=>issueLendingDraftV1({...owner,secret,now:NATIVE_NOW,question:{...question,nativeFundingAssets:question.collateralSupplyAssets,...patch}}));
    }
  });
  it('refuses native overspend, unread funding or changed runtimes before simulation',async()=>{
    for(const mutate of [
      (h:ReturnType<typeof nativeMorphoHarness>)=>{h.reading.nativeFunding!.balance=h.q.supplyAssets+TERMS.ethGasReserveWei-1n;},
      (h:ReturnType<typeof nativeMorphoHarness>)=>{delete h.reading.nativeFunding;},
      (h:ReturnType<typeof nativeMorphoHarness>)=>{h.deployment.wethRuntimeHash='0x'+'00'.repeat(32);},
    ]){const h=nativeMorphoHarness();mutate(h);assert.equal((await runNativeMorphoBorrowV1(h.q,h.deps)).state,'refused');assert.equal(h.simulations(),0);}
  });
  it('refuses changed state, hidden WETH spend, native debit, authorization or debt effects without calls',async()=>{
    const usdc=(b:SimulationProviderResponseV1)=>b.assetChanges!.changes.find(c=>c.token===ADDRESSES.usdc)!;
    const changeProbe=(b:SimulationProviderResponseV1,id:string,data:`0x${string}`)=>{
      b.observations!.results.find(r=>r.phase==='after' && r.id===id)!.returnData=data;
    };
    for(const mutate of [
      (b:SimulationProviderResponseV1)=>{delete b.observations;},
      (b:SimulationProviderResponseV1)=>changeProbe(b,'native_wallet_balance',encodeFunctionResult({abi:multicall3Abi,functionName:'getEthBalance',result:89_999_999_999_999_999n})),
      (b:SimulationProviderResponseV1)=>changeProbe(b,'bundle_authorization',encodeFunctionResult({abi:nativeMorphoAuthorizationAbiV1,functionName:'isAuthorized',result:true})),
      (b:SimulationProviderResponseV1)=>changeProbe(b,'collateral_wallet_balance',encodeFunctionResult({abi:erc20Abi,functionName:'balanceOf',result:1n})),
      (b:SimulationProviderResponseV1)=>changeProbe(b,'bundle_weth_balance',encodeFunctionResult({abi:erc20Abi,functionName:'balanceOf',result:778n})),
      (b:SimulationProviderResponseV1)=>changeProbe(b,'position',encodeFunctionResult({abi:morphoAbi,functionName:'position',result:[0n,1n,110_000_000_000_000_000n]})),
      (b:SimulationProviderResponseV1)=>{usdc(b).amountAtomic='2999999';},
      // USDC from the old bundle, or WETH wrapped, pledged or sent other than exactly the chosen ETH.
      (b:SimulationProviderResponseV1)=>{usdc(b).counterparty=MORPHO_BLUE_BUNDLES_BASE_V1;},
      (b:SimulationProviderResponseV1)=>{b.assetChanges!.changes[0]!.amountAtomic='1';},
      (b:SimulationProviderResponseV1)=>{b.assetChanges!.changes[1]!.counterparty=MORPHO_BLUE_BUNDLES_BASE_V1;},
      (b:SimulationProviderResponseV1)=>{b.assetChanges!.changes.push({...b.assetChanges!.changes[1]!,amountAtomic:'1'});},
      (b:SimulationProviderResponseV1)=>{b.assetChanges!.changes.push({kind:'erc20_transfer',token:ADDRESSES.cbbtc,direction:'out',amountAtomic:'1',counterparty:ADDRESSES.morpho,callIndex:2});},
      (b:SimulationProviderResponseV1)=>{b.status='reverted';},
    ]){const h=nativeMorphoHarness(false,mutate),r=await runNativeMorphoBorrowV1(h.q,h.deps);assert.equal(r.state,'refused');assert(!('calls' in r));}
  });
});
