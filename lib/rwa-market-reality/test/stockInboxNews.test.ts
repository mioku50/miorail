import assert from 'node:assert/strict';
import test from 'node:test';
import { stockBriefV1 } from '../src/stockBrief.js';
import { briefInput, FEED, TOKEN, OTHER } from './fixtures/stockBrief.js';

const tx = `0x${'a'.repeat(64)}`;
function card(
  id: string,
  kind:
    | 'official_asset_multiplier_changed'
    | 'official_asset_corporate_action_announced'
    | 'official_asset_multiplier_change_scheduled' = 'official_asset_multiplier_changed',
) {
  return {
    signalId: id,
    kind,
    chainId: 8453 as const,
    subjectAddress: TOKEN,
    officialAddress: null,
    subjectTicker: 'NVDAc',
    officialTicker: null,
    occurredAt: '2026-09-30T16:47:47.000Z',
    recordedAt: '2026-09-30T16:59:27.058Z',
    facts: {
      transactionHash: tx,
      multiplierWad: '1000537939576369481',
      event: 'ui_multiplier_updated',
    } as Record<string, unknown>,
  };
}
test('production-shaped compatibility setters and announcement are one news update with every source retained', () => {
  const cards = [
    card('766'),
    { ...card('765'), facts: { ...card('765').facts, event: 'multiplier_updated' } },
    {
      ...card('764', 'official_asset_corporate_action_announced'),
      facts: {
        transactionHash: tx,
        event: 'announcement',
        payloadState: 'topic_only',
        description: null,
      },
    },
  ];
  const result = stockBriefV1({ ...briefInput(), changes: { ...FEED, cards } });
  assert.equal(result.inbox.items.length, 1);
  assert.equal(result.inbox.heldCount, 1);
  assert.equal(result.changes!.cards.length, 3);
  assert.deepEqual(result.inbox.items[0]!.evidenceSignalIds, ['766', '765', '764']);
  assert.equal(result.inbox.items[0]!.headline, 'Shares per token changed');
  assert.match(result.inbox.items[0]!.summary!, /one NVDAc to about 1\.00053794/);
  assert.doesNotMatch(result.inbox.items[0]!.summary!, /dividend|paid|received/);
});
test('equal values from different transactions and exact contracts remain separate news', () => {
  const cards = [
    card('1'),
    { ...card('2'), facts: { ...card('2').facts, transactionHash: `0x${'b'.repeat(64)}` } },
    { ...card('3'), subjectAddress: OTHER },
  ];
  const result = stockBriefV1({
    ...briefInput(),
    watchedAddresses: [OTHER],
    changes: { ...FEED, cards },
  });
  assert.equal(result.inbox.items.length, 3);
  assert.equal(result.inbox.heldCount, 2);
  assert.equal(result.inbox.watchedCount, 1);
  assert.match(result.inbox.items[2]!.summary!, /meaning depends on the issuer/);
});
test('different multiplier values, schedules and the issuer words in one transaction all survive the summary', () => {
  const cards = [
    card('1'),
    { ...card('2'), facts: { ...card('2').facts, multiplierWad: '2000000000000000000' } },
    {
      ...card('3', 'official_asset_multiplier_change_scheduled'),
      facts: { ...card('3').facts, effectiveAt: '2026-10-02T10:00:00.000Z' },
    },
    {
      ...card('4', 'official_asset_corporate_action_announced'),
      facts: { transactionHash: tx, description: 'Issuer-provided description' },
    },
  ];
  const result = stockBriefV1({ ...briefInput(), changes: { ...FEED, cards } });
  assert.equal(result.inbox.items.length, 1);
  assert.equal(result.inbox.items[0]!.headline, 'Issuer updated token terms');
  assert.match(result.inbox.items[0]!.summary!, /1\.00053794/);
  assert.match(result.inbox.items[0]!.summary!, /one NVDAc to 2/);
  assert.match(result.inbox.items[0]!.summary!, /plan, not an applied change/);
  assert.match(result.inbox.items[0]!.summary!, /Issuer-provided description/);
});
test('missing or malformed transaction identity never groups equal-looking records', () => {
  const cards = ['1', '2'].map((id) => ({
    ...card(id),
    facts: { multiplierWad: '1000537939576369481', transactionHash: 'unknown' },
  }));
  assert.equal(
    stockBriefV1({ ...briefInput(), changes: { ...FEED, cards } }).inbox.items.length,
    2,
  );
});

