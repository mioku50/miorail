import { keccak256, parseAbi, type Address } from 'viem';
import { MORPHO_BLUE_BUNDLES_BASE_V1 } from '@mioagent/rwa-issuer/morphoRepayPlan';
import { nativeMorphoAuthorizationAbiV1, nativeMorphoDeploymentMatchesV1, type NativeMorphoDeploymentV1 } from './nativeMorphoBorrowPlan.js';
import {
  morphoAccruedTotalsV1,
  morphoBorrowCapacityV1,
  morphoHealthV1,
  morphoLiquidationIncentiveWadV1,
  morphoLiquidationPriceV1,
  type MorphoMarketStateV1,
} from '@mioagent/rwa-issuer/morphoBorrowMath';
import {
  readMorphoBorrowStandingV1,
  type MorphoBorrowReadingV1,
  type MorphoBorrowReaderDepsV1,
  type MorphoBorrowStandingV1,
} from '@mioagent/rwa-issuer/morphoBorrowReading';
import { ADDRESSES, CRYPTO, type CryptoAsset } from '@mioagent/still-engine/registry';
import { createProviders } from '@mioagent/still-engine';
import { morphoStillCapacityV1 } from '@mioagent/still-engine/capacity';
import { TERMS } from '@mioagent/still-engine/policy';
import { loadMorphoUniverse, readWallet, type Universe, type WalletSnapshot } from '@mioagent/still-engine/read';
import { stillRpcUrlsV1 } from './stillMirror.js';
import { stillLimitComparisonV1 } from './stillLimitComparison.js';
import { headAtLeastV1 } from './stillAaveStanding.js';
import { morphoCollateralHoldableV1, readMorphoCollateralTransfersV1, type MorphoCollateralTransfersV1 } from './morphoCollateralHold.js';

// Still uses these two immutable markets, not the first page of an API's market
// directory. Reuse the Mirror's chain reader and accrual, at one reading block.
// Wallet assets are deliberately NOT added to pledged collateral here: a borrow
// against an existing position must not silently authorise a new deposit.
export function stillBorrowAssetV1(tokenAddress: string): CryptoAsset | undefined {
  return CRYPTO.find((asset) => asset.token.toLowerCase() === tokenAddress.trim().toLowerCase());
}

/** A protocol maximum and Still's stricter allowance remain separate facts. */
export function stillBorrowCapacityWireV1(token: string, standing: MorphoBorrowStandingV1, collateralSupplyAssets = 0n) {
  const asset = stillBorrowAssetV1(token);
  if (!asset || !standing.position || standing.market.marketId.toLowerCase() !== asset.morphoMarket.toLowerCase()) return null;
  try {
    const capacity = morphoStillCapacityV1({ market: standing.market.state, position: standing.position, additionalCollateralAssets: collateralSupplyAssets });
    return {
      termsVersion: TERMS.version, scope: collateralSupplyAssets > 0n ? 'selected_collateral' as const : 'existing_collateral' as const,
      shareBps: Number(TERMS.shareOfProtocolBps), limitAtomic: capacity.limitAssets.toString(),
      debtAtomic: capacity.debtAssets.toString(), availableAtomic: capacity.availableAssets.toString(),
      roundingMarginCents: capacity.roundingMarginCents.toString(),
      ...(collateralSupplyAssets > 0n ? { collateralSupplyAtomic: collateralSupplyAssets.toString() } : {}),
    };
  } catch { return null; }
}

/** Still's limit beside Morpho's own for the same collateral. Crypto is never lowered. */
export function stillBorrowComparisonWireV1(token: string, standing: MorphoBorrowStandingV1, collateralSupplyAssets = 0n) {
  const asset = stillBorrowAssetV1(token);
  if (!asset || !standing.position || standing.market.marketId.toLowerCase() !== asset.morphoMarket.toLowerCase()) return null;
  try {
    const capacity = morphoStillCapacityV1({ market: standing.market.state, position: standing.position, additionalCollateralAssets: collateralSupplyAssets });
    return stillLimitComparisonV1({ protocol: 'Morpho', protocolLimitAssets: capacity.protocolLimitAssets, stillLimitAssets: capacity.limitAssets,
      shareBps: capacity.shareBps, lowered: null });
  } catch { return null; }
}

export interface StillBorrowSnapshotV1 {
  universe: Universe;
  snapshot: WalletSnapshot;
  nativeDeployment?: NativeMorphoDeploymentV1;
  /** This wallet's allowance of the collateral to Morpho Blue at the snapshot block; null when unread. */
  collateralAllowanceToMorpho?: bigint | null;
  /** Whether cbBTC or PAXG can move at the snapshot block; null when unread, absent for WETH. */
  collateralTransfers?: MorphoCollateralTransfersV1 | null;
}

export interface StillBorrowReaderDepsV1 {
  now?: () => Date;
  snapshot?: (wallet: Address, atLeastBlock?: bigint) => Promise<StillBorrowSnapshotV1>;
  generic?: MorphoBorrowReaderDepsV1;
}

