import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { ADDRESSES, type CryptoAsset, type CryptoId } from '@mioagent/still-engine/registry';
import { collateralTransfersPausedWordsV1 } from './lendingStress.js';

// ---------------------------------------------------------------------------
// What can keep a Morpho collateral from moving, read from the token itself
// (audits LM-2 and LM-3, 2026-11-14).
//
// The pause probe read only `paused()`. cbBTC and PAXG can each also block one
// address, and either block holds the collateral as surely as a pause. Read on
// Base:
// - cbBTC is Circle's FiatTokenV2_1 (implementation 0x7458…aa72, Sourcify exact
//   match): `transfer` and `transferFrom` are `whenNotPaused` and
//   `notBlacklisted` for the caller, the sender and the recipient, and
//   `isBlacklisted(address)` says who is blocked ("Blacklistable: account is
//   blacklisted").
// - PAXG's implementation (0xc623…4037) has no published source. Its code
//   carries `paused()`, `isFrozen(address)` and `freeze(address)`, and with a
//   state override at block 57,208,503 (`isFrozen` reads slot 7) a transfer out
//   of Morpho Blue reverted both when Morpho Blue was frozen and when its
//   recipient was; with nothing frozen it went through.
// So a frozen Morpho Blue holds every pledge in the market: nothing comes back
// and nothing new goes in, and a liquidation, which hands the collateral to the
// liquidator, waits too. A frozen wallet can neither pledge nor take its
// collateral back, while a liquidation still pays the liquidator. Repaying
// moves only USDC and works through all three. WETH has none of them, and is
// never asked.
// ---------------------------------------------------------------------------

export const MORPHO_COLLATERAL_HOLD_ABI_V1 = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)',
  'function paused() view returns (bool)',
  'function isBlacklisted(address account) view returns (bool)',
  'function isFrozen(address account) view returns (bool)',
]);

/** Each holdable collateral's own getter for a blocked address. */
const FREEZE_GETTER_V1: Partial<Record<CryptoId, 'isBlacklisted' | 'isFrozen'>> = { cbBTC: 'isBlacklisted', PAXG: 'isFrozen' };

/** What holds the collateral: every transfer paused, Morpho Blue's address blocked, or this wallet's. */
export type MorphoCollateralHoldV1 = 'paused' | 'market_frozen' | 'wallet_frozen';
/** The three answers at one block; each null when it was not read. */
export interface MorphoCollateralTransfersV1 { paused: boolean | null; marketFrozen: boolean | null; walletFrozen: boolean | null }

/** Whether this collateral can be held at all: cbBTC and PAXG can; WETH cannot. */
export function morphoCollateralHoldableV1(asset: Pick<CryptoAsset, 'id'>): boolean {
  return FREEZE_GETTER_V1[asset.id] !== undefined;
}

/** `paused()`, then the token's own block of Morpho Blue and of this wallet, through Multicall3 with
 * allowFailure, so a getter that does not answer leaves that one answer unread. Null for WETH. */
export function morphoCollateralHoldCallDataV1(asset: Pick<CryptoAsset, 'id' | 'token'>, walletAddress: string): Hex | null {
  const freeze = FREEZE_GETTER_V1[asset.id];
  if (!freeze || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) return null;
  const token = asset.token.toLowerCase() as Address;
  const call = (callData: Hex) => ({ target: token, allowFailure: true, callData });
  return encodeFunctionData({ abi: MORPHO_COLLATERAL_HOLD_ABI_V1, functionName: 'aggregate3', args: [[
    call(encodeFunctionData({ abi: MORPHO_COLLATERAL_HOLD_ABI_V1, functionName: 'paused' })),
    call(encodeFunctionData({ abi: MORPHO_COLLATERAL_HOLD_ABI_V1, functionName: freeze, args: [ADDRESSES.morpho.toLowerCase() as Address] })),
    call(encodeFunctionData({ abi: MORPHO_COLLATERAL_HOLD_ABI_V1, functionName: freeze, args: [walletAddress.toLowerCase() as Address] })),
  ]] });
}

/** Each answer true or false only from a complete one-word answer, otherwise unread; null when the answer
 * is not the three rows asked. */
