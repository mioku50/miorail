import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  LAUNCH_CONFIRMATIONS_V1,
  LAUNCH_REWIND_DEPTH_V1,
  detectReorgV1,
  readB20LaunchesV1,
  rewindCursorV1,
  type LaunchLogSourceV1,
} from '../src/launchReader.js';
import { B20_CREATED_TOPIC_V1, type RawLogV1 } from '../src/launches.js';
import { B20_FACTORY_V1, keccakWordV1 } from '../src/pinned.js';

// ---------------------------------------------------------------------------
// T69 §0/§1/§3 — the cursor is the thing that must never lie.
//
// Every test below is about one of two failures:
//
//   * a cursor that moved past blocks nobody read. That gap is permanent and
//     invisible — nothing re-reads an old range, and a missing launch looks
//     exactly like a quiet hour.
//
//   * a cursor whose hash belongs to a different block than its number. That
//     one is worse, because the reorg check then compares a real hash against
//     the wrong block and answers confidently either way.
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

/** The chain's hash for a block, so the fixture and the anchor read agree the
 * way a real endpoint would. */
const hashOf = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;

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
    blockHash: hashOf(block),
    transactionHash: `0x${(block * 1000 + logIndex).toString(16).padStart(64, '0')}`,
    logIndex: `0x${logIndex.toString(16)}`,
    ...overrides,
  };
}

