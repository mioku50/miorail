import { decodeEventLog, decodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { createProviders, type Provider } from '@mioagent/still-engine/rpc';
import { ADDRESSES, STOCKS, CRYPTO } from '@mioagent/still-engine/registry';
import { aaveSpokeAbi, morphoAbi } from '@mioagent/still-engine/abi';
import { toAssetsUpV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { stillRpcUrlsV1 } from './stillMirror.js';
import { readAaveV4DeploymentAtV1 } from './stillAaveStanding.js';
import { matchesAaveV4DeploymentV1, aaveV4WriteAbiV1 } from './aaveV4BorrowPlan.js';
import type { LoanEffectPositionCheckV1 } from './loanExecutionStatus.js';
import type { LendingFactsV1 } from './lendingReview.js';
import type { VerifiedReceiptLogV1 } from '@mioagent/route-proof';
import { STILL_REPAY_BLUE_BUNDLES_V1 } from './stillRepayStanding.js';

const events = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Borrow(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets,uint256 shares)',
  'event Repay(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets,uint256 shares)',
  'event SupplyCollateral(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets)',
  'event WithdrawCollateral(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets)',
  'event Borrow(uint256 indexed reserveId,address indexed caller,address indexed user,uint256 drawnShares,uint256 drawnAmount)',
  'event Repay(uint256 indexed reserveId,address indexed caller,address indexed user,uint256 drawnShares,uint256 totalAmountRepaid,(int256 sharesDelta,int256 offsetRayDelta,uint256 restoredPremiumRay) premiumDelta)',
  'event Supply(uint256 indexed reserveId,address indexed caller,address indexed user,uint256 suppliedShares,uint256 suppliedAmount)',
  'event Withdraw(uint256 indexed reserveId,address indexed caller,address indexed user,uint256 suppliedShares,uint256 suppliedAmount)',
]);
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
type EventV1 = { name: string; args: Record<string, unknown>; address: string };
function decoded(log: VerifiedReceiptLogV1): EventV1 | null {
  try {
    const e = decodeEventLog({ abi: events, topics: [...log.topics] as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
    return { name: e.eventName, args: e.args as unknown as Record<string, unknown>, address: log.address.toLowerCase() };
  } catch { return null; }
}
export interface LendingReceiptPositionV1 { debtAssets: bigint; collateralAssets: bigint; debtShares: bigint; collateralShares?: bigint; premiumDebtRay?: bigint }
export interface LendingReceiptDepsV1 {
  position?: (facts: LendingFactsV1, wallet: Address, block: bigint) => Promise<LendingReceiptPositionV1 | null>;
}
let providers: Provider[] | null = null;
async function positionAt(f: LendingFactsV1, wallet: Address, at: bigint): Promise<LendingReceiptPositionV1 | null> {
  providers ??= createProviders(stillRpcUrlsV1(), 'miorail-loan-receipts/1');
  if (f.venue === 'aave-v4') {
    const pin = await readAaveV4DeploymentAtV1(Number(at));
    if (!pin || !matchesAaveV4DeploymentV1(pin)) return null;
  }
  for (const { client } of providers) {
    try {
      if (await client.getChainId() !== 8453) continue;
      if (f.venue === 'morpho') {
        const asset = CRYPTO.find(row => row.morphoMarket === f.marketId && same(row.token, f.collateralTokenAddress));
        if (!asset) return null;
        const [p, m] = await Promise.all([
          client.readContract({ address: ADDRESSES.morpho, abi: morphoAbi, functionName: 'position', args: [asset.morphoMarket, wallet], blockNumber: at }),
          client.readContract({ address: ADDRESSES.morpho, abi: morphoAbi, functionName: 'market', args: [asset.morphoMarket], blockNumber: at }),
        ]);
        return { debtShares: p[1], collateralAssets: p[2], debtAssets: toAssetsUpV1(p[1], m[2], m[3]) };
      }
      const count = await client.readContract({ address: ADDRESSES.aaveSpoke, abi: aaveSpokeAbi, functionName: 'getReserveCount', blockNumber: at });
      if (count < 2n || count > 8n) return null;
      const list = await Promise.all(Array.from({ length: Number(count) }, async (_, reserveId) => ({ reserveId,
        r: await client.readContract({ address: ADDRESSES.aaveSpoke, abi: aaveSpokeAbi, functionName: 'getReserve', args: [BigInt(reserveId)], blockNumber: at }) })));
      const usdc = list.filter(row => same(row.r.underlying, ADDRESSES.usdc) && same(row.r.hub, ADDRESSES.aaveHub) && row.r.decimals === 6);
      const stock = list.filter(row => same(row.r.underlying, f.collateralTokenAddress) && same(row.r.hub, ADDRESSES.aaveHub) && row.r.decimals === f.collateralDecimals);
      if (usdc.length !== 1 || stock.length !== 1 || !STOCKS.some(row => same(row.token, f.collateralTokenAddress))) return null;
      const [debt, collateral, p, stockPosition] = await Promise.all([
        client.readContract({ address: ADDRESSES.aaveSpoke, abi: aaveSpokeAbi, functionName: 'getUserTotalDebt', args: [BigInt(usdc[0]!.reserveId), wallet], blockNumber: at }),
        client.readContract({ address: ADDRESSES.aaveSpoke, abi: aaveSpokeAbi, functionName: 'getUserSuppliedAssets', args: [BigInt(stock[0]!.reserveId), wallet], blockNumber: at }),
        client.readContract({ address: ADDRESSES.aaveSpoke, abi: aaveSpokeAbi, functionName: 'getUserPosition', args: [BigInt(usdc[0]!.reserveId), wallet], blockNumber: at }),
        client.readContract({ address: ADDRESSES.aaveSpoke, abi: aaveSpokeAbi, functionName: 'getUserPosition', args: [BigInt(stock[0]!.reserveId), wallet], blockNumber: at }),
      ]);
      return { debtAssets: debt, collateralAssets: collateral, debtShares: p.drawnShares, collateralShares: stockPosition.suppliedShares };
    } catch { /* A missing historic read stays unknown; no oracle fallback. */ }
  }
  return null;
}

/** Called only AFTER the exact approved wallet operation and its own success
 * event have been matched. Receipt logs are isolated from other UserOperations.
 * Protocol events prove the action, token movements prove the bounded funding,
 * and the pinned-block position proves what remained. An unread/mismatch never
 * unlocks an unknown attempt or becomes a claim that money did not move. */
export function lendingReceiptVerifierV1(deps: LendingReceiptDepsV1 = {}): LoanEffectPositionCheckV1 {
  return async ({ execution, receipt, logs }) => {
    const f = execution.run.facts, wallet = execution.walletAddress.toLowerCase();
    const unknown = (errorCode: string) => ({ state: 'unavailable' as const, errorCode });
    const mismatch = (errorCode: string) => ({ state: 'mismatched' as const, errorCode });
    if (receipt.blockNumber < BigInt(f.blockNumber)) return mismatch('loan_receipt_predates_review');
    const rows = logs.map(decoded).filter((e): e is EventV1 => e !== null);
    let usdcNet = 0n, collateralOut = 0n, grossUsdcOut = 0n;
    for (const e of rows.filter(e => e.name === 'Transfer')) {
      const amount = e.args.value; if (typeof amount !== 'bigint' || amount === 0n) continue;
      const out = same(e.args.from, wallet), into = same(e.args.to, wallet);
      if (!out && !into) continue;
      if (e.address === ADDRESSES.usdc.toLowerCase()) { usdcNet += into ? amount : 0n; usdcNet -= out ? amount : 0n; if (out) grossUsdcOut += amount; }
      else if (e.address === f.collateralTokenAddress.toLowerCase() && f.operation === 'borrow' && out && !into) collateralOut += amount;
      else return mismatch('loan_unrequested_receipt_asset_change');
    }
    const contract = f.venue === 'morpho' ? ADDRESSES.morpho.toLowerCase() : ADDRESSES.aaveSpoke.toLowerCase();
    const protocol = rows.filter(e => e.address === contract && (same(e.args.onBehalf, wallet) || same(e.args.user, wallet)));
    if (protocol.some(e => e.name === 'WithdrawCollateral' || e.name === 'Withdraw')) return mismatch('loan_unrequested_collateral_withdrawal');
    const action = protocol.filter(e => e.name === (f.operation === 'borrow' ? 'Borrow' : 'Repay'));
    if (action.length !== 1) return mismatch('loan_protocol_event_not_unique');
    const e = action[0]!;
    let assets: bigint, shares: bigint;
    if (f.venue === 'morpho') {
      if (!same(e.args.id, f.marketId) || typeof e.args.assets !== 'bigint' || typeof e.args.shares !== 'bigint' || e.args.assets <= 0n || e.args.shares <= 0n
        || (f.operation === 'borrow' && !same(e.args.receiver, wallet))) return mismatch('loan_protocol_event_mismatch');
      assets = e.args.assets; shares = e.args.shares;
      if (f.operation === 'repay' && !same(e.args.caller, STILL_REPAY_BLUE_BUNDLES_V1)) return mismatch('loan_protocol_caller_mismatch');
      if (f.operation === 'borrow' && !execution.run.calls.some(call => same(call.to, String(e.args.caller)))) return unknown('loan_protocol_caller_unread');
    } else {
      // Reserve identity is decoded from the actual canonical method below,
      // rather than inferred from a display symbol or a fixed reserve order.
      const methods = execution.run.calls.filter(call => call.to.toLowerCase() === contract).flatMap(call => {
        try { const value = decodeFunctionData({ abi: aaveV4WriteAbiV1, data: call.data as Hex }); return value.functionName === f.operation ? [value] : []; }
        catch { return []; }
      });
      if (methods.length !== 1 || e.args.reserveId !== methods[0]!.args[0] || !same(e.args.caller, wallet)) return mismatch('loan_protocol_event_mismatch');
      const amount = f.operation === 'borrow' ? e.args.drawnAmount : e.args.totalAmountRepaid;
      if (typeof amount !== 'bigint' || amount <= 0n || typeof e.args.drawnShares !== 'bigint') return mismatch('loan_protocol_event_mismatch');
      assets = amount; shares = e.args.drawnShares;
    }
    const requested = f.requestedAssets === null ? null : BigInt(f.requestedAssets), maximum = BigInt(f.maximumDebitAssets);
    if (f.operation === 'borrow') {
      if (requested === null || assets !== requested || usdcNet !== assets || collateralOut !== BigInt(f.collateralSupplyAssets) || grossUsdcOut !== 0n) return mismatch('loan_borrow_receipt_mismatch');
      if (f.venue === 'morpho') {
        const supplied = protocol.filter(e => e.name === 'SupplyCollateral');
        if (BigInt(f.collateralSupplyAssets) > 0n ? supplied.length !== 1 || !same(supplied[0]?.args.id, f.marketId) || supplied[0]?.args.assets !== BigInt(f.collateralSupplyAssets) : supplied.length !== 0) return mismatch('loan_collateral_event_mismatch');
      }
    } else if (assets > maximum || usdcNet !== -assets || collateralOut !== 0n || grossUsdcOut > maximum ||
        (f.venue === 'morpho' && grossUsdcOut !== maximum) || (f.amountMode === 'assets' && assets !== requested)) return mismatch('loan_repay_receipt_mismatch');
    const p = await (deps.position ?? positionAt)(f, wallet as Address, receipt.blockNumber);
    if (!p) return unknown('loan_position_at_receipt_unread');
    if (f.venue === 'morpho') {
      if (f.debtBeforeShares === null) return unknown('loan_initial_shares_unread');
      const before = BigInt(f.debtBeforeShares), expected = f.operation === 'borrow' ? before + shares : f.amountMode === 'all' ? 0n : before - shares;
      if (expected < 0n || p.debtShares !== expected || p.collateralAssets !== BigInt(f.collateralBeforeAssets) + BigInt(f.collateralSupplyAssets)) return unknown('loan_position_changed_outside_receipt');
    } else {
      if (f.debtBeforeShares === null) return unknown('loan_initial_shares_unread');
      const expectedDebtShares = f.operation === 'borrow' ? BigInt(f.debtBeforeShares) + shares :
        f.amountMode === 'all' ? 0n : BigInt(f.debtBeforeShares) - shares;
      if (expectedDebtShares < 0n || p.debtShares !== expectedDebtShares) return unknown('loan_debt_shares_changed');
      if (f.collateralBeforeShares === undefined || f.collateralBeforeShares === null || p.collateralShares === undefined) return unknown('loan_collateral_shares_unread');
      let suppliedShares = 0n;
      const supplies = protocol.filter(row => row.name === 'Supply');
      if (f.operation === 'borrow' && BigInt(f.collateralSupplyAssets) > 0n) {
        const supplyMethods = execution.run.calls.filter(call => call.to.toLowerCase() === contract).flatMap(call => {
          try { const value = decodeFunctionData({ abi: aaveV4WriteAbiV1, data: call.data as Hex }); return value.functionName === 'supply' ? [value] : []; } catch { return []; }
        });
        if (supplies.length !== 1 || supplyMethods.length !== 1 || supplies[0]!.args.reserveId !== supplyMethods[0]!.args[0] ||
          !same(supplies[0]!.args.caller, wallet) || supplies[0]!.args.suppliedAmount !== BigInt(f.collateralSupplyAssets) ||
          typeof supplies[0]!.args.suppliedShares !== 'bigint' || supplies[0]!.args.suppliedShares <= 0n) return mismatch('loan_collateral_event_mismatch');
        suppliedShares = supplies[0]!.args.suppliedShares;
      } else if (supplies.length !== 0) return mismatch('loan_unrequested_supply');
      if (p.collateralShares !== BigInt(f.collateralBeforeShares) + suppliedShares) return unknown('loan_collateral_position_changed');
      // Deposit value and premium can accrue after review. The exact own
      // Repay event, USDC debit and principal-share delta prove repayment;
      // comparing the final debt against a stale review would reject a real
      // premium-only payment. Collateral SHARES above remain the invariant.
      if (p.debtAssets < 0n || p.collateralAssets < BigInt(f.collateralBeforeAssets) ||
          (f.operation === 'borrow' && p.debtAssets < assets)) return unknown('loan_position_changed_outside_receipt');
    }
    if (f.operation === 'repay' && f.amountMode === 'all' && (p.debtAssets !== 0n || p.debtShares !== 0n)) return unknown('loan_full_repayment_not_closed');
    return { state: 'matched', proof: { operation: f.operation, venue: f.venue, appliedAssets: assets.toString(), appliedShares: shares.toString(),
      remainingDebtAssets: p.debtAssets.toString(), remainingDebtShares: p.debtShares.toString(), collateralAssets: p.collateralAssets.toString(), blockNumber: receipt.blockNumber.toString() } };
  };
}
export const verifyLendingEffectsAtReceiptV1: LoanEffectPositionCheckV1 = lendingReceiptVerifierV1();
