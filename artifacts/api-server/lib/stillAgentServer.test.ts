import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeMirror } from '@mioagent/still-engine';

import { EXAMPLE, calendar, snapshot, universe } from '../../../lib/still-engine/test/fixtures.js';
import { answerStillAgentV3 } from './stillAgentServer.js';

// ---------------------------------------------------------------------------
// The Agent on the server swaps any Coinbase stock the Stocks list binds (2026-11-20, the operator: ANTc, which no
// fixed table named). The list is read only for a question about a trade, and the goal names the stock's contract.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const ANT = '0xb20000000000000000000016e38fd364d271ba28';

function reading() {
  const input = {
    universe: universe(), snapshot: snapshot(EXAMPLE), calendar: calendar(),
    subject: { address: WALLET as `0x${string}`, name: null, input: WALLET }, assembledAt: new Date('2026-11-20T09:00:00Z'),
  };
  return { outcome: 'report' as const, report: computeMirror(input), input, cached: false };
}

describe('the Still Agent on the server: a swap of any Coinbase stock', () => {
  it('reads the list for a trade, names the stock by its contract, and prepares only', async () => {
    let listReads = 0;
    const stocks = async () => {
      listReads += 1;
      return [{ symbol: 'ANTc', token: ANT, name: 'Anthropic, PBC' }];
    };
    const answer = await answerStillAgentV3({ question: 'Buy ANTc for 25 USDC', wallet: WALLET, read: async () => reading(), stocks });
    assert.equal(answer.mode, 'action_prep');
    assert.match(answer.text, /^Prepared: swap 25 USDC to ANTc\./);
    assert.equal(answer.actionLink?.href, `/routes?goal=${encodeURIComponent(`Swap 25 USDC to ${ANT}`)}`);
    assert.equal(listReads, 1);
    // A question that is not about a trade never reads the list.
    await answerStillAgentV3({ question: 'How safe is my loan?', wallet: WALLET, read: async () => reading(), stocks });
    assert.equal(listReads, 1);
  });

  it('keeps the fixed table when the list cannot be read', async () => {
    const answer = await answerStillAgentV3({
      question: 'Buy gold (PAXG) for $10', wallet: WALLET, read: async () => reading(), stocks: async () => { throw new Error('quotes down'); },
    });
    assert.equal(answer.actionLink?.href, `/routes?goal=${encodeURIComponent('Swap 10 USDC to PAXG')}`);
    // An unlisted symbol is asked back, never guessed into a goal.
    const unknown = await answerStillAgentV3({ question: 'Buy ZZZc for 25 USDC', wallet: WALLET, read: async () => reading(), stocks: async () => [] });
    assert.equal(unknown.actionLink?.href, '/routes');
  });
});
