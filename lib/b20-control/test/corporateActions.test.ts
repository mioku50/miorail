import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_CORPORATE_ACTION_SIGNATURES_V1,
  B20_CORPORATE_ACTION_TOPICS_V1,
  B20_CORPORATE_ACTION_TOPIC_LIST_V1,
  b20CorporateActionBlocksV1,
  b20CorporateActionObservationsV1,
  decodeB20CorporateActionLogV1,
} from '../src/corporateActions.js';

// Base publishes these four topic0 values in its errors-and-events index and
// publishes no Solidity signature for them anywhere this corpus carries. The
// signatures in the module were RECOVERED by hashing candidates until one
// matched; this is the assertion that keeps that true. If a signature is ever
// edited, the topic it produces stops matching Base's published value and this
// fails -- rather than the tail quietly filtering for a different event.
const PUBLISHED_V1 = {
  announcement: '0xccebf8218a62875909564adef86a6f4df81503cb617221e793357d62f8e813f7',
  end_announcement: '0x96d64dafe2c790596430196b982ad1da3221cb3b0f4e6e2df77f2e4f71a90037',
  multiplier_updated: '0x4dbe4840d7465bd162f67814cea0b519567a2e0e578bcde61e7f4ced361e5a3d',
  ui_multiplier_updated: '0x2205df4534432b2f60654a3fdb48737ffdaf3e9edb1a498bd985bc026b15b055',
} as const;

const word = (value: bigint) => value.toString(16).padStart(64, '0');

function stringWords(text: string): { head: (offset: number) => string; tail: string } {
  const bytes = Buffer.from(text, 'utf8');
  const padded = Math.ceil(bytes.length / 32) * 32;
  const tail = word(BigInt(bytes.length)) + bytes.toString('hex').padEnd(padded * 2, '0');
  return { head: (offset: number) => word(BigInt(offset)), tail };
}

/** `Announcement(address,string,string,string)` with nothing indexed. */
function announcementData(caller: string, id: string, description: string, uri: string): string {
  const parts = [stringWords(id), stringWords(description), stringWords(uri)];
  let cursor = 4 * 32;
  const heads: string[] = [word(BigInt(caller))];
  const tails: string[] = [];
  for (const part of parts) {
    heads.push(part.head(cursor));
    tails.push(part.tail);
    cursor += part.tail.length / 2;
  }
  return `0x${heads.join('')}${tails.join('')}`;
}

const CALLER = '0x00000000000000000000000000000000000000aa';

describe('B20 corporate action topics', () => {
  test('every topic0 equals the value Base publishes for that event', () => {
    for (const [event, topic] of Object.entries(PUBLISHED_V1)) {
      assert.equal(
        B20_CORPORATE_ACTION_TOPICS_V1[event as keyof typeof PUBLISHED_V1],
        topic,
        `${event} (${B20_CORPORATE_ACTION_SIGNATURES_V1[event as keyof typeof PUBLISHED_V1]})`,
      );
    }
    assert.equal(B20_CORPORATE_ACTION_TOPIC_LIST_V1.length, 4);
  });

  test('a log this build does not recognise is not a corporate action', () => {
    // The ERC-20 Transfer topic. The tail asks for four topics and a node that
    // answered with a fifth must not have it read as an announcement.
    const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    assert.equal(decodeB20CorporateActionLogV1({ topics: [transfer], data: '0x' }), null);
    assert.equal(decodeB20CorporateActionLogV1({ topics: [], data: '0x' }), null);
  });
});

