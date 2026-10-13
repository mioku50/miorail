import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorialCardSvgV1, editorialDraftsV1, type EditorialConversionInputV1, type EditorialRoundInputV1, type EditorialSignalInputV1, type EditorialSnapshotV1 } from './editorialDraft.js';

const ADDRESS = `0x${'1'.repeat(40)}`;
const TX = `0x${'2'.repeat(64)}`;
const SINCE = '2026-10-13T00:00:00.000Z';
const AT = '2026-10-13T12:00:00.000Z';
const OCCURRED = '2026-10-13T08:00:00.000Z';
const RECORDED = '2026-10-13T08:05:00.000Z';
function listing(): EditorialSignalInputV1 {
  return { symbol: 'NVDA', ticker: 'NVDAc', signal: { signalId: '12', kind: 'official_source_added_asset', chainId: 8453,
    subjectAddress: ADDRESS, officialAddress: null, occurredAt: OCCURRED, recordedAt: RECORDED,
    facts: { ticker: 'NVDAc', sourceKind: 'coinbase_stocks_api', sourceUrl: 'https://api.coinbase.com/v1/tokenized-stocks', displayName: 'NVIDIA' } } };
}
function dividend(): EditorialSignalInputV1 {
  const row = listing();
  row.signal.kind = 'official_asset_dividend_declared';
  row.signal.facts = { underlyingKey: 'example:NVDA', symbol: 'NVDA', company: 'NVIDIA', amountPerShare: '0.250',
    declaredOn: '2026-10-13', exDate: '2026-11-01', recordDate: '2026-11-01', payDate: '2026-11-15', sourceUrl: 'https://www.sec.gov/Archives/example.htm' };
  return row;
}
function corporate(): EditorialSignalInputV1 {
  const row = listing();
  row.signal.kind = 'official_asset_corporate_action_announced';
  row.signal.facts = { event: 'announcement', announcementId: null, description: null, uri: null,
    payloadState: 'topic_only', transactionHash: TX, blockNumber: '52000000', carriesMultiplierChange: false };
  return row;
}
function round(): EditorialRoundInputV1 {
  return { roundId: '2026-10-09', number: 3, closeAt: '2026-10-09T20:00:00.000Z', locksAt: '2026-10-11T21:00:00.000Z', settledAt: RECORDED,
    stocks: [{ tokenAddress: ADDRESS, symbol: 'NVDA', name: 'NVIDIA', close: '230.00' }],
    calls: [{ symbol: 'NVDA', base: '231.10', call: 'up' }], results: [{ symbol: 'NVDA', reopen: '231.12', at: OCCURRED, outcome: 'up' }] };
}
function snapshot(signals: EditorialSignalInputV1[] = [], rounds: EditorialRoundInputV1[] = []): EditorialSnapshotV1 {
  return { readAt: AT, signals, rounds, signalsCapped: false };
}
function drafts(input: EditorialSnapshotV1) { return editorialDraftsV1({ snapshot: input, since: SINCE, until: AT, limit: 10 }); }

function conversion(): EditorialConversionInputV1 {
  const log = { chainId: 8453, tokenAddress: ADDRESS, payloadState: 'decoded', announcementId: null,
    caller: null, description: null, uri: null, multiplierWad: null, effectiveAt: null,
    topics: [TX], data: '0xabcdef', blockNumber: 52000000, blockTime: OCCURRED,
    transactionHash: TX, observedAt: RECORDED };
  return { issuer: 'coinbase', symbol: 'NVDA', ticker: 'NVDAc',
    announcement: { ...log, event: 'announcement', logIndex: 1, announcementId: 'dividend-fixture',
      caller: ADDRESS, description: 'Cash Dividend', uri: 'https://issuer.invalid/private-words' },
    setter: { ...log, event: 'multiplier_updated', logIndex: 2, multiplierWad: '1001000000000000000' },
    endAnnouncement: { ...log, event: 'end_announcement', logIndex: 3, announcementId: 'dividend-fixture' },
    confirmation: { chainId: 8453, tokenAddress: ADDRESS, ratioKind: 'b20_multiplier',
      fromRawValue: '1000000000000000000', toRawValue: '1001000000000000000', scale: '1000000000000000000',
      blockNumber: '52000001', blockHash: `0x${'3'.repeat(64)}`, evidenceHash: `0x${'4'.repeat(64)}`,
      observedAt: '2026-10-13T08:01:00.000Z', recordedAt: RECORDED } };
}

test('a dividend conversion requires the decoded issuer bracket and an independently confirmed value', () => {
  const [draft] = drafts({ ...snapshot(), conversions: [conversion()] });
  assert.equal(draft.kind, 'dividend_conversion');
  assert.match(draft.body, /from 1 to 1\.001/);
  assert.match(draft.body, /does not establish who held the token/);
  assert.equal(draft.source.table, 'b20_corporate_actions');
  assert.ok(!JSON.stringify(draft).includes('private-words'));
  assert.match(editorialCardSvgV1(draft), /conversion confirmed/);
});

