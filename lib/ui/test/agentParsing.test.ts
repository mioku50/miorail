import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { agentRouteV2, agentSendRequestV2, agentSwapRequestV2, assetsNamedInV2, type AgentStockV2 } from '../src/still/agentAnswers';

// ---------------------------------------------------------------------------
// How the Agent reads a trade, against the phrases the 11-20 audit found misread (SW-1, MCP-1, SS-1 to SS-4,
// DIFF-1), with names as Coinbase's Stocks list gives them: a company's name, or a two-letter ticker, names a stock
// only beside a word for shares or a trade's word; the fixed table's words end where words end; a card is Spend's;
// dollars beside a sale, and a number in words beside "all" or "half", are asked back.
// ---------------------------------------------------------------------------

const STOCKS: AgentStockV2[] = [
  ['ANTc', '0xb20000000000000000000016e38fd364d271ba28', 'Anthropic, PBC'],
  ['MSTRc', '0xb2000000000000000000004884b426556b92883d', 'Strategy Inc.'],
  ['INTCc', '0xb2000000000000000000004aff16039ba04bdfbc', 'Intel Corporation'],
  ['NFLXc', '0xb20000000000000000000058b8c947e44011dfe6', 'Netflix Inc'],
  ['XYZc', '0xb20000000000000000000067c8c151f24e1c9924', 'Block, Inc.'],
  ['PMc', '0xb2000000000000000000008fc2a8c23cf5937b66', 'Philip Morris International Inc.'],
  ['GSc', '0xb200000000000000000000a82a0c88dd258ed141', 'The Goldman Sachs Group, Inc.'],
  ['SBUXc', '0xb200000000000000000000c3de197eac6faa1e64', 'Starbucks Corporation'],
  ['TGTc', '0xb200000000000000000000c715439d0cc5a8c67d', 'Target Corporation'],
  ['GEc', '0xb200000000000000000000f5049c6a6f3a47348d', 'General Electric Company'],
].map(([symbol, token, name]) => ({ symbol: symbol!, token: token!, name: name! }));

const swap = (question: string) => {
  const r = agentSwapRequestV2(question, STOCKS);
  return r ? `${r.from}→${r.to} ${r.amountUnclear ? 'unclear' : JSON.stringify(r.amount)}` : null;
};
const send = (question: string) => {
  const r = agentSendRequestV2(question);
  return r ? `${r.asset} ${r.amountUnclear ? 'unclear' : JSON.stringify(r.amount)}` : null;
};

