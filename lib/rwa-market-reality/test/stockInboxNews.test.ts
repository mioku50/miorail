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
