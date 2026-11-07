import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeMirror } from '@mioagent/still-engine';
import type { MirrorReport } from '@mioagent/still-engine/report';
import { calendar, snapshot, universe, type Holdings } from '../../still-engine/test/fixtures';
import { assetsNamedInV2 } from '../src/still/agentAnswers';
import { assetsViewV1 } from '../src/still/assetsView';

// Gold (PAXG) joined Still's Morpho markets on 2026-11-07. Before it, the
// screens named only two coins, and a third one fell through: Assets listed
// ETH and cbBTC by name and dropped any other coin, and a Morpho loan that was
// not WETH's linked to cbBTC's repayment.

const ONE = 10n ** 18n;
const report = (holdings: Holdings): MirrorReport =>
  JSON.parse(JSON.stringify(computeMirror({ universe: universe(), snapshot: snapshot(holdings), calendar: calendar(),
    subject: { address: '0x00000000000000000000000000000000000b0b0b', name: null, input: 'example' }, assembledAt: new Date('2026-10-21T15:00:01Z') })));

describe('gold on Assets', () => {
  // 0.1 PAXG in the wallet, 1 pledged on Morpho, about $1,001.68 owed against it.
  const holdings: Holdings = { wallet: { PAXG: ONE / 10n }, morpho: { PAXG: { collateral: ONE, borrowShares: 10n ** 15n } } };

  it('lists the gold a wallet holds and has pledged, at its market’s gold price', () => {
    const gold = assetsViewV1({ report: report(holdings) }).rows.find((row) => row.id === 'PAXG');
    assert.ok(gold, 'a PAXG row');
    assert.equal(gold.kind, 'crypto');
    assert.equal(gold.name, 'Gold');
    assert.match(gold.amount, /^1\.1 PAXG$/);
    // 1.1 × $4,063.55
    assert.equal(gold.value, '$4,469.90');
    assert.match(gold.lines[0]!.strong!, /^1 hold up your Morpho loan$/);
  });

  it('a loan against gold is repaid on its own page, not bitcoin’s', () => {
    const loan = assetsViewV1({ report: report(holdings) }).loans.find((row) => row.label === 'Morpho · PAXG/USDC');
    assert.ok(loan, 'a PAXG loan');
    assert.equal(loan.repayHref, '/repay?asset=PAXG');
    assert.equal(loan.owed, '$1,001.68');
  });

  it('a wallet without gold shows no gold row', () => {
    assert.equal(assetsViewV1({ report: report({ wallet: { cbBTC: 1_000_000n } }) }).rows.some((row) => row.id === 'PAXG'), false);
  });
});

describe('the Still Agent hears gold', () => {
  it('in English and in Russian, by its name or its ticker', () => {
    for (const question of ['How much can I borrow against my gold?', 'what if PAXG falls 10%', 'Сколько дадут под золото?', 'если золото упадёт на 5%']) {
      assert.deepEqual(assetsNamedInV2(question), ['PAXG'], question);
    }
  });

  it('and only gold: bitcoin and ether keep their own words', () => {
    assert.deepEqual(assetsNamedInV2('gold and bitcoin'), ['cbBTC', 'PAXG']);
    assert.deepEqual(assetsNamedInV2('my ether'), ['ETH']);
  });
});
