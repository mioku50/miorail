import { encodeFunctionResult, type Address } from 'viem';
import { stableHashV1 } from '@mioagent/route-domain';
import type { SimulationProvider, SimulationProviderResponseV1 } from '@mioagent/paid-intelligence';
import { morphoAfterBorrowV1, morphoHealthV1, morphoBorrowCapacityV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { MORPHO_BLUE_BUNDLES_BASE_V1, MORPHO_BLUE_BUNDLES_RUNTIME_HASH_V1 } from '@mioagent/rwa-issuer/morphoRepayPlan';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';
import { erc20Abi, morphoAbi, morphoOracleAbi, multicall3Abi } from '@mioagent/still-engine/abi';
import { nativeMorphoAuthorizationAbiV1, NATIVE_WETH_RUNTIME_HASH_V1, NATIVE_MULTICALL_RUNTIME_HASH_V1 } from './nativeMorphoBorrowPlan.js';
import type { StillBorrowReadingV1 } from './stillBorrowStanding.js';

export const NATIVE_WALLET = '0x1111111111111111111111111111111111111111' as Address;
export const NATIVE_NOW = new Date('2026-10-29T18:00:00Z');
export const NATIVE_PARAMS = {loanToken:ADDRESSES.usdc,collateralToken:ADDRESSES.weth,
  oracle:'0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4' as Address,irm:'0x46415998764C29aB2a25CbeA6254146D50D22687' as Address,lltv:860_000_000_000_000_000n};
export function nativeMorphoHarness(authorized=false, mutate?: (body:SimulationProviderResponseV1)=>void) {
  const asset=CRYPTO.find(r=>r.id==='ETH')!;
  const market={collateralPrice:4_000n*10n**24n,lltvWad:NATIVE_PARAMS.lltv,
    totalSupplyAssets:1_000_000_000_000n,totalBorrowAssets:500_000_000_000n,totalBorrowShares:500_000_000_000_000_000n,blockNumber:53_200_000};
  const position={collateral:100_000_000_000_000_000n,borrowShares:50_000_000_000_000n};
  const q={walletAddress:NATIVE_WALLET,supplyAssets:10_000_000_000_000_000n,borrowAssets:3_000_000n};
  const deployment={chainId:8453,blueBundlesRuntimeHash:MORPHO_BLUE_BUNDLES_RUNTIME_HASH_V1,wethRuntimeHash:NATIVE_WETH_RUNTIME_HASH_V1,
    multicallRuntimeHash:NATIVE_MULTICALL_RUNTIME_HASH_V1,authorized};
  const reading:Extract<StillBorrowReadingV1,{state:'read'}>={state:'read',readAt:NATIVE_NOW.toISOString(),
    nativeFunding:{balance:100_000_000_000_000_000n,params:NATIVE_PARAMS,deployment},
    markets:[{market:{marketId:asset.morphoMarket,curated:null,lltvBps:8600,
      collateral:{address:asset.token,symbol:'WETH',decimals:18},loan:{address:ADDRESSES.usdc,symbol:'USDC',decimals:6},
      borrowApyWad:null,borrowAprWad:0n,oracleAddress:NATIVE_PARAMS.oracle,state:market},
      position,walletCollateralAssets:0n,health:morphoHealthV1({market,position}),capacity:morphoBorrowCapacityV1({market,position}),
      liquidationPrice:null,liquidationIncentiveWad:1_000_000_000_000_000_000n,venuePublishedDebtAssets:null}]};
  const projected=morphoAfterBorrowV1({market,position:{...position,collateral:position.collateral+q.supplyAssets},assets:q.borrowAssets})!;
  let simulations=0;
  const provider:SimulationProvider={providerId:'native-fixture',async simulate(req){
    simulations++;
    const obs=req.observations!;
    const encode=(id:string,after:boolean)=>{
      if(id==='market_params') return encodeFunctionResult({abi:morphoAbi,functionName:'idToMarketParams',result:[NATIVE_PARAMS.loanToken,NATIVE_PARAMS.collateralToken,NATIVE_PARAMS.oracle,NATIVE_PARAMS.irm,NATIVE_PARAMS.lltv]});
      if(id==='position') return encodeFunctionResult({abi:morphoAbi,functionName:'position',result:[0n,after?projected.position.borrowShares:position.borrowShares,position.collateral+(after?q.supplyAssets:0n)]});
      if(id==='market') return encodeFunctionResult({abi:morphoAbi,functionName:'market',result:[market.totalSupplyAssets,1_000_000_000_000_000_000n,
        market.totalBorrowAssets+(after?q.borrowAssets:0n),market.totalBorrowShares+(after?projected.position.borrowShares-position.borrowShares:0n),BigInt(NATIVE_NOW.getTime()/1000),0n]});
      if(id==='oracle_price') return encodeFunctionResult({abi:morphoOracleAbi,functionName:'price',result:market.collateralPrice});
      if(id==='native_wallet_balance') return encodeFunctionResult({abi:multicall3Abi,functionName:'getEthBalance',result:reading.nativeFunding!.balance-(after?q.supplyAssets:0n)});
      if(id==='bundle_authorization') return encodeFunctionResult({abi:nativeMorphoAuthorizationAbiV1,functionName:'isAuthorized',result:authorized});
      return encodeFunctionResult({abi:erc20Abi,functionName:'balanceOf',result:id==='bundle_weth_balance'?777n:0n});
    };
    const body:SimulationProviderResponseV1={status:'success',blockNumber:market.blockNumber,gasUsed:'250000',stateChanges:[],revertReason:null,
      observations:{requestHash:stableHashV1('simulation-observations/v1',{chainId:8453,walletAddress:NATIVE_WALLET,callsHash:req.callsHash,...obs}),
        results:(['before','after'] as const).flatMap(phase=>obs[phase].map(p=>({...p,phase,status:'success' as const,returnData:encode(p.id,phase==='after')})))},
      assetChanges:{status:'available',unavailableReason:null,changes:[{kind:'erc20_transfer',token:ADDRESSES.usdc,direction:'in',
        amountAtomic:q.borrowAssets.toString(),counterparty:MORPHO_BLUE_BUNDLES_BASE_V1,callIndex:authorized?0:1}]}};
    mutate?.(body);return {ok:true,body};
  }};
  return {q,reading,deployment,projected,simulations:()=>simulations,
    deps:{read:async()=>reading,chain:{providers:[provider],batchCapableIds:new Set(['native-fixture'])},now:()=>NATIVE_NOW}};
}
