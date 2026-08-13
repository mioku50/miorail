import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  LAUNCH_CONFIRMATIONS_V1,
  LAUNCH_LOG_PACE_MS_V1,
  LAUNCH_LOG_WINDOW_V1,
  LAUNCH_REWIND_DEPTH_V1,
  detectReorgV1,
  logWindowsV1,
  readB20LaunchesV1,
  rewindCursorV1,
  type LaunchLogSourceV1,
} from '../src/launchReader.js';
import { retryableV1 } from '../src/launchSource.js';
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

interface RecordingSourceV1 extends LaunchLogSourceV1 {
  /** Every `eth_getLogs` window this source was asked for, in order. */
  windows: { fromBlock: number; toBlock: number }[];
}

function source(
  logs: RawLogV1[] | null,
  head: number | null = 10_000,
  anchors: (block: number) => string | null = hashOf,
  failWindowAt: number | null = null,
): RecordingSourceV1 {
  const windows: { fromBlock: number; toBlock: number }[] = [];
  return {
    windows,
    async getLogs({ fromBlock, toBlock }) {
      windows.push({ fromBlock, toBlock });
      if (failWindowAt !== null && windows.length === failWindowAt) return null;
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

/** No pacing and a window wide enough to keep the existing tests at one
 * request each — pagination has its own suite below. */
const ONE_WINDOW = { logWindow: 100_000, logPaceMs: 0 } as const;

const CURSOR = { lastProcessedBlock: 1000, lastProcessedBlockHash: null };

describe('the cursor never passes a range that was not fully read', () => {
  test('a clean pass advances to the end of the bounded window', async () => {
    const result = await readB20LaunchesV1({
      ...ONE_WINDOW,
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
    const result = await readB20LaunchesV1({ ...ONE_WINDOW, source: source([broken]), cursor: CURSOR });
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
      ...ONE_WINDOW,
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
    const result = await readB20LaunchesV1({ ...ONE_WINDOW, source: source([broken]), cursor: CURSOR });
    assert.equal(result.state.status, 'decoder_mismatch');
    // No token address anywhere in the state: the decoder knows nothing about
    // the token in a log it cannot read.
    assert.ok(!JSON.stringify(result.state).includes(TOKEN));
  });

  test('an unavailable endpoint is not an empty range', async () => {
    const result = await readB20LaunchesV1({ ...ONE_WINDOW, source: source(null), cursor: CURSOR });
    assert.equal(result.state.status, 'endpoint_unavailable');
    assert.equal(result.state.status === 'endpoint_unavailable' && result.state.call, 'logs');
    assert.deepEqual(result.nextCursor, CURSOR);
  });

  test('an unavailable head does not advance anything', async () => {
    const result = await readB20LaunchesV1({ ...ONE_WINDOW, source: source([], null), cursor: CURSOR });
    assert.equal(result.state.status, 'endpoint_unavailable');
    assert.equal(result.state.status === 'endpoint_unavailable' && result.state.call, 'head');
    assert.deepEqual(result.nextCursor, CURSOR);
  });

  test('no failure state ever names the endpoint', async () => {
    // The category, never the URL. `BASE_MAINNET_RPC_URL` carries a key.
    const result = await readB20LaunchesV1({ ...ONE_WINDOW, source: source(null), cursor: CURSOR });
    const text = JSON.stringify(result.state).toLowerCase();
    for (const forbidden of ['http', 'rpc', 'key', '://']) {
      assert.ok(!text.includes(forbidden), `the state must not contain "${forbidden}"`);
    }
  });

  test('the cursor resumes exactly where the last run stopped', async () => {
    const logs = [launchLog(1005), launchLog(1150), launchLog(1250)];
    const first = await readB20LaunchesV1({ ...ONE_WINDOW, source: source(logs), cursor: CURSOR, maxRange: 100 });
    assert.deepEqual(first.launches.map((l) => l.blockNumber), ['1005']);
    const second = await readB20LaunchesV1({
      ...ONE_WINDOW,
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
      ...ONE_WINDOW,
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
      ...ONE_WINDOW,
      source: source([launchLog(1005)]),
      cursor: CURSOR,
      maxRange: 100,
    });
    assert.equal(result.nextCursor.lastProcessedBlock, 1100);
    assert.equal(result.nextCursor.lastProcessedBlockHash, hashOf(1100));
  });

  test('a truncated run anchors the block it actually finished', async () => {
    const result = await readB20LaunchesV1({
      ...ONE_WINDOW,
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
      ...ONE_WINDOW,
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
    const result = await readB20LaunchesV1({ ...ONE_WINDOW, source: counting, cursor: CURSOR });
    assert.equal(result.state.status, 'ok');
    assert.deepEqual(result.nextCursor, CURSOR);
    assert.equal(asked, 0, 'a call that cannot change anything must not be paid for');
  });
});

describe('budgets bound a run without losing what they did not reach', () => {
  test('a capped range reports that more remains, and never calls it empty', async () => {
    const result = await readB20LaunchesV1({
      ...ONE_WINDOW,
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
      ...ONE_WINDOW,
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
      ...ONE_WINDOW,
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
      ...ONE_WINDOW,
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
      ...ONE_WINDOW,
      source: source([launchLog(1015)], head),
      cursor: CURSOR,
      confirmations: LAUNCH_CONFIRMATIONS_V1,
    });
    // 1015 is inside the unconfirmed window, so it is simply not there yet.
    assert.equal(result.launches.length, 0);
    assert.ok(result.nextCursor.lastProcessedBlock <= head - LAUNCH_CONFIRMATIONS_V1);
  });

  test('a head behind the cursor does nothing rather than reading backwards', async () => {
    const result = await readB20LaunchesV1({ ...ONE_WINDOW, source: source([], 500), cursor: CURSOR });
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
      ...ONE_WINDOW,
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
    const result = await readB20LaunchesV1({ ...ONE_WINDOW, source: source([foreign]), cursor: CURSOR, maxRange: 100 });
    assert.equal(result.state.status, 'ok');
    assert.equal(result.launches.length, 0);
  });

  test('other topics from the factory are ignored', async () => {
    const other = launchLog(1005);
    other.topics = [keccakWordV1('SomethingElse(address)'), `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`];
    const result = await readB20LaunchesV1({ ...ONE_WINDOW, source: source([other]), cursor: CURSOR, maxRange: 100 });
    assert.equal(result.state.status, 'ok');
    assert.equal(result.launches.length, 0);
  });

  test('a duplicate log within one response is one launch', async () => {
    const result = await readB20LaunchesV1({
      ...ONE_WINDOW,
      source: source([launchLog(1005, 1), launchLog(1005, 1)]),
      cursor: CURSOR,
      maxRange: 100,
    });
    assert.equal(result.launches.length, 1);
  });

  test('the reader never reaches for a balance provider', async () => {
    const raw = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/launchReader.ts', import.meta.url), 'utf8'),
    );
    // Comments stripped: the ban is on CALLING one of these, not on naming one.
    // A comment has to be able to explain that Alchemy's free tier caps
    // `eth_getLogs` at ten blocks, which is why the pagination exists.
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
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

// ---------------------------------------------------------------------------
// T69-A.1 — one pass, many provider-bounded requests.
//
// Alchemy's free tier refuses any `eth_getLogs` window wider than ten blocks
// with JSON-RPC -32600. Every pass therefore became `endpoint_unavailable` and
// the feed could not run at all. The fix separates two numbers that were one:
// how much chain a PASS covers, and how much a REQUEST may ask for.
//
// The rule that survives the split is the same one as before: ALL windows must
// answer before anything is kept. A pass that committed the windows it managed
// would advance the cursor past the ones it did not, and that gap is permanent
// and invisible.
// ---------------------------------------------------------------------------

describe('a pass is split into provider-bounded log requests', () => {
  test('an 800-block pass makes exactly 80 ten-block requests', async () => {
    // §8.1. The shape the free tier actually accepts.
    const from = 49_401_132;
    const feed = source([], from + 800 + LAUNCH_CONFIRMATIONS_V1 - 1, hashOf);
    const result = await readB20LaunchesV1({
      source: feed,
      cursor: { lastProcessedBlock: from - 1, lastProcessedBlockHash: null },
      maxRange: 800,
      logWindow: 10,
      logPaceMs: 0,
    });
    assert.equal(result.state.status, 'ok');
    assert.equal(feed.windows.length, 80);
    assert.equal(result.metrics.logWindowsAttempted, 80);
    assert.equal(result.metrics.logWindowsCompleted, 80);
    assert.equal(feed.windows[0]!.fromBlock, from);
    assert.equal(feed.windows[0]!.toBlock, from + 9);
    assert.equal(feed.windows[79]!.toBlock, from + 799);
  });

  test('no request ever exceeds the configured window, inclusive', async () => {
    // §8.2. Inclusive: 132–141 is TEN blocks, not eleven.
    for (const width of [1, 5, 10, 37]) {
      const windows = logWindowsV1({ fromBlock: 1000, toBlock: 1799, logWindow: width });
      for (const window of windows) {
        const span = window.toBlock - window.fromBlock + 1;
        assert.ok(span <= width, `a ${span}-block window exceeds a limit of ${width}`);
        assert.ok(span >= 1);
      }
      // Contiguous and non-overlapping: a boundary log must not arrive twice,
      // and a block must not fall between two windows.
      for (let index = 1; index < windows.length; index += 1) {
        assert.equal(windows[index]!.fromBlock, windows[index - 1]!.toBlock + 1);
      }
      assert.equal(windows[0]!.fromBlock, 1000);
      assert.equal(windows[windows.length - 1]!.toBlock, 1799);
    }
  });

  test('the final window is short rather than overshooting the pass range', async () => {
    // §8.3. Reading past `toBlock` would pull in blocks the cursor is not about
    // to claim, and their launches would be committed against a cursor that
    // stops short of them.
    const windows = logWindowsV1({ fromBlock: 1000, toBlock: 1024, logWindow: 10 });
    assert.deepEqual(windows, [
      { fromBlock: 1000, toBlock: 1009 },
      { fromBlock: 1010, toBlock: 1019 },
      { fromBlock: 1020, toBlock: 1024 },
    ]);
  });

  test('a single-block range is one window, not zero', async () => {
    assert.deepEqual(logWindowsV1({ fromBlock: 1000, toBlock: 1000, logWindow: 10 }), [
      { fromBlock: 1000, toBlock: 1000 },
    ]);
  });

  test('a failure in the middle stores nothing and leaves the cursor alone', async () => {
    // §8.4. THE test. Forty-nine windows answered; the fiftieth did not. The
    // pass keeps none of it, because a partial range is not the range the
    // cursor would be claiming.
    const from = 1001;
    const logs = [launchLog(1005), launchLog(1105), launchLog(1405)];
    const feed = source(logs, from + 800 + LAUNCH_CONFIRMATIONS_V1 - 1, hashOf, 50);
    const cursor = { lastProcessedBlock: from - 1, lastProcessedBlockHash: null };
    const result = await readB20LaunchesV1({
      source: feed,
      cursor,
      maxRange: 800,
      logWindow: 10,
      logPaceMs: 0,
    });
    assert.equal(result.state.status, 'endpoint_unavailable');
    assert.equal(result.launches.length, 0, 'not even the launches from the 49 windows that answered');
    assert.deepEqual(result.nextCursor, cursor);
    assert.equal(feed.windows.length, 50, 'it stops at the failure rather than finishing the range');
    assert.equal(result.metrics.logWindowsAttempted, 50);
    assert.equal(result.metrics.logWindowsCompleted, 49);
  });

  test('the whole pass can simply be retried', async () => {
    // Nothing durable moved, so the retry is the same request set.
    const from = 1001;
    const cursor = { lastProcessedBlock: from - 1, lastProcessedBlockHash: null };
    const failing = source([launchLog(1005)], 1200, hashOf, 2);
    const first = await readB20LaunchesV1({ source: failing, cursor, maxRange: 100, logWindow: 10, logPaceMs: 0 });
    assert.equal(first.state.status, 'endpoint_unavailable');

    const healthy = source([launchLog(1005)], 1200, hashOf);
    const second = await readB20LaunchesV1({ source: healthy, cursor, maxRange: 100, logWindow: 10, logPaceMs: 0 });
    assert.equal(second.state.status, 'ok');
    assert.equal(second.launches.length, 1);
    assert.equal(second.nextCursor.lastProcessedBlock, 1100);
  });

  test('a log returned by two windows becomes one launch', async () => {
    // §8.5. A boundary log, or an endpoint that includes an edge block in both
    // neighbouring windows. The identity is the log, so it is stored once.
    const duplicated = launchLog(1010, 3);
    const feed: LaunchLogSourceV1 = {
      async getLogs() {
        return [duplicated, duplicated];
      },
      async headBlock() {
        return 1200;
      },
      async blockHash(block: number) {
        return hashOf(block);
      },
    };
    const result = await readB20LaunchesV1({
      source: feed,
      cursor: { lastProcessedBlock: 1000, lastProcessedBlockHash: null },
      maxRange: 100,
      logWindow: 10,
      logPaceMs: 0,
    });
    assert.equal(result.launches.length, 1);
  });

  test('logs from separate requests are ordered deterministically', async () => {
    // §8.6. Nothing guarantees the endpoint returns windows in order, or that a
    // window returns its own logs sorted — and the launch budget stops at a
    // BLOCK boundary, so an unsorted stream would truncate the wrong place.
    const out = [
      launchLog(1030, 1),
      launchLog(1010, 5),
      launchLog(1030, 0),
      launchLog(1020, 2),
    ];
    const feed: LaunchLogSourceV1 = {
      async getLogs({ fromBlock, toBlock }) {
        return out.filter((log) => {
          const block = Number(BigInt(log.blockNumber ?? '0x0'));
          return block >= fromBlock && block <= toBlock;
        });
      },
      async headBlock() {
        return 1200;
      },
      async blockHash(block: number) {
        return hashOf(block);
      },
    };
    const result = await readB20LaunchesV1({
      source: feed,
      cursor: { lastProcessedBlock: 1000, lastProcessedBlockHash: null },
      maxRange: 100,
      logWindow: 5,
      logPaceMs: 0,
    });
    assert.deepEqual(
      result.launches.map((launch) => `${launch.blockNumber}:${launch.logIndex}`),
      ['1010:5', '1020:2', '1030:0', '1030:1'],
    );
  });

  test('a malformed log in the LAST window refuses the whole pass', async () => {
    // §8.7. Everything before it decoded cleanly, and none of it is kept: the
    // range the cursor would claim includes the window that failed.
    const broken = launchLog(1095);
    broken.data = '0x';
    const cursor = { lastProcessedBlock: 1000, lastProcessedBlockHash: null };
    const result = await readB20LaunchesV1({
      source: source([launchLog(1005), launchLog(1045), broken], 1200),
      cursor,
      maxRange: 100,
      logWindow: 10,
      logPaceMs: 0,
    });
    assert.equal(result.state.status, 'decoder_mismatch');
    assert.equal(result.launches.length, 0);
    assert.deepEqual(result.nextCursor, cursor);
  });

  test('the final cursor hash still belongs to the final processed block', async () => {
    // §8.8. Pagination changed how the range is read, not what the cursor means.
    const result = await readB20LaunchesV1({
      source: source([launchLog(1005)], 1112),
      cursor: { lastProcessedBlock: 1000, lastProcessedBlockHash: null },
      maxRange: 100,
      logWindow: 10,
      logPaceMs: 0,
    });
    assert.equal(result.nextCursor.lastProcessedBlock, 1100);
    assert.equal(result.nextCursor.lastProcessedBlockHash, hashOf(1100));
  });

  test('a permissive endpoint can still be read in one request', async () => {
    // §8.9. Public Base accepts a wide window; raising the limit must simply
    // spend fewer round trips, not change a single conclusion.
    const wide = source([launchLog(1005), launchLog(1050)], 1112);
    const narrow = source([launchLog(1005), launchLog(1050)], 1112);
    const cursor = { lastProcessedBlock: 1000, lastProcessedBlockHash: null };
    const one = await readB20LaunchesV1({ source: wide, cursor, maxRange: 100, logWindow: 100, logPaceMs: 0 });
    const many = await readB20LaunchesV1({ source: narrow, cursor, maxRange: 100, logWindow: 10, logPaceMs: 0 });
    assert.equal(wide.windows.length, 1);
    assert.equal(narrow.windows.length, 10);
    assert.deepEqual(one.launches, many.launches);
    assert.deepEqual(one.nextCursor, many.nextCursor);
  });

  test('requests are paced, and the pace is injectable', async () => {
    // §6 — eighty requests in a burst is exactly the shape that trips a rate
    // limiter, and being throttled mid-pass throws away every window paid for.
    const slept: number[] = [];
    const feed = source([], 1112);
    await readB20LaunchesV1({
      source: feed,
      cursor: { lastProcessedBlock: 1000, lastProcessedBlockHash: null },
      maxRange: 100,
      logWindow: 10,
      logPaceMs: 25,
      sleepImpl: async (ms) => {
        slept.push(ms);
      },
    });
    // Between requests, never before the first.
    assert.equal(feed.windows.length, 10);
    assert.equal(slept.length, 9);
    assert.ok(slept.every((ms) => ms === 25));
  });

  test('the default window is the safe floor across endpoints', () => {
    assert.equal(LAUNCH_LOG_WINDOW_V1, 10);
    assert.equal(LAUNCH_LOG_PACE_MS_V1, 250);
  });
});

describe('only genuinely transient failures are repeated', () => {
  test('a throttle, a server error and a dead connection are retried', () => {
    // §6. Facts about the connection: they may differ a second later.
    assert.equal(retryableV1({ httpStatus: 429, transportFailed: false, jsonRpcError: false }), true);
    assert.equal(retryableV1({ httpStatus: 500, transportFailed: false, jsonRpcError: false }), true);
    assert.equal(retryableV1({ httpStatus: 503, transportFailed: false, jsonRpcError: false }), true);
    assert.equal(retryableV1({ httpStatus: null, transportFailed: true, jsonRpcError: false }), true);
  });

  test('a JSON-RPC error is never retried', () => {
    // §6. `-32600` is how Alchemy says "that block range is too wide".
    // Repeating the identical request produces the identical refusal, three
    // times as slowly, and burns quota to learn nothing. The fix is a narrower
    // window, which is the caller's decision.
    assert.equal(retryableV1({ httpStatus: null, transportFailed: false, jsonRpcError: true }), false);
    assert.equal(retryableV1({ httpStatus: 200, transportFailed: false, jsonRpcError: true }), false);
    // Even a 429 envelope carrying an RPC error stays unretried: the request
    // itself was refused on its contents.
    assert.equal(retryableV1({ httpStatus: 429, transportFailed: false, jsonRpcError: true }), false);
  });

  test('an ordinary client error is not retried either', () => {
    for (const status of [400, 401, 403, 404]) {
      assert.equal(
        retryableV1({ httpStatus: status, transportFailed: false, jsonRpcError: false }),
        false,
        `${status} must not be retried`,
      );
    }
  });

  test('a decoder mismatch is not a transport concern at all', async () => {
    // It never reaches the retry path: the reader refuses the pass before the
    // source is asked again.
    const broken = launchLog(1005);
    broken.data = '0x';
    const feed = source([broken], 1112);
    const result = await readB20LaunchesV1({
      source: feed,
      cursor: { lastProcessedBlock: 1000, lastProcessedBlockHash: null },
      maxRange: 100,
      logWindow: 100,
      logPaceMs: 0,
    });
    assert.equal(result.state.status, 'decoder_mismatch');
    assert.equal(feed.windows.length, 1, 'the window is not requested again');
  });
});