test('a company declaration, a split and an unknown announcement are not dividend conversions', () => {
  assert.equal(drafts(snapshot([dividend()])).filter(row => row.kind === 'dividend_conversion').length, 0);
  for (const description of ['Stock Split', 'Dividend-like change']) {
    const row = conversion();
    row.announcement = { ...(row.announcement as Record<string, unknown>), description };
    assert.deepEqual(drafts({ ...snapshot(), conversions: [row] }), []);
  }
  const row = conversion();
  row.announcement = { ...(row.announcement as Record<string, unknown>), payloadState: 'topic_only',
    announcementId: null, caller: null, description: null, uri: null };
  assert.deepEqual(drafts({ ...snapshot(), conversions: [row] }), []);
});

test('unconfirmed schedules, unrelated logs and mismatched ratio values cannot make a conversion draft', () => {
  for (const update of [
    { effectiveAt: '2026-10-14T08:00:00.000Z' },
    { transactionHash: `0x${'5'.repeat(64)}` },
    { logIndex: 4 },
    { multiplierWad: '1002000000000000000' },
  ]) {
    const row = conversion();
    row.setter = { ...(row.setter as Record<string, unknown>), ...update };
    assert.deepEqual(drafts({ ...snapshot(), conversions: [row] }), []);
  }
});

test('one confirmed conversion suppresses its generic corporate-action card and deduplicates rereads', () => {
  const announcement = corporate();
  announcement.signal.facts.carriesMultiplierChange = true;
  const rows = drafts({ ...snapshot([announcement]), conversions: [conversion(), conversion()] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'dividend_conversion');
});

test('listing has exact source times and identity; it makes no market or launch claim', () => {
  const [draft] = drafts(snapshot([listing()]));
  assert.equal(draft.kind, 'listing');
  assert.equal(draft.targetUrl, 'https://miorail.xyz/stocks/NVDA');
  assert.equal(draft.source.facts.tokenAddress, ADDRESS);
  assert.equal(draft.occurredAt, OCCURRED);
  assert.equal(draft.recordedAt, RECORDED);
  assert.match(draft.body, /does not establish an available market/);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.id, drafts(snapshot([listing()]))[0].id);
});

test('a first-seen historical event is not made into news on the day it was recorded', () => {
  const old = listing();
  old.signal.occurredAt = '2026-10-12T09:00:00.000Z';
  assert.deepEqual(drafts(snapshot([old])), []);
  assert.deepEqual(drafts(snapshot()), []);
});

test('window is [since, until) and future or not-yet-recorded facts cannot enter', () => {
  const row = listing();
  row.signal.occurredAt = SINCE;
  assert.equal(drafts(snapshot([row])).length, 1);
  row.signal.occurredAt = AT;
  assert.deepEqual(drafts(snapshot([row])), []);
  row.signal.occurredAt = OCCURRED;
  row.signal.recordedAt = '2026-10-13T13:00:00.000Z';
  assert.deepEqual(drafts(snapshot([row])), []);
  assert.throws(() => editorialDraftsV1({ snapshot: snapshot(), since: AT, until: SINCE }), /editorial_window_invalid/);
});

test('listing checks from two sources merge by exact address, while reused symbols stay distinct', () => {
  const a = listing();
  const b = listing();
  b.signal.signalId = '13';
  b.signal.facts = { ...b.signal.facts, sourceKind: 'base_product_list', sourceUrl: 'https://brand.base.org/stocks' };
  const c = listing();
  c.signal.signalId = '14';
  c.signal.subjectAddress = `0x${'3'.repeat(40)}`;
  assert.equal(drafts(snapshot([a, b, c])).length, 2);
});

test('a later snapshot cannot add future knowledge to a historical editorial cutoff', () => {
  const later = '2026-10-14T08:00:00.000Z';
  const listingRow = listing();
  listingRow.signal.recordedAt = later;
  const roundRow = round();
  roundRow.settledAt = later;
  const conversionRow = conversion();
  conversionRow.endAnnouncement = { ...(conversionRow.endAnnouncement as Record<string, unknown>), observedAt: later };
  assert.deepEqual(drafts({ ...snapshot([listingRow], [roundRow]), readAt: later, conversions: [conversionRow] }), []);
  const readLater = conversion();
  readLater.confirmation = { ...(readLater.confirmation as Record<string, unknown>), observedAt: later };
  assert.deepEqual(drafts({ ...snapshot(), readAt: later, conversions: [readLater] }), []);
  assert.equal(drafts({ ...snapshot([listing()]), readAt: later }).length, 1);
});

