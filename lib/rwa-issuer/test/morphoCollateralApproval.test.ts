import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { narrowMorphoCollateralApprovalV1 } from '../src/morphoBorrowPlan.js';

// 2026-11-07: Morpho's Actions API began approving its bundles contract for 2^256 − 1 of the
// collateral (cbBTC and PAXG alike), and Still refused every borrow that pledged a token.
const TOKEN = '0xe904aea5e1b110c9174728fa2effc8aed19e98ef';
const BUNDLES = '0x4d28d900e381ece4b351302f1abe588496793a2b';
const OTHER = '0xb98c948cfa24072e58935bc004a8a7b376ae746a';
const MAX = (1n << 256n) - 1n;
const approve = (spender: string, amount: bigint) => `0x095ea7b3${spender.slice(2).padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;
const SUPPLY = 543_068_208_472_116n;
const tx = (to: string, data: string) => ({ to, data, value: '0', description: 'approval' });
const final = { to: BUNDLES, data: '0xb1268765', value: '0', description: 'blue_supply_collateral_borrow' };

describe('a Still borrow never leaves Morpho a standing allowance', () => {
  it('narrows the collateral approval to Morpho’s bundles contract to the pledge, and changes nothing else', () => {
    const out = narrowMorphoCollateralApprovalV1([tx(TOKEN, approve(BUNDLES, MAX)), final], { collateralToken: TOKEN, supplyAssets: SUPPLY });
    assert.equal(out.narrowed, 1);
    assert.deepEqual(out.transactions, [tx(TOKEN, approve(BUNDLES, SUPPLY)), final]);
  });

  it('leaves every other approval as it came, for the checks after it to refuse', () => {
    for (const [label, calls] of [
      ['another spender', [tx(TOKEN, approve(OTHER, MAX))]],
      ['another token', [tx(OTHER, approve(BUNDLES, MAX))]],
      ['not over the pledge', [tx(TOKEN, approve(BUNDLES, SUPPLY))]],
      ['trailing bytes', [tx(TOKEN, `${approve(BUNDLES, MAX)}00`)]],
      ['not an approval', [tx(TOKEN, `0xa9059cbb${'0'.repeat(128)}`)]],
    ] as const) {
      const out = narrowMorphoCollateralApprovalV1(calls, { collateralToken: TOKEN, supplyAssets: SUPPLY });
      assert.equal(out.narrowed, 0, label);
      assert.deepEqual(out.transactions, calls, label);
    }
  });

  it('narrows nothing for a borrow that pledges nothing', () => {
    const calls = [tx(TOKEN, approve(BUNDLES, MAX))];
    assert.deepEqual(narrowMorphoCollateralApprovalV1(calls, { collateralToken: TOKEN, supplyAssets: 0n }), { transactions: calls, narrowed: 0 });
  });
});