function source(
  logs: RawLogV1[] | null,
  head: number | null = 10_000,
  anchors: (block: number) => string | null = hashOf,
): LaunchLogSourceV1 {
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
    async blockHash(block) {
      return anchors(block);
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

  test('a decoder mismatch beyond the launch budget still stops the run', async () => {
    // The budget decides what is COMMITTED, never what is inspected. A bad log
    // in the tail of the window would otherwise be silently deferred to a run
    // that starts after it.
    const broken = launchLog(1050);
    broken.data = '0x';
    const result = await readB20LaunchesV1({
      source: source([launchLog(1005), launchLog(1006), broken]),
      cursor: CURSOR,
      maxRange: 100,
      maxLaunches: 1,
    });
    assert.equal(result.state.status, 'decoder_mismatch');
    assert.deepEqual(result.nextCursor, CURSOR);
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
    assert.equal(result.state.status === 'endpoint_unavailable' && result.state.call, 'logs');
    assert.deepEqual(result.nextCursor, CURSOR);
  });

  test('an unavailable head does not advance anything', async () => {
    const result = await readB20LaunchesV1({ source: source([], null), cursor: CURSOR });
    assert.equal(result.state.status, 'endpoint_unavailable');
    assert.equal(result.state.status === 'endpoint_unavailable' && result.state.call, 'head');
    assert.deepEqual(result.nextCursor, CURSOR);
  });

  test('no failure state ever names the endpoint', async () => {
    // The category, never the URL. `BASE_MAINNET_RPC_URL` carries a key.
    const result = await readB20LaunchesV1({ source: source(null), cursor: CURSOR });
    const text = JSON.stringify(result.state).toLowerCase();
    for (const forbidden of ['http', 'rpc', 'key', '://']) {
      assert.ok(!text.includes(forbidden), `the state must not contain "${forbidden}"`);
    }
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

describe('the cursor hash belongs to the cursor block, always', () => {
  test('a range with no launches at all still advances with a real anchor', async () => {
    // §12.1. The case the old reader got wrong: no launch in the window means
    // no log to take a hash from, and the previous cursor's hash belongs to a
    // block hundreds behind.
    const result = await readB20LaunchesV1({
      source: source([], 2_000),
      cursor: { lastProcessedBlock: 1000, lastProcessedBlockHash: hashOf(1000) },
      maxRange: 100,
    });
    assert.equal(result.state.status, 'ok');
    assert.equal(result.launches.length, 0);
    assert.equal(result.nextCursor.lastProcessedBlock, 1100);
    assert.equal(result.nextCursor.lastProcessedBlockHash, hashOf(1100));
    assert.notEqual(result.nextCursor.lastProcessedBlockHash, hashOf(1000), 'the old hash must not be reused');
  });

  test('the anchor is the final block of the range, not the block of the last launch', async () => {
    // §12.2. A launch at 1005 and a window ending at 1100: taking the launch's
    // block hash would anchor block 1100 to block 1005's hash.
    const result = await readB20LaunchesV1({
      source: source([launchLog(1005)]),
      cursor: CURSOR,
      maxRange: 100,
    });
    assert.equal(result.nextCursor.lastProcessedBlock, 1100);
    assert.equal(result.nextCursor.lastProcessedBlockHash, hashOf(1100));
  });

  test('a truncated run anchors the block it actually finished', async () => {
    const result = await readB20LaunchesV1({
      source: source([launchLog(1005), launchLog(1006), launchLog(1007)]),
      cursor: CURSOR,
      maxRange: 500,
      maxLaunches: 2,
    });
    assert.equal(result.nextCursor.lastProcessedBlock, 1006);
    assert.equal(result.nextCursor.lastProcessedBlockHash, hashOf(1006));
  });

  test('an unreadable anchor prevents the cursor from advancing at all', async () => {
    // §12.3. The launches are dropped with it. They cost nothing to re-read;
    // an unverifiable cursor costs a reorg nobody can detect.
    const result = await readB20LaunchesV1({
      source: source([launchLog(1005)], 10_000, () => null),
      cursor: CURSOR,
      maxRange: 100,
    });
    assert.equal(result.state.status, 'endpoint_unavailable');
    assert.equal(result.state.status === 'endpoint_unavailable' && result.state.call, 'anchor');
    assert.deepEqual(result.nextCursor, CURSOR);
    assert.equal(result.launches.length, 0);
  });

  test('a cursor that does not move needs no anchor read', async () => {
    let asked = 0;
    const counting: LaunchLogSourceV1 = {
      ...source([], 500),
      async blockHash(block) {
        asked += 1;
        return hashOf(block);
      },
    };
    const result = await readB20LaunchesV1({ source: counting, cursor: CURSOR });
    assert.equal(result.state.status, 'ok');
    assert.deepEqual(result.nextCursor, CURSOR);
    assert.equal(asked, 0, 'a call that cannot change anything must not be paid for');
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
    assert.equal(result.confirmedHead, 10_000 - LAUNCH_CONFIRMATIONS_V1);
  });

  test('the launch cap never cuts a block in half', async () => {
    // §12.4. Block 1005 carries three launches and the budget is two. Stopping
    // inside it would either lose the third forever or return the block again
    // on every run.
    const result = await readB20LaunchesV1({
      source: source([launchLog(1004), launchLog(1005, 0), launchLog(1005, 1), launchLog(1005, 2)]),
      cursor: CURSOR,
      maxRange: 500,
      maxLaunches: 2,
    });
    assert.deepEqual(result.launches.map((l) => l.blockNumber), ['1004']);
    assert.equal(result.nextCursor.lastProcessedBlock, 1004);
    assert.equal(result.budgetExhausted, true);
  });

  test('a single block bigger than the whole budget is still taken, whole', async () => {
    // §12.5. The alternative is a cursor that returns this block forever and a
    // feed that never moves past it.
    const result = await readB20LaunchesV1({
      source: source([launchLog(1005, 0), launchLog(1005, 1), launchLog(1005, 2), launchLog(1009)]),
      cursor: CURSOR,
      maxRange: 500,
      maxLaunches: 2,
    });
    assert.equal(result.launches.length, 3, 'the over-budget block is committed complete');
    assert.ok(result.launches.every((l) => l.blockNumber === '1005'));
    assert.equal(result.nextCursor.lastProcessedBlock, 1005, 'and the run progresses past it');
    assert.equal(result.budgetExhausted, true);
  });

  test('a launch cap stops between blocks and the cursor stops with it', async () => {
    const result = await readB20LaunchesV1({
      source: source([launchLog(1005), launchLog(1006), launchLog(1007)]),
      cursor: CURSOR,
      maxRange: 500,
      maxLaunches: 2,
    });
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.nextCursor.lastProcessedBlock, 1006);
    assert.ok(result.launches.every((l) => Number(l.blockNumber) <= result.nextCursor.lastProcessedBlock));
  });

  test('a budget reached on the last block with launches leaves nothing behind', async () => {
    // Every remaining block in the window is empty, so the window IS finished
    // and claiming otherwise would re-read it for nothing.
    const result = await readB20LaunchesV1({
      // A head that puts the confirmed head exactly at the end of the window,
      // so nothing is left over for the range cap to report either.
      source: source([launchLog(1005, 0), launchLog(1005, 1)], 1100 + LAUNCH_CONFIRMATIONS_V1),
      cursor: CURSOR,
      maxRange: 100,
      maxLaunches: 2,
    });
    assert.equal(result.launches.length, 2);
    assert.equal(result.nextCursor.lastProcessedBlock, 1100);
    assert.equal(result.budgetExhausted, false);
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
    assert.equal(result.scannedTo, null);
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
    assert.equal(rewound.lastProcessedBlock, 1000 - LAUNCH_REWIND_DEPTH_V1);
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

  test('the reader has no signer and no transaction path', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/launchReader.ts', import.meta.url), 'utf8'),
    );
    for (const forbidden of ['sendCalls', 'signTransaction', 'privateKey', 'eth_sendRawTransaction', 'wallet_']) {
      assert.ok(!source.includes(forbidden), `a read-only reader must not mention ${forbidden}`);
    }
  });
});
