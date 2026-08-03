import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  LAUNCH_CONFIRMATIONS_V1,
  detectReorgV1,
  readB20LaunchesV1,
  rewindCursorV1,
  type LaunchLogSourceV1,
} from '../src/launchReader.js';
import { B20_CREATED_TOPIC_V1, type RawLogV1 } from '../src/launches.js';
import { B20_FACTORY_V1, keccakWordV1 } from '../src/pinned.js';

// ---------------------------------------------------------------------------
// T69 §1/§3 — the cursor is the thing that must never lie.
//
// Every test below is about one failure: a cursor that moved past blocks
// nobody read. That gap is permanent and invisible — nothing re-reads an old
// range, and a missing launch looks exactly like a quiet hour.
// ---------------------------------------------------------------------------

const TOKEN = '0xb200000000000000000000d6f666fe8b27595c01';
const DATA =
  '0x' +
  '0000000000000000000000000000000000000000000000000000000000000080' +
  '00000000000000000000000000000000000000000000000000000000000000c0' +
  '0000000000000000000000000000000000000000000000000000000000000012' +
  '0000000000000000000000000000000000000000000000000000000000000100' +
  '0000000000000000000000000000000000000000000000000000000000000009' +
  '6f31206d6173636f740000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000005' +
  '44494e6f31000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000';

function launchLog(block: number, logIndex = 0, overrides: Partial<RawLogV1> = {}): RawLogV1 {
  return {
    address: B20_FACTORY_V1,
    topics: [
      B20_CREATED_TOPIC_V1,
      `0x000000000000000000000000${TOKEN.slice(2)}`,
      `0x${'0'.repeat(64)}`,
    ],
    data: DATA,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: `0x${block.toString(16).padStart(64, '0')}`,
    transactionHash: `0x${(block * 1000 + logIndex).toString(16).padStart(64, '0')}`,
    logIndex: `0x${logIndex.toString(16)}`,
    ...overrides,
  };
}

function source(logs: RawLogV1[] | null, head: number | null = 10_000): LaunchLogSourceV1 {
  return {
    async getLogs({ fromBlock, toBlock }) {
      if (logs === null) return null;
      return logs.filter((log) => {
        const block = Number(BigInt(log.blockNumber ?? '0x0'));
        return block >= fromBlock && block <= toBlock;
      });
    },
    async headBlock() {
      return head;
    },
  };
}

const CURSOR = { lastProcessedBlock: 1000, lastProcessedBlockHash: null };

describe('the cursor never passes a range that was not fully read', () => {
  test('a clean pass advances to the end of the bounded window', async () => {
    const result = await readB20LaunchesV1({
      source: source([launchLog(1005), launchLog(1010)]),
      cursor: CURSOR,
      maxRange: 100,
    });
    assert.equal(result.state.status, 'ok');
    assert.equal(result.launches.length, 2);
    assert.equal(result.nextCursor.lastProcessedBlock, 1100);
  });

  test('a decoder mismatch stops the reader and keeps the cursor exactly', async () => {
    // The single most important behaviour here. Advancing past a range we could
    // not decode turns a decoder bug into permanent, invisible data loss.
    const broken = launchLog(1005);
    broken.topics = [B20_CREATED_TOPIC_V1, `0x${'0'.repeat(64)}`];
    const result = await readB20LaunchesV1({ source: source([broken]), cursor: CURSOR });
    assert.equal(result.state.status, 'decoder_mismatch');
    assert.equal(result.launches.length, 0, 'nothing is recorded from a range that failed');
    assert.deepEqual(result.nextCursor, CURSOR);
    assert.equal(result.state.status === 'decoder_mismatch' && result.state.refusal, 'topic_count_mismatch');
  });

  test('the mismatch is an operator state, not a fact about a token', async () => {
    const broken = launchLog(1005, 0, { data: '0x' });
    const result = await readB20LaunchesV1({ source: source([broken]), cursor: CURSOR });
    assert.equal(result.state.status, 'decoder_mismatch');
    // No token address anywhere in the state: the decoder knows nothing about
    // the token in a log it cannot read.
    assert.ok(!JSON.stringify(result.state).includes(TOKEN));
  });

  test('an unavailable endpoint is not an empty range', async () => {
    const result = await readB20LaunchesV1({ source: source(null), cursor: CURSOR });
    assert.equal(result.state.status, 'endpoint_unavailable');
    assert.deepEqual(result.nextCursor, CURSOR);
  });

  test('an unavailable head does not advance anything', async () => {
    const result = await readB20LaunchesV1({ source: source([], null), cursor: CURSOR });
    assert.equal(result.state.status, 'endpoint_unavailable');
    assert.deepEqual(result.nextCursor, CURSOR);
  });

  test('the cursor resumes exactly where the last run stopped', async () => {
    const logs = [launchLog(1005), launchLog(1150), launchLog(1250)];
    const first = await readB20LaunchesV1({ source: source(logs), cursor: CURSOR, maxRange: 100 });
    assert.deepEqual(first.launches.map((l) => l.blockNumber), ['1005']);
    const second = await readB20LaunchesV1({
      source: source(logs),
      cursor: first.nextCursor,
      maxRange: 100,
    });
    assert.deepEqual(second.launches.map((l) => l.blockNumber), ['1150']);
    assert.equal(second.nextCursor.lastProcessedBlock, 1200);
  });
});