const ALLOWANCE_ABI_V1 = parseAbi(['function allowance(address owner,address spender) view returns (uint256)']);

let readFreshSnapshot: ((wallet: Address, asset: CryptoAsset, native: boolean, atLeastBlock?: bigint) => Promise<StillBorrowSnapshotV1>) | null = null;
function freshSnapshotV1(wallet: Address, asset: CryptoAsset, native: boolean, atLeastBlock?: bigint): Promise<StillBorrowSnapshotV1> {
  if (!readFreshSnapshot) {
    const providers = createProviders(stillRpcUrlsV1(), 'miorail-still-borrow/1');
    readFreshSnapshot = async (address, selected, native, atLeast) => {
      const markets = await loadMorphoUniverse(providers, [selected.id]);
      const universe: Universe = { ...markets, loadedAt: new Date(), aave: { ok: false, problem: 'unreadable' } };
      // A loan in steps is read again only at a block that holds the step that just landed.
      let at: bigint | undefined;
      if (atLeast !== undefined) {
        for (const { client } of providers) {
          try { at = await headAtLeastV1(() => client.getBlockNumber(), atLeast); break; } catch { /* the next configured provider */ }
        }
        if (at === undefined) throw new Error('borrow_head_behind');
      }
      const snapshot = await readWallet(providers, universe, address, at);
      // The wallet's own allowance to Morpho Blue, which a loan in steps sets only when it is not already exact.
      let collateralAllowanceToMorpho: bigint | null = null;
      for (const { client } of providers) {
        try {
          collateralAllowanceToMorpho = await client.readContract({ address: selected.token, abi: ALLOWANCE_ABI_V1, functionName: 'allowance',
            args: [address, ADDRESSES.morpho], blockNumber: snapshot.block.number });
          break;
        } catch { /* the next configured provider; unread stays null */ }
      }
      // Whether the collateral can move at all, read at the same block (audit LM-2): a fresh pledge of a held
      // cbBTC or PAXG only reverts in simulation, and the review said no more than that.
      const collateralTransfers = !native && morphoCollateralHoldableV1(selected)
        ? await readMorphoCollateralTransfersV1(providers.map(provider => provider.client), selected, address, snapshot.block.number) : null;
      if (!native) return { universe, snapshot, collateralAllowanceToMorpho, collateralTransfers };
      for (const { client } of providers) {
        try {
          const [chainId, bundle, weth, multicall, authorized] = await Promise.all([
            client.getChainId(),
            client.getCode({ address: MORPHO_BLUE_BUNDLES_BASE_V1, blockNumber: snapshot.block.number }),
            client.getCode({ address: ADDRESSES.weth, blockNumber: snapshot.block.number }),
            client.getCode({ address: ADDRESSES.multicall3, blockNumber: snapshot.block.number }),
            client.readContract({ address: ADDRESSES.morpho, abi: nativeMorphoAuthorizationAbiV1, functionName: 'isAuthorized',
              args: [address, MORPHO_BLUE_BUNDLES_BASE_V1], blockNumber: snapshot.block.number }),
          ]);
          if (!bundle || !weth || !multicall) continue;
          return { universe, snapshot, collateralAllowanceToMorpho, nativeDeployment: { chainId, blueBundlesRuntimeHash: keccak256(bundle),
            wethRuntimeHash: keccak256(weth), multicallRuntimeHash: keccak256(multicall), authorized } };
        } catch { /* Existing configured providers only, no credential output. */ }
      }
      throw new Error('native_deployment_unread');
    };
  }
  return readFreshSnapshot(wallet, asset, native, atLeastBlock);
}