describe('B20 announcement decoding', () => {
  test('carries the issuer own words when every argument is in the data', () => {
    const row = decodeB20CorporateActionLogV1({
      topics: [PUBLISHED_V1.announcement],
      data: announcementData(CALLER, '2026-01', 'stock dividend', 'https://example.test/1'),
    });
    assert.ok(row);
    assert.equal(row.event, 'announcement');
    assert.equal(row.payload, 'decoded');
    assert.equal(row.caller, CALLER);
    assert.equal(row.announcementId, '2026-01');
    assert.equal(row.description, 'stock dividend');
    assert.equal(row.uri, 'https://example.test/1');
  });

  test('an indexed layout is reported as the event with no arguments, never guessed at', () => {
    // Base publishes the topic and not which parameters are indexed. An
    // indexed `string` is stored as a hash of itself, so reading the remaining
    // data as though it started one argument later would attribute somebody
    // else's bytes to the issuer.
    const row = decodeB20CorporateActionLogV1({
      topics: [PUBLISHED_V1.announcement, `0x${word(BigInt(CALLER))}`],
      data: '0x',
    });
    assert.ok(row);
    assert.equal(row.event, 'announcement');
    assert.equal(row.payload, 'topic_only');
    assert.equal(row.description, null);
    assert.equal(row.announcementId, null);
  });

  test('an offset that points past the data reads nothing', () => {
    const data = `0x${word(BigInt(CALLER))}${word(32n * 99n)}${word(96n)}${word(128n)}`;
    const row = decodeB20CorporateActionLogV1({ topics: [PUBLISHED_V1.announcement], data });
    assert.ok(row);
    assert.equal(row.payload, 'topic_only');
  });

  test('an argument longer than the feed carries is refused rather than shortened', () => {
    const long = 'x'.repeat(2_001);
    const row = decodeB20CorporateActionLogV1({
      topics: [PUBLISHED_V1.announcement],
      data: announcementData(CALLER, '2026-02', long, 'https://example.test/2'),
    });
    assert.ok(row);
    assert.equal(row.payload, 'topic_only');
    assert.equal(row.description, null);
  });

  test('bytes that are not text are not a description', () => {
    const bad = `0x${word(BigInt(CALLER))}${word(128n)}${word(192n)}${word(256n)}${word(2n)}${'ff'.repeat(2).padEnd(64, '0')}${word(2n)}${'ff'.repeat(2).padEnd(64, '0')}${word(2n)}${'ff'.repeat(2).padEnd(64, '0')}`;
    const row = decodeB20CorporateActionLogV1({ topics: [PUBLISHED_V1.announcement], data: bad });
    assert.ok(row);
    assert.equal(row.payload, 'topic_only');
  });

  test('the closing bracket carries the same id', () => {
    const id = stringWords('2026-01');
    const row = decodeB20CorporateActionLogV1({
      topics: [PUBLISHED_V1.end_announcement],
      data: `0x${id.head(32)}${id.tail}`,
    });
    assert.ok(row);
    assert.equal(row.event, 'end_announcement');
    assert.equal(row.payload, 'decoded');
    assert.equal(row.announcementId, '2026-01');
  });
});

describe('B20 multiplier events', () => {
  test('both setters are read, and the WAD is never pre-divided', () => {
    const deprecated = decodeB20CorporateActionLogV1({
      topics: [PUBLISHED_V1.multiplier_updated],
      data: `0x${word(1_057_380_318_816_778_075n)}`,
    });
    assert.ok(deprecated);
    assert.equal(deprecated.payload, 'decoded');
    assert.equal(deprecated.multiplierWad, '1057380318816778075');

    const scheduled = decodeB20CorporateActionLogV1({
      topics: [PUBLISHED_V1.ui_multiplier_updated],
      data: `0x${word(2n * 10n ** 18n)}${word(0n)}${word(1_800_000_000n)}`,
    });
    assert.ok(scheduled);
    assert.equal(scheduled.payload, 'decoded');
    assert.equal(scheduled.multiplierWad, '2000000000000000000');
  });

  test('a zero multiplier is not a ratio and is not carried', () => {
    const row = decodeB20CorporateActionLogV1({
      topics: [PUBLISHED_V1.multiplier_updated],
      data: `0x${word(0n)}`,
    });
    assert.ok(row);
    assert.equal(row.payload, 'topic_only');
    assert.equal(row.multiplierWad, null);
  });

  test('a shape this build does not recognise still names the event', () => {
    const row = decodeB20CorporateActionLogV1({
      topics: [PUBLISHED_V1.multiplier_updated],
      data: `0x${word(1n)}${word(2n)}`,
    });
    assert.ok(row);
    assert.equal(row.event, 'multiplier_updated');
    assert.equal(row.payload, 'topic_only');
  });
});