describe('the Agent reads a trade by its words, not by a company name in passing', () => {
  it('takes no stock from a word that is a company only by chance (SW-1, MCP-1, SS-3)', () => {
    assert.equal(swap('Sell 3 TSLAc, what is the best strategy?'), 'TSLAc→USDC {"kind":"exact","value":"3"}');
    assert.equal(swap('Sell 1 NVDAc, my target is cash'), 'NVDAc→USDC {"kind":"exact","value":"1"}');
    assert.equal(swap('Sell all my AMZNc before the next block'), 'AMZNc→USDC {"kind":"share","share":"all"}');
    assert.equal(swap('My strategy: swap 100 USDC to PAXG'), 'USDC→PAXG {"kind":"exact","value":"100"}');
    assert.equal(swap('Target: swap 50 USDC to ETH'), 'USDC→ETH {"kind":"exact","value":"50"}');
    assert.equal(swap('Intel first: swap 20 USDC to ETH'), 'USDC→ETH {"kind":"exact","value":"20"}');
    assert.equal(swap('My target is to buy NVDAc with 10 USDC'), 'USDC→NVDAc {"kind":"exact","value":"10"}');
    assert.equal(swap('I want to buy NVDAc, what is a good strategy?'), 'USDC→NVDAc null');
    assert.equal(swap('swap all USDC to the best target'), 'USDC→null {"kind":"share","share":"all"}');
    assert.equal(swap('Should I buy a block of Apple?'), 'USDC→AAPLc null');
    assert.match(swap('At 5 PM swap 10 USDC to ETH')!, /^USDC→ETH/);
    assert.match(swap('Block 1: swap 10 USDC to ETH')!, /^USDC→ETH/);
  });

  it('still names a stock by its symbol, its ticker, or its name beside a word for shares or a trade', () => {
    assert.equal(swap('Buy ANTc for 25 USDC'), 'USDC→ANTc {"kind":"exact","value":"25"}');
    assert.equal(swap('Buy ANT for 25 USDC'), 'USDC→ANTc {"kind":"exact","value":"25"}');
    assert.equal(swap('buy Anthropic stock for 25 USDC'), 'USDC→ANTc {"kind":"exact","value":"25"}');
    assert.equal(swap('buy Anthropic for 25 USDC'), 'USDC→ANTc {"kind":"exact","value":"25"}');
    assert.equal(swap('купи акции Anthropic на 25 USDC'), 'USDC→ANTc {"kind":"exact","value":"25"}');
    assert.equal(swap('swap 10 USDC to Target'), 'USDC→TGTc {"kind":"exact","value":"10"}');
    assert.equal(swap('buy shares of Target for 10 USDC'), 'USDC→TGTc {"kind":"exact","value":"10"}');
    assert.equal(swap('buy GE for 10 USDC'), 'USDC→GEc {"kind":"exact","value":"10"}');
    assert.equal(swap('Buy gold (PAXG) for $10'), 'USDC→PAXG {"kind":"exact","value":"10"}');
    assert.equal(swap('хочу продать все свои USDC на ETH'), 'USDC→ETH {"kind":"share","share":"all"}');
    // More than two assets is not one swap: neither side is guessed.
    assert.equal(swap('swap NVDAc and TSLAc to USDC'), 'null→null null');
  });

  it('sends a card, a top-up or a subscription to Spend, never into the brand’s stock (DIFF-1)', () => {
    for (const question of ['Купи подарочную карту Netflix за 20 USDC', 'Buy a Starbucks card for 10 USDC', 'buy Netflix gift card for 25 USDC',
      'buy an eSIM for 5 USDC', 'пополни телефон на 10 USDC']) {
      assert.equal(swap(question), null, question);
      assert.equal(agentRouteV2(question, STOCKS).route, 'action_prep', question);
    }
  });

  it('ends the fixed table’s words where words end (SS-4)', () => {
    assert.deepEqual(assetsNamedInV2('sell all my Goldman Sachs'), []);
    assert.deepEqual(assetsNamedInV2('swap all my WBTC to USDC'), []);
    assert.deepEqual(assetsNamedInV2('sell NVDA.d'), []);
    assert.deepEqual(assetsNamedInV2('send 1 TSLAx'), []);
    assert.deepEqual(assetsNamedInV2('метаданные'), []);
    assert.deepEqual(assetsNamedInV2('купи золото и продай теслу, эфира и биткоина хватит'), ['TSLAc', 'cbBTC', 'ETH', 'PAXG']);
    assert.deepEqual(assetsNamedInV2('what if NVDA drops 30%? Apple. nvidia’s chips'), ['NVDAc', 'AAPLc']);
    assert.equal(swap('купи Goldman Sachs на 10 USDC'), 'USDC→null {"kind":"exact","value":"10"}');
    assert.equal(send('send 0.02 Goldman Sachs to alice.base.eth'), 'null {"kind":"exact","value":"0.02"}');
    assert.equal(send('send 1 TSLAx to alice.base.eth'), 'null {"kind":"exact","value":"1"}');
  });

  it('asks back dollars beside a sale, never reading them as shares (SS-1)', () => {
    for (const question of ['sell my meta for $50', 'sell NVDAc for $5', 'продай Apple на 100 долларов', 'sell ANTc for 20 USDC', 'sell $50 worth of NVDAc']) {
      assert.match(swap(question)!, / unclear$/, question);
    }
    assert.equal(swap('sell 2 NVDAc'), 'NVDAc→USDC {"kind":"exact","value":"2"}');
    assert.equal(swap('swap 10 USDC to ETH'), 'USDC→ETH {"kind":"exact","value":"10"}');
    for (const question of ['send 5 dollars of NVDAc to alice.base.eth', 'send 5 usd of NVDAc to alice.base.eth', 'send 5 bucks of NVDAc to alice.base.eth']) {
      assert.equal(send(question), 'NVDAc {"kind":"dollars"}', question);
    }
    assert.equal(send('send 5 usd coin to alice.base.eth'), 'USDC {"kind":"exact","value":"5"}');
    assert.equal(send('send 5 USDC to alice.base.eth'), 'USDC {"kind":"exact","value":"5"}');
  });

  it('asks back a number in words beside "all" or "half" (SS-2)', () => {
    for (const question of ['send one and a half USDC to alice.base.eth', 'send half of ten USDC to alice.base.eth', 'send max five USDC to alice.base.eth',
      'переведи все пять NVDAc на alice.base.eth']) {
      assert.equal(send(question), question.includes('NVDAc') ? 'NVDAc unclear' : 'USDC unclear', question);
    }
    assert.equal(swap('swap all five NVDAc to USDC'), 'NVDAc→USDC unclear');
    assert.equal(send('send all my NVDAc to alice.base.eth'), 'NVDAc {"kind":"share","share":"all"}');
    assert.equal(swap('продай половину NVDAc'), 'NVDAc→USDC {"kind":"share","share":"half"}');
  });
});
