import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { B20CorporateActionObservationV1 } from '@mioagent/b20-control';
import { assertRwaSignalV1, type RwaOnchainSignalKindV1 } from '@mioagent/route-storage';

import { corporateActionSignalsV1 } from '../src/signals.js';

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const OPERATOR = '0x00000000000000000000000000000000000000aa';
const TX = `0x${'a'.repeat(64)}`;
const WATCH_OPENED = '2026-09-12T09:00:00.000Z';

const watching = new Map<RwaOnchainSignalKindV1, string>([
  ['official_asset_corporate_action_announced', WATCH_OPENED],
  ['official_asset_multiplier_changed', WATCH_OPENED],
]);

function observationV1(
  overrides: Omit<Partial<B20CorporateActionObservationV1>, 'action'> & {
    action?: Partial<B20CorporateActionObservationV1['action']>;
  } = {},
): B20CorporateActionObservationV1 {
  const { action, ...rest } = overrides;
  return {
    tokenAddress: AAPL,
    action: {
      event: 'announcement',
      payload: 'decoded',
      announcementId: '2026-01',
      caller: OPERATOR,
      description: 'cash dividend of 0.24 per share',
      uri: 'https://example.test/2026-01',
      multiplierWad: null,
      ...action,
    },
    blockNumber: 50_430_000,
    blockTime: '2026-09-12T10:00:00.000Z',
    transactionHash: TX,
    logIndex: 3,
    topics: [`0x${'c'.repeat(64)}`],
    data: '0xabcdef',
    ...rest,
  };
}

describe('corporate action signals', () => {
  test('an announcement inside the watch is one transition, in the issuer own words', () => {
    const [signal, ...rest] = corporateActionSignalsV1({
      observations: [observationV1()],
      watchingSince: watching,
    });
    assert.equal(rest.length, 0);
    assert.ok(signal);
    assert.equal(signal.kind, 'official_asset_corporate_action_announced');
    assert.equal(signal.subjectAddress, AAPL);
    // The BLOCK's time, not ours: an announcement executed when it executed.
    assert.equal(signal.occurredAt, '2026-09-12T10:00:00.000Z');
    assert.deepEqual(signal.facts, {
      event: 'announcement',
      announcementId: '2026-01',
      description: 'cash dividend of 0.24 per share',
      uri: 'https://example.test/2026-01',
      payloadState: 'decoded',
      transactionHash: TX,
      blockNumber: '50430000',
    });
    // ...and it survives the store's own schema, which is the only thing that
    // decides whether a worker can write it.
    assert.doesNotThrow(() => assertRwaSignalV1(signal, 'write'));
  });

  test('the closing bracket is not a second corporate action', () => {
    const signals = corporateActionSignalsV1({
      observations: [
        observationV1(),
        observationV1({
          logIndex: 9,
          action: { event: 'end_announcement', caller: null, description: null, uri: null },
        }),
      ],
      watchingSince: watching,
    });
    assert.equal(signals.length, 1, 'one action, one row — not an open and a close');
  });

  test('anything older than the watch is history, and history is not news', () => {
    // The tail may be pointed at any range, and it should be pointed at a long
    // one once: that is how "nothing has ever been announced" becomes a
    // measurement. None of it may reach the feed.
    const signals = corporateActionSignalsV1({
      observations: [observationV1({ blockTime: '2026-08-01T10:00:00.000Z' })],
      watchingSince: watching,
    });
    assert.deepEqual(signals, []);
  });

  test('a kind nobody is watching emits nothing at all', () => {
    const signals = corporateActionSignalsV1({
      observations: [observationV1(), observationV1({ logIndex: 4, action: { event: 'multiplier_updated', announcementId: null, caller: null, description: null, uri: null, multiplierWad: '2000000000000000000' } })],
      watchingSince: new Map([['official_asset_multiplier_changed', WATCH_OPENED]]),
    });
    assert.deepEqual(signals.map((row) => row.kind), ['official_asset_multiplier_changed']);
  });

  test('an unreadable payload still reports that the action executed', () => {
    const [signal] = corporateActionSignalsV1({
      observations: [
        observationV1({
          action: {
            payload: 'topic_only',
            announcementId: null,
            caller: null,
            description: null,
            uri: null,
          },
        }),
      ],
      watchingSince: watching,
    });
    assert.ok(signal);
    assert.equal(signal.kind, 'official_asset_corporate_action_announced');
    if (signal.kind !== 'official_asset_corporate_action_announced') return;
    assert.equal(signal.facts.payloadState, 'topic_only');
    assert.equal(signal.facts.description, null);
    // The transaction is the fact that survives: a reader can go and look.
    assert.equal(signal.facts.transactionHash, TX);
  });

  test('both multiplier setters land on one kind', () => {
    for (const event of ['multiplier_updated', 'ui_multiplier_updated'] as const) {
      const [signal] = corporateActionSignalsV1({
        observations: [
          observationV1({
            action: {
              event,
              announcementId: null,
              caller: null,
              description: null,
              uri: null,
              multiplierWad: '1057380318816778075',
            },
          }),
        ],
        watchingSince: watching,
      });
      assert.ok(signal);
      assert.equal(signal.kind, 'official_asset_multiplier_changed');
      if (signal.kind !== 'official_asset_multiplier_changed') return;
      assert.equal(signal.facts.event, event, 'which setter was used is still recorded');
      assert.equal(signal.facts.multiplierWad, '1057380318816778075');
      assert.doesNotThrow(() => assertRwaSignalV1(signal, 'write'));
    }
  });

  test('one log is one transition, so a re-read writes the same key', () => {
    const once = corporateActionSignalsV1({ observations: [observationV1()], watchingSince: watching });
    const again = corporateActionSignalsV1({ observations: [observationV1()], watchingSince: watching });
    assert.equal(once[0]!.dedupeKey, again[0]!.dedupeKey);
    assert.match(once[0]!.dedupeKey, /:0xa{64}:3$/);
  });
});
