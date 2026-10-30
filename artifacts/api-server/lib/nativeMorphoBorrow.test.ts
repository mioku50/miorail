import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {decodeFunctionData,encodeFunctionResult} from 'viem';
import {TERMS} from '@mioagent/still-engine/policy';
import {ADDRESSES} from '@mioagent/still-engine/registry';
import {MORPHO_BLUE_BUNDLES_BASE_V1} from '@mioagent/rwa-issuer/morphoRepayPlan';
import {multicall3Abi,erc20Abi,morphoAbi} from '@mioagent/still-engine/abi';
import type {SimulationProviderResponseV1} from '@mioagent/paid-intelligence';
import {issueLendingDraftV1,verifyLendingDraftV1} from './lendingDraft.js';
import {nativeMorphoHarness,NATIVE_PARAMS,NATIVE_NOW,NATIVE_WALLET} from './nativeMorphoFixtures.testhelper.js';
import {buildNativeMorphoBorrowPlanV1,nativeMorphoFundingBudgetV1,nativeMorphoAuthorizationAbiV1} from './nativeMorphoBorrowPlan.js';
import {nativeMorphoBorrowAbiV1} from './nativeMorphoAbi.js';
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
  for(const authorized of [false,true]) it('builds exact native funding and restores '+(authorized?'existing':'temporary')+' authority',()=>{
    const h=nativeMorphoHarness(authorized);
    const p=buildNativeMorphoBorrowPlanV1({...h.q,params:NATIVE_PARAMS,deployment:h.deployment,now:NATIVE_NOW});
    if(!p.ok) assert.fail(p.refusal);
    const {calls}=p;
    assert.equal(calls.length,authorized?1:3);
    const action=calls[authorized?0:1]!;
    assert.equal(action.to,MORPHO_BLUE_BUNDLES_BASE_V1);assert.equal(action.valueWei,h.q.supplyAssets.toString());
    const d=decodeFunctionData({abi:nativeMorphoBorrowAbiV1,data:action.data});
    assert.equal(d.args[1],h.q.supplyAssets);assert.equal(d.args[2],h.q.borrowAssets);
    assert.equal(d.args[3],NATIVE_PARAMS.lltv*TERMS.shareOfProtocolBps/10000n);
    assert.equal(d.args[4].kind,0);assert.deepEqual(d.args[6],[]);assert.equal(d.args[7],0n);assert.equal(d.args[9],p.deadline);
    if(!authorized) for(const [index,flag] of [[0,true],[2,false]] as const){
      const call=calls[index]!;
      const decoded=decodeFunctionData({abi:nativeMorphoAuthorizationAbiV1,data:call.data});
      assert.equal(call.to,ADDRESSES.morpho.toLowerCase());assert.equal(call.valueWei,'0');assert.deepEqual([decoded.args[0].toLowerCase(),decoded.args[1]],[MORPHO_BLUE_BUNDLES_BASE_V1,flag]);
    }
  });
  it('refuses every changed deployment pin and a non-native market before producing calls',()=>{
    for(const field of ['chainId','blueBundlesRuntimeHash','wethRuntimeHash','multicallRuntimeHash'] as const){
      const h=nativeMorphoHarness();Object.assign(h.deployment,{[field]:field==='chainId'?1:'0x'+'00'.repeat(32)});
      const p=buildNativeMorphoBorrowPlanV1({...h.q,params:NATIVE_PARAMS,deployment:h.deployment,now:NATIVE_NOW});
      assert(!p.ok);assert(!('calls' in p));
    }
    const h=nativeMorphoHarness();
    assert(!buildNativeMorphoBorrowPlanV1({...h.q,params:{...NATIVE_PARAMS,collateralToken:ADDRESSES.cbbtc},deployment:h.deployment,now:NATIVE_NOW}).ok);
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
  for(const authorized of [false,true]) it('proves wrap/pledge/loan and '+(authorized?'preserves':'clears')+' authorization in one evolving state',async()=>{
    const h=nativeMorphoHarness(authorized),r=await runNativeMorphoBorrowV1(h.q,h.deps);
    assert.equal(r.state,'ready',r.state==='refused'?r.refusal+':'+r.detail:'');
    if(r.state!=='ready')return;
    assert.equal(r.atomicRequired,true);assert.equal(r.facts.nativeFunding!.maximumNativeAssets,h.q.supplyAssets.toString());
    assert.equal(r.facts.nativeFunding!.feeQuoteState,'wallet_quote_required');
    assert.equal(r.facts.collateralAfterAssets,(h.reading.markets[0]!.position!.collateral+h.q.supplyAssets).toString());
    assert.equal(r.facts.debtAfterShares,h.projected.position.borrowShares.toString());assert.equal(h.simulations(),1);
  });
  it('refuses native overspend, unread funding or changed runtimes before simulation',async()=>{
    for(const mutate of [
      (h:ReturnType<typeof nativeMorphoHarness>)=>{h.reading.nativeFunding!.balance=h.q.supplyAssets+TERMS.ethGasReserveWei-1n;},
      (h:ReturnType<typeof nativeMorphoHarness>)=>{delete h.reading.nativeFunding;},
      (h:ReturnType<typeof nativeMorphoHarness>)=>{h.deployment.wethRuntimeHash='0x'+'00'.repeat(32);},
    ]){const h=nativeMorphoHarness();mutate(h);assert.equal((await runNativeMorphoBorrowV1(h.q,h.deps)).state,'refused');assert.equal(h.simulations(),0);}
  });
  it('refuses changed state, hidden WETH spend, native debit, authorization or debt effects without calls',async()=>{
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
      (b:SimulationProviderResponseV1)=>{b.assetChanges!.changes[0]!.amountAtomic='2999999';},
      (b:SimulationProviderResponseV1)=>{b.assetChanges!.changes[0]!.counterparty=ADDRESSES.morpho;},
      (b:SimulationProviderResponseV1)=>{b.assetChanges!.changes.push({...b.assetChanges!.changes[0]!,token:ADDRESSES.weth,direction:'out',amountAtomic:'1'});},
      (b:SimulationProviderResponseV1)=>{b.status='reverted';},
    ]){const h=nativeMorphoHarness(false,mutate),r=await runNativeMorphoBorrowV1(h.q,h.deps);assert.equal(r.state,'refused');assert(!('calls' in r));}
  });
});
