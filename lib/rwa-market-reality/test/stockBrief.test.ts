import assert from 'node:assert/strict';
import test from 'node:test';
import { stockBriefV1, stockBriefWindowV1 } from '../src/stockBrief.js';
import { briefInput, NOW, TOKEN, OTHER, FEED } from './fixtures/stockBrief.js';

test('a tiny holding is valued at a dated total-return reference, without applying its multiplier twice', () => {
  const input = briefInput();
  input.controls = new Map([
    [TOKEN, { multiplierWad: '2000000000000000000', scheduleRead: 'read', schedule: null }],
  ]);
  const result = stockBriefV1(input);
  assert.equal(result.holdings[0]?.reference?.valueUsd, '0.201784');
  assert.equal(result.holdings[0]?.multiplierWad, '2000000000000000000');
  assert.match(result.miorailSummary.summary, /not sale proceeds/);
  assert.equal('executableValueUsd' in result.holdings[0]!, false);
});

test('old, future or failed references stay unavailable rather than becoming zero-dollar holdings', () => {
  const input = briefInput();
  input.references = [
    { tokenAddress: TOKEN, price: 228, at: '2026-09-24T00:00:00.000Z' },
    { tokenAddress: TOKEN, price: 230, at: '2026-10-01T00:00:00.000Z' },
  ];
  assert.equal(stockBriefV1(input).holdings[0]?.reference, null);
});

test('the return window is bounded and future or malformed windows refuse before reading', () => {
  assert.equal(stockBriefWindowV1(NOW).since, '2026-09-29T21:00:00.000Z');
  assert.deepEqual(stockBriefWindowV1(NOW, '2026-08-01T00:00:00.000Z'), {
    since: '2026-09-23T21:00:00.000Z',
    windowClamped: true,
  });
  assert.throws(() => stockBriefWindowV1(NOW, '2026-10-01T00:00:00.000Z'));
  assert.throws(() => stockBriefWindowV1(NOW, 'not-a-time'));
});

test('unrelated events and older holdings are not presented as personal news; watched assets and lookalikes are included', () => {
  const input = briefInput();
  const card = {
    signalId: '1',
    chainId: 8453 as const,
    kind: 'official_asset_multiplier_changed' as const,
    subjectAddress: TOKEN,
    subjectTicker: 'NVDAc',
    officialAddress: null,
    officialTicker: null,
    occurredAt: '2026-09-30T20:00:00.000Z',
    recordedAt: '2026-09-30T20:00:01.000Z',
    facts: {},
  };
  const changes = {
    ...FEED,
    cards: [
      card,
      { ...card, signalId: '2', subjectAddress: OTHER },
      { ...card, signalId: '3', subjectAddress: OTHER, officialAddress: TOKEN },
    ],
  };
  assert.deepEqual(
    stockBriefV1({ ...input, changes }).changes?.cards.map((row) => row.signalId),
    ['1', '3'],
  );
  assert.equal(
    stockBriefV1({ ...input, changes, watchedAddresses: [OTHER] }).changes?.cards.length,
    3,
  );
  assert.equal(
    stockBriefV1({ ...input, changes, since: '2026-09-30T20:30:00.000Z' }).changes?.cards.length,
    0,
  );
  const failed = stockBriefV1({ ...input, changes: null });
  assert.equal(failed.changesUnavailable, true);
  assert.match(failed.miorailSummary.summary, /could not be read/);
  assert.equal(
    stockBriefV1({
      ...input,
      changes: {
        ...FEED,
        cards: Array.from({ length: 200 }, (_, i) => ({ ...card, signalId: String(i) })),
      },
    }).changesTruncated,
    true,
  );
});