export type StillBorrowReadingV1 = MorphoBorrowReadingV1 & {
  nativeFunding?: { balance: bigint; params: import('@mioagent/still-engine/read').MorphoParams; deployment: NativeMorphoDeploymentV1 };
};
export async function readBorrowStandingV1(input: {
  tokenAddress: string;
  walletAddress: string | null;
  nativeFunding?: boolean;
  /** A loan in steps: read at a block no earlier than the step that just landed. */
  atLeastBlock?: bigint;
  deps?: StillBorrowReaderDepsV1;
}): Promise<StillBorrowReadingV1> {
  const asset = stillBorrowAssetV1(input.tokenAddress);
  if (input.nativeFunding && asset?.id !== 'ETH') return { state: 'refused', readAt: (input.deps?.now?.() ?? new Date()).toISOString(), refusal: 'venue_unread', detail: 'Native funding is available only for the registered WETH market.' };
  if (!asset) return readMorphoBorrowStandingV1({ ...input, deps: input.deps?.generic });

  const readAt = (input.deps?.now?.() ?? new Date()).toISOString();
  const refused = (refusal: 'venue_unread' | 'position_unread' | 'oracle_did_not_answer' | 'no_wallet_given', detail: string): MorphoBorrowReadingV1 =>
    ({ state: 'refused', readAt, refusal, detail });
  const wallet = input.walletAddress?.trim().toLowerCase();
  if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) return refused('no_wallet_given', 'an exact wallet is required');

  let read: StillBorrowSnapshotV1;
  try {
    read = input.deps?.snapshot ? await input.deps.snapshot(wallet as Address, input.atLeastBlock)
      : await freshSnapshotV1(wallet as Address, asset, input.nativeFunding === true, input.atLeastBlock);
  } catch {
    return refused('venue_unread', 'Still could not read the current market from Base');
  }
  if (input.atLeastBlock !== undefined && read.snapshot.block.number < input.atLeastBlock) {
    return refused('venue_unread', 'Still could not read this market at a block that holds the step that just landed.');
  }
  const known = read.universe.morpho.find((entry) => entry.ok
    ? entry.market.asset.id === asset.id
    : entry.asset.id === asset.id);
  if (input.nativeFunding && (!read.nativeDeployment || !nativeMorphoDeploymentMatchesV1(read.nativeDeployment) ||
      !read.snapshot.nativeEth.ok || read.snapshot.nativeEth.value < 0n)) {
    return refused('venue_unread', 'The native balance or pinned wrapping deployment could not be read at this block.');
  }
  const source = read.snapshot.morpho.get(asset.id);
  if (!known?.ok || !source) return refused('venue_unread', 'the registered market could not be established');
  const params = source.info.params;
  if (
    source.info.id.toLowerCase() !== asset.morphoMarket.toLowerCase() ||
    params.loanToken.toLowerCase() !== ADDRESSES.usdc.toLowerCase() ||
    params.oracle.toLowerCase() !== known.market.params.oracle.toLowerCase() ||
    params.irm.toLowerCase() !== known.market.params.irm.toLowerCase() ||
    params.collateralToken.toLowerCase() !== asset.token.toLowerCase() ||
    params.lltv !== known.market.params.lltv || params.lltv <= 0n || params.lltv > 10n ** 18n
  ) return refused('venue_unread', 'the exact market does not match the registered collateral');
  if (!source.position.ok) return refused('position_unread', 'the wallet position could not be read');
  if (!source.price.ok || source.price.value <= 0n) return refused('oracle_did_not_answer', 'the market oracle did not give a positive price');
  if (!source.market.ok || !source.borrowRatePerSecond.ok) return refused('venue_unread', 'market totals or interest accrual could not be read');
  if (source.market.value.lastUpdate > read.snapshot.block.timestamp || read.snapshot.block.number < 0n) return refused('venue_unread', 'the market clock did not match its reading');
  const accrued = morphoAccruedTotalsV1(source.market.value, source.borrowRatePerSecond.value, read.snapshot.block.timestamp);
  if (!accrued || read.snapshot.block.number > BigInt(Number.MAX_SAFE_INTEGER)) return refused('venue_unread', 'the current accrued market could not be established');
  const state: MorphoMarketStateV1 = {
    collateralPrice: source.price.value,
    lltvWad: params.lltv,
    totalSupplyAssets: accrued.totalSupplyAssets,
    totalBorrowAssets: accrued.totalBorrowAssets,
    totalBorrowShares: accrued.totalBorrowShares,
    blockNumber: Number(read.snapshot.block.number),
  };
  const position = source.position.value;
  const collateralBalance = read.snapshot.balances.get(asset.token.toLowerCase());
  const health = morphoHealthV1({ market: state, position });
  return {
    state: 'read', readAt,
    ...(input.nativeFunding && read.nativeDeployment && read.snapshot.nativeEth.ok ? {
      nativeFunding: { balance: read.snapshot.nativeEth.value, params, deployment: read.nativeDeployment },
    } : {}),
    markets: [{
      market: {
        marketId: asset.morphoMarket,
        // Code-owned selection is not a claim that the venue curated it.
        curated: null,
        lltvBps: Number(params.lltv * 10_000n / 10n ** 18n),
        collateral: { address: asset.token, symbol: asset.id === 'ETH' ? 'WETH' : asset.symbol, decimals: asset.decimals },
        loan: { address: params.loanToken, symbol: 'USDC', decimals: 6 },
        // The reader measures an instantaneous rate, not a compounded APY.
        borrowApyWad: null,
        borrowAprWad: source.borrowRatePerSecond.value * 31_536_000n,
        oracleAddress: params.oracle,
        state,
      },
      position,
      walletCollateralAssets: collateralBalance?.ok ? collateralBalance.value : null,
      health,
      capacity: morphoBorrowCapacityV1({ market: state, position }),
      liquidationPrice: morphoLiquidationPriceV1({ market: state, position }),
      liquidationIncentiveWad: morphoLiquidationIncentiveWadV1(state.lltvWad),
      venuePublishedDebtAssets: null,
      marketParams: { loanToken: params.loanToken, collateralToken: params.collateralToken, oracle: params.oracle, irm: params.irm, lltv: params.lltv },
      collateralAllowanceToMorphoAssets: typeof read.collateralAllowanceToMorpho === 'bigint' ? read.collateralAllowanceToMorpho : null,
      collateralTransfers: read.collateralTransfers ?? null,
    }],
  };
}