describe('one pass of corporate action logs', () => {
  const TOKEN = '0xb200000000000000000000c2e324d24d7eecd1fb';
  const OTHER = '0x00000000000000000000000000000000000000ff';
  const TX = `0x${'a'.repeat(64)}`;

  const log = (overrides: Record<string, unknown> = {}) => ({
    address: TOKEN,
    topics: [PUBLISHED_V1.multiplier_updated],
    data: `0x${word(10n ** 18n)}`,
    blockNumber: '0x3020304',
    transactionHash: TX,
    logIndex: '0x2',
    ...overrides,
  });

  test('dates every row from the chain, never from our clock', () => {
    const reading = b20CorporateActionObservationsV1({
      logs: [log()],
      blockTimes: new Map([[0x3020304, '2026-09-12T10:00:00.000Z']]),
      tokens: [TOKEN],
    });
    assert.equal(reading.observations.length, 1);
    assert.equal(reading.observations[0]!.blockTime, '2026-09-12T10:00:00.000Z');
    assert.equal(reading.observations[0]!.blockNumber, 0x3020304);
    assert.equal(reading.observations[0]!.logIndex, 2);
    assert.equal(reading.undated, 0);
  });

  test('a log we could not date is counted, never stored', () => {
    // The caller treats a non-zero count as a failed pass. Storing it with our
    // own clock would date a catch-up run's findings to the moment it caught
    // up; dropping it silently would lose an announcement AND move past it.
    const reading = b20CorporateActionObservationsV1({
      logs: [log()],
      blockTimes: new Map(),
      tokens: [TOKEN],
    });
    assert.deepEqual(reading.observations, []);
    assert.equal(reading.undated, 1);
  });

  test('an address nobody asked about never wears a tracked asset name', () => {
    const reading = b20CorporateActionObservationsV1({
      logs: [log({ address: OTHER })],
      blockTimes: new Map([[0x3020304, '2026-09-12T10:00:00.000Z']]),
      tokens: [TOKEN],
    });
    assert.deepEqual(reading.observations, []);
    assert.equal(reading.foreign, 1);
    assert.equal(reading.undated, 0);
  });

  test('a log that is not one of the four events is not counted as anything', () => {
    const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const reading = b20CorporateActionObservationsV1({
      logs: [log({ topics: [transfer] })],
      blockTimes: new Map(),
      tokens: [TOKEN],
    });
    assert.deepEqual(reading, { observations: [], undated: 0, foreign: 0 });
  });

  test('the blocks to date are exactly the blocks that carried a recognised log', () => {
    const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const blocks = b20CorporateActionBlocksV1([
      log({ blockNumber: '0x10' }),
      log({ blockNumber: '0x10', logIndex: '0x3' }),
      log({ blockNumber: '0x20' }),
      log({ blockNumber: '0x30', topics: [transfer] }),
    ]);
    assert.deepEqual(blocks, [0x10, 0x20], 'one block read per block, and none for a Transfer');
  });

  test('the raw log travels even when the arguments did not', () => {
    const reading = b20CorporateActionObservationsV1({
      logs: [log({ topics: [PUBLISHED_V1.announcement, `0x${word(1n)}`], data: '0xBEEF' })],
      blockTimes: new Map([[0x3020304, '2026-09-12T10:00:00.000Z']]),
      tokens: [TOKEN],
    });
    const [row] = reading.observations;
    assert.ok(row);
    assert.equal(row.action.payload, 'topic_only');
    assert.equal(row.data, '0xbeef');
    assert.equal(row.topics.length, 2);
  });
});