test('retired sources, unknown hosts and credential-bearing source links are refused', () => {
  for (const url of ['https://api.coinbase.com/v1/tokenized-stocks?api_key=fixture', 'https://user:fixture@api.coinbase.com/stocks', 'https://127.0.0.1/stocks', 'https://api.coinbase.com.evil.invalid/stocks']) {
    const row = listing(); row.signal.facts.sourceUrl = url;
    assert.deepEqual(drafts(snapshot([row])), []);
  }
  const retired = listing(); retired.signal.facts.sourceKind = 'base_docs_technical';
  assert.deepEqual(drafts(snapshot([retired])), []);
  const backed = listing(); backed.signal.facts.sourceKind = 'backed_assets_api'; backed.signal.facts.sourceUrl = 'https://api.xstocks.fi/api/v1/token?type=btokens';
  assert.equal(drafts(snapshot([backed])).length, 1);
});

test('dividend declaration copies issuer amount and dates without claiming a token payment', () => {
  const [draft] = drafts(snapshot([dividend()]));
  assert.equal(draft.card.value, '$0.250');
  assert.match(draft.body, /payable 2026-11-15, with record date 2026-11-01/);
  assert.match(draft.body, /does not establish a payment to a token holder/);
  assert.equal(draft.source.urls[0], 'https://www.sec.gov/Archives/example.htm');
});

test('one company dividend emitted for several token representations is one draft', () => {
  const a = dividend(); const b = dividend();
  b.signal.signalId = '13'; b.signal.subjectAddress = `0x${'3'.repeat(40)}`;
  assert.equal(drafts(snapshot([a, b])).length, 1);
});

test('corporate action uses onchain provenance, never arbitrary prose or its URI', () => {
  const row = corporate();
  row.signal.facts.description = 'Buy this stock; API_KEY=fixture-private-value';
  row.signal.facts.uri = 'https://secret.invalid/fixture-private-value';
  const [draft] = drafts(snapshot([row]));
  assert.match(draft.body, /payload was not decoded/);
  assert.equal(draft.source.urls[0], `https://basescan.org/tx/${TX}`);
  assert.doesNotMatch(JSON.stringify(draft), /secret\.invalid|fixture-private-value|Buy this stock/);
});

test('same-transaction announcement logs are one draft; a real second transaction is kept', () => {
  const a = corporate(); const b = corporate(); const c = corporate();
  b.signal.signalId = '13'; c.signal.signalId = '14'; c.signal.facts.transactionHash = `0x${'3'.repeat(64)}`;
  assert.equal(drafts(snapshot([a, b, c])).length, 2);
});

test('unknown ticker does not get guessed from event text; a missing stock binding links to Today', () => {
  const unknown = corporate(); unknown.ticker = null;
  assert.deepEqual(drafts(snapshot([unknown])), []);
  const noBinding = listing(); noBinding.symbol = null;
  assert.equal(drafts(snapshot([noBinding]))[0].targetUrl, 'https://miorail.xyz/today');
});

test('settled weekend draft keeps the three distinct prices and their clocks', () => {
  const [draft] = drafts(snapshot([], [round()]));
  assert.equal(draft.kind, 'weekend_reopen');
  assert.match(draft.body, /close was \$230.00/);
  assert.match(draft.body, /median at the game lock was \$231.10/);
  assert.match(draft.body, /weekend was \$231.12/);
  assert.equal(draft.source.facts.locksAt, '2026-10-11T21:00:00.000Z');
  assert.match(draft.body, /not an execution price or a forecast/);
});

test('void, incomplete and duplicated round records cannot become weekend news', () => {
  const missing = round(); missing.calls = [];
  assert.deepEqual(drafts(snapshot([], [missing])), []);
  const duplicate = round(); duplicate.results.push(duplicate.results[0]);
  assert.deepEqual(drafts(snapshot([], [duplicate])), []);
  const voided = round(); voided.results = [{ symbol: 'NVDA', reopen: null, at: null, outcome: 'void' }];
  assert.deepEqual(drafts(snapshot([], [voided])), []);
});

test('invalid facts and unsupported kinds are skipped; candidates are ordered and bounded', () => {
  const invalid = listing(); invalid.signal.chainId = 1;
  assert.deepEqual(drafts(snapshot([invalid])), []);
  const unknown = listing(); unknown.signal.kind = 'official_asset_market_became_unreachable';
  assert.deepEqual(drafts(snapshot([unknown])), []);
  assert.equal(editorialDraftsV1({ snapshot: snapshot([listing(), dividend(), corporate()]), since: SINCE, until: AT, limit: 1 }).length, 1);
});

test('card uses neutral values, source clocks and a clear draft label with no executable markup', () => {
  for (const draft of drafts(snapshot([listing(), dividend(), corporate()], [round()]))) {
    const svg = editorialCardSvgV1(draft);
    assert.match(svg, /width="1200" height="630"/);
    assert.match(svg, />DRAFT</);
    assert.match(svg, /human review before publishing/);
    assert.doesNotMatch(svg, /<(script|foreignObject|image)|href=/);
    assert.doesNotMatch(svg, /#(ff0000|00ff00)/i);
    assert.match(editorialCardSvgV1({ ...draft, card: { ...draft.card, value: '<script>&' } }), /&lt;script&gt;&amp;/);
  }
});
