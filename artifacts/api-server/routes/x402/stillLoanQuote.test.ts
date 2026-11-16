import assert from 'node:assert/strict';
import test from 'node:test';

import { X402StillLoanQuoteV1Schema, hashX402IntelligenceDataV1, stableHashV1, x402IntelligencePaymentV1 } from '@mioagent/route-domain';
import type { MirrorInput } from '@mioagent/still-engine';
import { calendar, snapshot, universe } from '../../../../lib/still-engine/test/fixtures.js';
import { parseStillQuoteQuestionV1, stillLoanQuoteDraftV1, stillLoanQuoteFromReadingV1 } from './stillLoanQuote.js';

const reading = (): MirrorInput => ({
  universe: universe(),
  snapshot: snapshot({}),
  calendar: calendar(),
  subject: { address: '0x00000000000000000000000000000000000b0b0b', name: null, input: 'x' },
  assembledAt: new Date('2026-10-21T15:00:01Z'),
});

function delivered(query: Record<string, string>) {
  const parsed = parseStillQuoteQuestionV1(query);
  if (!parsed.ok) assert.fail(parsed.message);
  const draft = stillLoanQuoteDraftV1({
    quote: stillLoanQuoteFromReadingV1(reading(), parsed.question),
    question: parsed.question,
    now: new Date('2026-10-21T15:00:02.000Z'),
    payment: x402IntelligencePaymentV1(),
    requestHash: stableHashV1('x402-intelligence-request/v1', query),
  });
  return X402StillLoanQuoteV1Schema.parse({ ...draft, dataHash: hashX402IntelligenceDataV1(draft) });
}

test('an asset is named by Still’s id, its exact token address, or WETH for ether', () => {
  for (const asset of ['cbBTC', 'CBBTC', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf']) {
    const parsed = parseStillQuoteQuestionV1({ asset, amount: '0.01' });
    assert.ok(parsed.ok && parsed.question.ask.asset === 'cbBTC' && parsed.question.ask.raw === 1_000_000n, asset);
  }
  const weth = parseStillQuoteQuestionV1({ asset: 'WETH', amount: '1.5' });
  assert.ok(weth.ok && weth.question.ask.asset === 'ETH' && weth.question.ask.raw === 1_500_000_000_000_000_000n);
  const paxg = parseStillQuoteQuestionV1({ asset: 'PAXG', amount: '2', borrowUsdc: '1000.5' });
  assert.ok(paxg.ok && paxg.question.ask.borrowAtomic === 1_000_500_000n && paxg.question.borrowUsdc === '1000.5');
  // An empty optional is no question, not a refusal.
  const blank = parseStillQuoteQuestionV1({ asset: 'NVDAc', amount: '1', borrowUsdc: '  ' });
  assert.ok(blank.ok && blank.question.ask.borrowAtomic === null);
});

test('each collateral says what a transfer pause would do to its own loan', () => {
  assert.match(delivered({ asset: 'NVDAc', amount: '10' }).caveats.join(' '), /Aave V4 still works.*liquidation can still proceed/);
  assert.match(delivered({ asset: 'cbBTC', amount: '0.01' }).caveats.join(' '), /If cbBTC pauses.*both taking it back and a liquidation wait/);
  assert.match(delivered({ asset: 'ETH', amount: '1' }).caveats.join(' '), /WETH cannot pause/);
});

test('a crypto quote names its Morpho market and the contracts it was read from, in lower case', () => {
  const quote = delivered({ asset: 'cbBTC', amount: '0.01' });
  assert.equal(quote.venue.venue, 'morpho');
  assert.equal(quote.venue.market, '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836');
  assert.equal(quote.collateral.isin, null);
  assert.equal(quote.contracts[0]?.label, 'cbBTC token');
  assert.ok(quote.contracts.every((entry) => entry.address === entry.address.toLowerCase()));
  assert.equal(quote.limit.stillLimitCents, '34529');
});