export function decodeMorphoCollateralTransfersV1(data: Hex | undefined | null): MorphoCollateralTransfersV1 | null {
  if (!data) return null;
  try {
    const rows = decodeFunctionResult({ abi: MORPHO_COLLATERAL_HOLD_ABI_V1, functionName: 'aggregate3', data });
    if (rows.length !== 3) return null;
    const word = (row: { success: boolean; returnData: Hex }): boolean | null =>
      row.success && /^0x0{63}[01]$/.test(row.returnData) ? row.returnData.endsWith('1') : null;
    return { paused: word(rows[0]!), marketFrozen: word(rows[1]!), walletFrozen: word(rows[2]!) };
  } catch { return null; }
}

/** What holds the collateral, the reason that holds the whole market first; null when nothing read holds it. */
export function morphoCollateralHoldOfV1(read: MorphoCollateralTransfersV1 | null | undefined): MorphoCollateralHoldV1 | null {
  if (!read) return null;
  return read.paused === true ? 'paused' : read.marketFrozen === true ? 'market_frozen' : read.walletFrozen === true ? 'wallet_frozen' : null;
}

/** Whether the collateral is held: true when anything read holds it, false only when all three read no, else unread. */
export function morphoCollateralHeldV1(read: MorphoCollateralTransfersV1 | null | undefined): boolean | null {
  if (!read) return null;
  if (morphoCollateralHoldOfV1(read) !== null) return true;
  return read.paused === false && read.marketFrozen === false && read.walletFrozen === false ? false : null;
}

/** The three answers at a block, from the first client that gives a complete answer; null when none does
 * or the collateral cannot be held. */
export async function readMorphoCollateralTransfersV1(
  clients: readonly { call(args: { to: Address; data: Hex; blockNumber: bigint }): Promise<{ data?: Hex | undefined }> }[],
  asset: Pick<CryptoAsset, 'id' | 'token'>, walletAddress: string, blockNumber: bigint,
): Promise<MorphoCollateralTransfersV1 | null> {
  const data = morphoCollateralHoldCallDataV1(asset, walletAddress);
  if (!data) return null;
  for (const client of clients) {
    try {
      const answer = await client.call({ to: ADDRESSES.multicall3 as Address, data, blockNumber });
      const read = decodeMorphoCollateralTransfersV1(answer.data);
      if (read) return read;
    } catch { /* the next configured provider; unread stays null */ }
  }
  return null;
}

/** Said when the collateral is held: a new loan is not opened, the collateral cannot be taken back now, or a
 * plain repayment goes ahead with the collateral staying where it is. Repaying works in every case. */
export function morphoCollateralHoldWordsV1(input: { symbol: string; hold: MorphoCollateralHoldV1; blockNumber: number | bigint;
  action: 'borrow' | 'take_back' | 'repay'; /** A take-back with no debt left to repay first. */ debtOpen?: boolean }): string {
  const { symbol, hold, action } = input;
  const at = `Base block ${BigInt(input.blockNumber).toLocaleString('en-US')}`;
  if (hold === 'paused' && action === 'borrow') return collateralTransfersPausedWordsV1({ symbol, venue: 'morpho', blockNumber: Number(input.blockNumber) });
  const what = hold === 'paused' ? `${symbol} transfers are paused onchain (${at})`
    : hold === 'market_frozen' ? `${symbol}’s issuer has frozen the ${symbol} held by Morpho Blue (${at}), so no ${symbol} moves into or out of this market`
      : `${symbol}’s issuer has frozen this wallet’s ${symbol} (${at}), so it can neither pledge ${symbol} nor take it back`;
  const until = hold === 'paused' ? 'until transfers resume' : 'until the freeze is lifted';
  if (action === 'borrow') {
    return hold === 'market_frozen'
      ? `${what}. Still opens no new loan against ${symbol} while the freeze lasts: it could not be taken back. Repaying works.`
      : `${what}, while a liquidation could still take the collateral. Still opens no new loan for this wallet against ${symbol} while the freeze lasts. Repaying works.`;
  }
  if (action === 'take_back') {
    return input.debtOpen === false
      ? `${what}. The collateral cannot come back to this wallet now, so this review was not prepared. It stays deposited ${until}; with no debt open in this market there is nothing to liquidate.`
      : `${what}. The collateral cannot come back to this wallet now, so this review was not prepared. Repay all debt without taking it back works: `
        + `the ${symbol} stays deposited ${until}, and a loan repaid in full has nothing left to liquidate.`;
  }
  return `${what}. This repayment works, and the ${symbol} stays deposited ${until}.`;
}