test('a multiplier move that carried a received dividend is told as that dividend', () => {
  // Production 2026-10-01: NVIDIA's dividend converted, and the inbox said
  // only "Shares per token changed".
  const input = briefInput();
  input.dividends.holdings[0]!.received = [
    {
      state: 'effective',
      reason: null,
      amountPerShare: '0.25',
      payDate: '2026-09-30',
      payDateApproximate: false,
      kind: 'measured',
      tokens: '0.00088158',
      shares: '0.00000047',
      usd: '0.0001',
      at: '2026-09-30T16:47:47.000Z',
    },
  ];
  const cards = [card('766'), { ...card('765'), facts: { ...card('765').facts, event: 'multiplier_updated' } }];
  const [item] = stockBriefV1({ ...input, changes: { ...FEED, cards } }).inbox.items;
  assert.equal(item!.headline, "NVIDIA's dividend arrived");
  assert.equal(
    item!.summary,
    'NVIDIA paid $0.25 a share on Sep 30. Coinbase reinvested it as more shares: one NVDAc now represents about 1.00053794 NVDA shares. On the 0.00088158 NVDAc you held, that is less than $0.01.',
  );
  assert.deepEqual(item!.evidenceSignalIds, ['766', '765']);
  // A move at another moment is not that dividend.
  const later = { ...card('767'), occurredAt: '2026-09-29T10:00:00.000Z', facts: { ...card('767').facts, transactionHash: `0x${'b'.repeat(64)}` } };
  const [other] = stockBriefV1({ ...input, changes: { ...FEED, cards: [later] } }).inbox.items;
  assert.equal(other!.headline, 'Shares per token changed');
});

test('every market, listing and lookalike item has words an assistant can repeat', () => {
  const market = (id: string, kind: string, facts: Record<string, unknown>) => ({
    ...card(id),
    kind: kind as 'official_asset_multiplier_changed',
    facts: { ticker: '0xb20000…108c', destination: 'USDC', ...facts },
  });
  const cards = [
    market('1', 'official_asset_market_became_active', { requestedCashAtomic: '10000000000', roundTripCostBps: '8' }),
    market('2', 'official_asset_market_became_unreachable', { requestedCashAtomic: '100000000' }),
    market('3', 'official_asset_cash_exit_changed', {
      requestedCashAtomic: '100000000',
      previousRoundTripCostBps: '8',
      roundTripCostBps: '35',
    }),
    market('4', 'official_asset_dividend_declared', { company: 'NVIDIA', amountPerShare: '0.25', payDate: '2026-12-31' }),
    market('5', 'official_source_added_asset', { sourceKind: 'coinbase_stocks_api' }),
  ];
  const items = stockBriefV1({ ...briefInput(), changes: { ...FEED, cards } }).inbox.items;
  const words = new Map(items.map((item) => [item.signalId, [item.headline, item.summary]]));
  assert.deepEqual(words.get('1'), [
    'Can be sold for USDC again',
    'Miorail found a route to sell NVDAc for USDC again; the measurement before found none. The largest size that went through was $10,000, for a round trip of 0.08%.',
  ]);
  assert.deepEqual(words.get('2'), [
    'No route to sell found',
    "Miorail's latest measurement found no route to sell NVDAc for USDC, even at $100; the one before found a route. The measurement itself worked.",
  ]);
  assert.deepEqual(words.get('3'), [
    'Cost to sell changed',
    'A $100 round trip in NVDAc now costs 0.35%, against 0.08% at the measurement before.',
  ]);
  assert.deepEqual(words.get('4'), [
    'NVIDIA declared a dividend',
    'NVIDIA declared $0.25 a share, payable Dec 31. NVDAc takes it as more shares per token when it converts.',
  ]);
  assert.deepEqual(words.get('5'), ['Listed by the Coinbase Stocks API', 'NVDAc is now listed by the Coinbase Stocks API.']);
  // The shortened address in a market signal's facts never stands in for the name.
  assert.equal(items.some((item) => /0xb20000…108c/.test(item.summary ?? '')), false);
});