describe('budgets bound a run without losing what they did not reach', () => {
  test('a capped range reports that more remains, and never calls it empty', async () => {
    const result = await readB20LaunchesV1({
      source: source([], 10_000),
      cursor: CURSOR,
      maxRange: 50,
    });
    assert.equal(result.budgetExhausted, true, 'the rest is not_checked, not empty');
    assert.equal(result.nextCursor.lastProcessedBlock, 1050);
  });

  test('a launch cap stops mid-range and the cursor stops with it', async () => {
    const result = await readB20LaunchesV1({
      source: source([launchLog(1005), launchLog(1006), launchLog(1007)]),
      cursor: CURSOR,
      maxRange: 500,
      maxLaunches: 2,
    });
    assert.equal(result.budgetExhausted, true);
    // It may not claim to have processed block 1500 having stopped at 1006.
    assert.ok(result.nextCursor.lastProcessedBlock < 1500);
    assert.ok(result.launches.every((l) => Number(l.blockNumber) <= result.nextCursor.lastProcessedBlock));
  });

  test('nothing within the confirmation window is read at all', async () => {
    const head = 1020;
    const result = await readB20LaunchesV1({
      source: source([launchLog(1015)], head),
      cursor: CURSOR,
      confirmations: LAUNCH_CONFIRMATIONS_V1,
    });
    // 1015 is inside the unconfirmed window, so it is simply not there yet.
    assert.equal(result.launches.length, 0);
    assert.ok(result.nextCursor.lastProcessedBlock <= head - LAUNCH_CONFIRMATIONS_V1);
  });

  test('a head behind the cursor does nothing rather than reading backwards', async () => {
    const result = await readB20LaunchesV1({ source: source([], 500), cursor: CURSOR });
    assert.equal(result.state.status, 'ok');
    assert.deepEqual(result.nextCursor, CURSOR);
  });
});

describe('reorgs are detected by stored hashes, never assumed away', () => {
  test('a matching hash is not a reorg', () => {
    assert.equal(
      detectReorgV1({
        cursor: { lastProcessedBlock: 1000, lastProcessedBlockHash: `0x${'a'.repeat(64)}` },
        observedHashAtCursor: `0x${'A'.repeat(64)}`,
      }).status,
      'ok',
    );
  });

  test('a changed hash beneath the cursor is a reorg', () => {
    const state = detectReorgV1({
      cursor: { lastProcessedBlock: 1000, lastProcessedBlockHash: `0x${'a'.repeat(64)}` },
      observedHashAtCursor: `0x${'b'.repeat(64)}`,
    });
    assert.equal(state.status, 'reorg_detected');
    assert.equal(state.status === 'reorg_detected' && state.atBlock, '1000');
  });

  test('a cold start is not a reorg', () => {
    // Claiming one would rewind a healthy cursor on every fresh deploy.
    assert.equal(
      detectReorgV1({
        cursor: { lastProcessedBlock: 1000, lastProcessedBlockHash: null },
        observedHashAtCursor: `0x${'b'.repeat(64)}`,
      }).status,
      'ok',
    );
  });

  test('a rewind goes back past the confirmation window and drops the hash', () => {
    const rewound = rewindCursorV1({ lastProcessedBlock: 1000, lastProcessedBlockHash: `0x${'a'.repeat(64)}` });
    assert.ok(rewound.lastProcessedBlock < 1000 - LAUNCH_CONFIRMATIONS_V1);
    // The block that hash named may not exist any more.
    assert.equal(rewound.lastProcessedBlockHash, null);
    assert.equal(rewindCursorV1({ lastProcessedBlock: 3, lastProcessedBlockHash: null }).lastProcessedBlock, 0);
  });

  test('a reorg-removed log is never recorded as a launch', async () => {
    const result = await readB20LaunchesV1({
      source: source([launchLog(1005, 0, { removed: true }), launchLog(1006)]),
      cursor: CURSOR,
      maxRange: 100,
    });
    assert.deepEqual(result.launches.map((l) => l.blockNumber), ['1006']);
  });
});

describe('only the pinned factory and the pinned topic are read', () => {
  test('logs from other contracts are ignored, not decoded', async () => {
    const foreign = launchLog(1005, 0, { address: '0x1111111111111111111111111111111111111111' });
    const result = await readB20LaunchesV1({ source: source([foreign]), cursor: CURSOR, maxRange: 100 });
    assert.equal(result.state.status, 'ok');
    assert.equal(result.launches.length, 0);
  });

  test('other topics from the factory are ignored', async () => {
    const other = launchLog(1005);
    other.topics = [keccakWordV1('SomethingElse(address)'), `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`];
    const result = await readB20LaunchesV1({ source: source([other]), cursor: CURSOR, maxRange: 100 });
    assert.equal(result.state.status, 'ok');
    assert.equal(result.launches.length, 0);
  });

  test('a duplicate log within one response is one launch', async () => {
    const result = await readB20LaunchesV1({
      source: source([launchLog(1005, 1), launchLog(1005, 1)]),
      cursor: CURSOR,
      maxRange: 100,
    });
    assert.equal(result.launches.length, 1);
  });

  test('the reader never reaches for a balance provider', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/launchReader.ts', import.meta.url), 'utf8'),
    );
    // Balance providers do not index B20 precompiles; a feed built on one
    // would silently return nothing.
    for (const forbidden of ['moralis', 'alchemy', 'covalent', 'zerion', 'portfolio', 'balanceOf']) {
      assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `must not use ${forbidden}`);
    }
  });
});
