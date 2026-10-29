import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { morphoAccruedTotalsV1, toAssetsUpV1, type MorphoMarketTotalsV1, type MorphoPositionV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { createProviders, type Provider } from '@mioagent/still-engine';
import { loadMorphoUniverse, readWallet, type MorphoParams, type Universe, type WalletSnapshot } from '@mioagent/still-engine/read';
import { ADDRESSES, CRYPTO, type CryptoAsset } from '@mioagent/still-engine/registry';
import { stillRpcUrlsV1 } from './stillMirror.js';

// Official Base BlueBundlesV1 runtime, matched to verified Sourcify source and
// eth_getCode on 2026-10-28. An upgrade or a different deployment is unread until
// reviewed; a signed venue response alone does not establish these semantics.
export const STILL_REPAY_BLUE_BUNDLES_V1 = '0x4d28d900e381ece4b351302f1abe588496793a2b' as const;
export const STILL_REPAY_BLUE_BUNDLES_RUNTIME_HASH_V1 = '0x46e8135ff76a288ffd07a20f507fba7ebd79c698df7ed8737113a2de0974b65a' as const;

export interface StillRepaySnapshotV1 {
  universe: Universe;
  snapshot: WalletSnapshot;
  chainId: number;
  blueBundlesRuntimeHash: Hex;
}
export interface StillRepayReaderDepsV1 {
  now?: () => Date;
  snapshot?: (wallet: Address) => Promise<StillRepaySnapshotV1>;
}
export interface StillRepayStandingV1 {
  chainId: 8453;
  walletAddress: Address;
  marketId: Hex;
  collateral: { address: Address; symbol: string; decimals: number };
  loan: { address: Address; symbol: 'USDC'; decimals: 6 };
  params: MorphoParams;
  position: MorphoPositionV1;
  storedTotals: MorphoMarketTotalsV1;
  accruedTotals: MorphoMarketTotalsV1;
  debtAssets: bigint;
  walletLoanAssets: bigint;
  walletCollateralAssets: bigint;
  block: { number: bigint; timestamp: bigint };
  blueBundlesRuntimeHash: Hex;
}
export type StillRepayReadingV1 =
  | { state: 'read'; readAt: string; standing: StillRepayStandingV1 }
  | { state: 'refused'; readAt: string; refusal: 'repay_inputs_invalid' | 'repay_market_unread' | 'repay_position_unread' | 'repay_balance_unread' | 'repay_runtime_unread'; detail: string };

let providers: Provider[] | null = null;
async function freshSnapshotV1(wallet: Address, asset: CryptoAsset): Promise<StillRepaySnapshotV1> {
  providers ??= createProviders(stillRpcUrlsV1(), 'miorail-still-repay/1');
  const baseProviders: Provider[] = [];
  for (const provider of providers) {
    try { if (await provider.client.getChainId() === 8453) baseProviders.push(provider); } catch { /* Not a Base read. */ }
  }
  if (baseProviders.length === 0) throw new Error('repay_chain_unread');
  const markets = await loadMorphoUniverse(baseProviders, [asset.id]);
  const universe: Universe = { ...markets, loadedAt: new Date(), aave: { ok: false, problem: 'unreadable' } };
  const snapshot = await readWallet(baseProviders, universe, wallet);
  const ordered = [...baseProviders].sort((a, b) => Number(b.label === snapshot.provider) - Number(a.label === snapshot.provider));
  for (const provider of ordered) {
    try {
      const code = await provider.client.getCode({ address: STILL_REPAY_BLUE_BUNDLES_V1, blockNumber: snapshot.block.number });
      if (!code || code === '0x') continue;
      return { universe, snapshot, chainId: 8453, blueBundlesRuntimeHash: keccak256(code) };
    } catch { /* Try only the already configured providers; never print URLs. */ }
  }
  throw new Error('repay_runtime_unread');
}

const UINT128_MAX = (1n << 128n) - 1n;
const address = (value: string): value is Address => /^0x[0-9a-f]{40}$/.test(value) && value !== `0x${'0'.repeat(40)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const uint128 = (value: bigint) => typeof value === 'bigint' && value >= 0n && value <= UINT128_MAX;

/** Exact registered repayment state, at one block. An unread oracle, exhausted
 * liquidity or a position outside Still's new-loan limit cannot block a repay.
 * Interest still has to be read: unknown debt is never replaced with zero. */
export async function readRepayStandingV1(input: {
  collateralTokenAddress: string;
  marketId: string;
  walletAddress: string | null;
  deps?: StillRepayReaderDepsV1;
}): Promise<StillRepayReadingV1> {
  const readAt = (input.deps?.now?.() ?? new Date()).toISOString();
  const refused = (refusal: Extract<StillRepayReadingV1, { state: 'refused' }>['refusal'], detail: string): StillRepayReadingV1 => ({ state: 'refused', readAt, refusal, detail });
  const wallet = input.walletAddress?.trim().toLowerCase() ?? '';
  const token = input.collateralTokenAddress.trim().toLowerCase(), marketId = input.marketId.trim().toLowerCase();
  const asset = CRYPTO.find(row => same(row.token, token) && same(row.morphoMarket, marketId));
  if (!address(wallet) || !asset) return refused('repay_inputs_invalid', 'An exact registered market and repayment wallet are required.');
  let read: StillRepaySnapshotV1;
  try { read = input.deps?.snapshot ? await input.deps.snapshot(wallet) : await freshSnapshotV1(wallet, asset); }
  catch { return refused('repay_market_unread', 'The current repayment state could not be read from Base.'); }
  if (read.chainId !== 8453 || read.blueBundlesRuntimeHash.toLowerCase() !== STILL_REPAY_BLUE_BUNDLES_RUNTIME_HASH_V1) {
    return refused('repay_runtime_unread', 'The reviewed repayment implementation was not established at this block.');
  }
  const source = read.snapshot.morpho.get(asset.id);
  const known = read.universe.morpho.find(row => row.ok && row.market.asset.id === asset.id);
  if (!known?.ok || !source || !same(source.info.id, marketId)) return refused('repay_market_unread', 'The registered repayment market could not be established.');
  const params = source.info.params;
  const paramsId = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
  ));
  if (paramsId !== marketId || !same(params.loanToken, ADDRESSES.usdc) || !same(params.collateralToken, asset.token) ||
      !same(params.oracle, known.market.params.oracle) || !same(params.irm, known.market.params.irm) ||
      params.lltv !== known.market.params.lltv || params.lltv <= 0n || params.lltv > 10n ** 18n) {
    return refused('repay_market_unread', 'The immutable parameters do not match the registered repayment market.');
  }
  if (!source.position.ok) return refused('repay_position_unread', 'The current debt shares and collateral could not be read.');
  if (!source.market.ok || !source.borrowRatePerSecond.ok) return refused('repay_market_unread', 'Market totals or interest accrual could not be read.');
  const { block } = read.snapshot, totals = source.market.value, position = source.position.value;
  if (block.number < 0n || block.timestamp < 0n || totals.lastUpdate > block.timestamp ||
      !Object.values(totals).every(uint128) || totals.fee > 10n ** 18n || !uint128(source.borrowRatePerSecond.value) ||
      !uint128(position.borrowShares) || !uint128(position.collateral) || position.borrowShares > totals.totalBorrowShares) {
    return refused('repay_market_unread', 'The repayment market state or clock is inconsistent.');
  }
  const loan = read.snapshot.balances.get(ADDRESSES.usdc.toLowerCase()), collateral = read.snapshot.balances.get(asset.token.toLowerCase());
  if (!loan?.ok || !collateral?.ok || loan.value < 0n || collateral.value < 0n) return refused('repay_balance_unread', 'The exact wallet USDC and collateral balances could not be read at this block.');
  const accrued = morphoAccruedTotalsV1(totals, source.borrowRatePerSecond.value, block.timestamp);
  if (!Object.values(accrued).every(uint128)) return refused('repay_market_unread', 'The accrued market state could not be established.');
  return { state: 'read', readAt, standing: {
    chainId: 8453, walletAddress: wallet, marketId: asset.morphoMarket,
    collateral: { address: asset.token, symbol: asset.id === 'ETH' ? 'WETH' : asset.symbol, decimals: asset.decimals },
    loan: { address: ADDRESSES.usdc, symbol: 'USDC', decimals: 6 }, params, position,
    storedTotals: totals, accruedTotals: accrued,
    debtAssets: toAssetsUpV1(position.borrowShares, accrued.totalBorrowAssets, accrued.totalBorrowShares),
    walletLoanAssets: loan.value, walletCollateralAssets: collateral.value, block,
    blueBundlesRuntimeHash: read.blueBundlesRuntimeHash,
  } };
}
