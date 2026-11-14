import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';
import {
  decodeMorphoCollateralTransfersV1, MORPHO_COLLATERAL_HOLD_ABI_V1, morphoCollateralHeldV1, morphoCollateralHoldableV1, morphoCollateralHoldCallDataV1,
  morphoCollateralHoldOfV1, morphoCollateralHoldWordsV1, readMorphoCollateralTransfersV1,
} from './morphoCollateralHold.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const cbBTC = CRYPTO.find(asset => asset.id === 'cbBTC')!, PAXG = CRYPTO.find(asset => asset.id === 'PAXG')!, WETH = CRYPTO.find(asset => asset.id === 'ETH')!;
const word = (abi: typeof MORPHO_COLLATERAL_HOLD_ABI_V1, name: 'paused' | 'isBlacklisted' | 'isFrozen', value: boolean) =>
  ({ success: true, returnData: encodeFunctionResult({ abi, functionName: name, result: value }) });
const answer = (rows: { success: boolean; returnData: Hex }[]) => encodeFunctionResult({ abi: MORPHO_COLLATERAL_HOLD_ABI_V1, functionName: 'aggregate3', result: rows });

describe('what can keep a Morpho collateral from moving (audits LM-2, LM-3)', () => {
  it('asks each holdable token its pause, then its own block of Morpho Blue and of this wallet', () => {
    for (const [asset, getter] of [[cbBTC, 'isBlacklisted'], [PAXG, 'isFrozen']] as const) {
      const data = morphoCollateralHoldCallDataV1(asset, WALLET)!;
      const call = decodeFunctionData({ abi: MORPHO_COLLATERAL_HOLD_ABI_V1, data });
      assert.equal(call.functionName, 'aggregate3');
      const rows = call.args![0] as readonly { target: string; allowFailure: boolean; callData: Hex }[];
      assert(rows.every(row => row.target.toLowerCase() === asset.token.toLowerCase() && row.allowFailure));
      assert.deepEqual(rows.map(row => { const read = decodeFunctionData({ abi: MORPHO_COLLATERAL_HOLD_ABI_V1, data: row.callData });
        return [read.functionName, ...(read.args ?? []).map(arg => String(arg).toLowerCase())]; }),
        [['paused'], [getter, ADDRESSES.morpho.toLowerCase()], [getter, WALLET]]);
      assert.equal(morphoCollateralHoldableV1(asset), true);
    }
    // WETH cannot be paused or block anyone: nothing is asked.
    assert.equal(morphoCollateralHoldableV1(WETH), false);
    assert.equal(morphoCollateralHoldCallDataV1(WETH, WALLET), null);
    assert.equal(morphoCollateralHoldCallDataV1(cbBTC, 'not an address'), null);
  });
  it('reads each answer only from a whole one-word answer, and names the hold that holds the whole market first', () => {
    const abi = MORPHO_COLLATERAL_HOLD_ABI_V1;
    const none = decodeMorphoCollateralTransfersV1(answer([word(abi, 'paused', false), word(abi, 'isFrozen', false), word(abi, 'isFrozen', false)]));
    assert.deepEqual(none, { paused: false, marketFrozen: false, walletFrozen: false });
    assert.deepEqual([morphoCollateralHoldOfV1(none), morphoCollateralHeldV1(none)], [null, false]);
    const wallet = decodeMorphoCollateralTransfersV1(answer([word(abi, 'paused', false), word(abi, 'isFrozen', false), word(abi, 'isFrozen', true)]));
    assert.deepEqual([morphoCollateralHoldOfV1(wallet), morphoCollateralHeldV1(wallet)], ['wallet_frozen', true]);
    const both = decodeMorphoCollateralTransfersV1(answer([word(abi, 'paused', false), word(abi, 'isFrozen', true), word(abi, 'isFrozen', true)]));
    assert.equal(morphoCollateralHoldOfV1(both), 'market_frozen');
    const paused = decodeMorphoCollateralTransfersV1(answer([word(abi, 'paused', true), word(abi, 'isFrozen', true), { success: false, returnData: '0x' }]));
    assert.deepEqual(paused, { paused: true, marketFrozen: true, walletFrozen: null });
    assert.equal(morphoCollateralHoldOfV1(paused), 'paused');
    // An unanswered part with nothing else holding it is unread, never "free to move".
    const partly = decodeMorphoCollateralTransfersV1(answer([word(abi, 'paused', false), { success: false, returnData: '0x' }, word(abi, 'isFrozen', false)]));
    assert.deepEqual([morphoCollateralHoldOfV1(partly), morphoCollateralHeldV1(partly)], [null, null]);
    // Not the three rows asked, a long word, or nothing at all: unread.
    assert.equal(decodeMorphoCollateralTransfersV1(answer([word(abi, 'paused', true)])), null);
    assert.deepEqual(decodeMorphoCollateralTransfersV1(answer([{ success: true, returnData: `0x${'0'.repeat(63)}1${'0'.repeat(64)}` }, word(abi, 'isFrozen', false), word(abi, 'isFrozen', false)]))?.paused, null);
    assert.equal(decodeMorphoCollateralTransfersV1('0x1234'), null);
    assert.equal(decodeMorphoCollateralTransfersV1(undefined), null);
    assert.deepEqual([morphoCollateralHoldOfV1(null), morphoCollateralHeldV1(undefined)], [null, null]);
  });
  it('reads at the given block from the first provider that answers whole, and leaves it unread when none does', async () => {
    const abi = MORPHO_COLLATERAL_HOLD_ABI_V1, seen: bigint[] = [];
    const whole = answer([word(abi, 'paused', false), word(abi, 'isFrozen', true), word(abi, 'isFrozen', false)]);
    const read = await readMorphoCollateralTransfersV1([
      { call: async () => { throw new Error('first provider down'); } },
      { call: async (args) => { seen.push(args.blockNumber); assert.equal(args.to.toLowerCase(), ADDRESSES.multicall3.toLowerCase()); return { data: whole }; } },
    ], PAXG, WALLET, 57_208_503n);
    assert.deepEqual(read, { paused: false, marketFrozen: true, walletFrozen: false });
    assert.deepEqual(seen, [57_208_503n]);
    assert.equal(await readMorphoCollateralTransfersV1([{ call: async () => ({ data: '0x' }) }], PAXG, WALLET, 1n), null);
    let asked = false;
    assert.equal(await readMorphoCollateralTransfersV1([{ call: async () => { asked = true; return { data: whole }; } }], WETH, WALLET, 1n), null);
    assert.equal(asked, false);
  });
  it('says what holds the collateral, and that repaying works, for a loan, a take-back and a repayment', () => {
    const at = { symbol: 'PAXG', blockNumber: 57_208_503 };
    assert.match(morphoCollateralHoldWordsV1({ ...at, hold: 'paused', action: 'borrow' }), /^PAXG transfers are paused onchain \(Base block 57,208,503\)\. Still opens no new loan against it while they are: PAXG could not be taken back\. Repaying works\.$/);
    assert.equal(morphoCollateralHoldWordsV1({ ...at, hold: 'market_frozen', action: 'borrow' }),
      'PAXG’s issuer has frozen the PAXG held by Morpho Blue (Base block 57,208,503), so no PAXG moves into or out of this market. Still opens no new loan against PAXG while the freeze lasts: it could not be taken back. Repaying works.');
    assert.equal(morphoCollateralHoldWordsV1({ ...at, hold: 'wallet_frozen', action: 'borrow' }),
      'PAXG’s issuer has frozen this wallet’s PAXG (Base block 57,208,503), so it can neither pledge PAXG nor take it back, while a liquidation could still take the collateral. Still opens no new loan for this wallet against PAXG while the freeze lasts. Repaying works.');
    assert.equal(morphoCollateralHoldWordsV1({ ...at, symbol: 'cbBTC', hold: 'paused', action: 'take_back' }),
      'cbBTC transfers are paused onchain (Base block 57,208,503). The collateral cannot come back to this wallet now, so this review was not prepared. Repay all debt without taking it back works: '
      + 'the cbBTC stays deposited until transfers resume, and a loan repaid in full has nothing left to liquidate.');
    assert.match(morphoCollateralHoldWordsV1({ ...at, hold: 'wallet_frozen', action: 'take_back' }), /stays deposited until the freeze is lifted, and a loan repaid in full has nothing left to liquidate\.$/);
    assert.equal(morphoCollateralHoldWordsV1({ ...at, hold: 'market_frozen', action: 'repay' }),
      'PAXG’s issuer has frozen the PAXG held by Morpho Blue (Base block 57,208,503), so no PAXG moves into or out of this market. This repayment works, and the PAXG stays deposited until the freeze is lifted.');
    // A reading with no block named says it without one.
    assert.equal(morphoCollateralHoldWordsV1({ symbol: 'cbBTC', blockNumber: null, hold: 'paused', action: 'borrow' }),
      'cbBTC transfers are paused onchain. Still opens no new loan against it while they are: cbBTC could not be taken back. Repaying works.');
    assert.match(morphoCollateralHoldWordsV1({ symbol: 'cbBTC', blockNumber: null, hold: 'market_frozen', action: 'borrow' }), /^cbBTC’s issuer has frozen the cbBTC held by Morpho Blue, so no cbBTC/);
    for (const hold of ['paused', 'market_frozen', 'wallet_frozen'] as const) {
      for (const action of ['borrow', 'take_back', 'repay'] as const) {
        const words = morphoCollateralHoldWordsV1({ ...at, hold, action });
        assert.doesNotMatch(words, /you should|cannot be liquidated|no liquidation/i, `${hold} ${action}`);
        assert.match(words, /Repaying works\.|Repay all debt without taking it back works:|This repayment works,/, `${hold} ${action}`);
      }
    }
  });
});
