import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import {
  B20_CREATED_TOPIC_V1,
  B20_FACTORY_V1,
  type LaunchLogSourceV1,
  type RawLogV1,
} from '@mioagent/b20-control';
import { B20_DISCOVER_LANE_V1, InMemoryB20DiscoverRepositoryV1 } from '@mioagent/route-storage';

import {
  B20DiscoverArgError,
  B20_DISCOVER_DEFAULTS_V1,
  B20_DISCOVER_EXIT_CODES_V1,
  formatB20DiscoverSummaryV1,
  parseB20DiscoverArgsV1,
} from './b20DiscoverCli.js';
import { runB20DiscoverPassV1, type DiscoverPassConfigV1 } from './b20DiscoverRun.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** Source with comments removed, so a guard against CALLING something is not
 * also a guard against explaining why it matters. */
function codeOnlyV1(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// T69-A §7/§10/§12 — the worker, with no network and no database.
//
// Every test here is about the same question: after this pass, does the cursor
// claim anything the run did not actually read and store? A cursor that got
// ahead produces a gap nothing re-reads and nobody can see, because a missing
// launch looks exactly like a quiet hour.
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

const hashOf = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;

function launchLog(block: number, logIndex = 0, overrides: Partial<RawLogV1> = {}): RawLogV1 {
  return {
    address: B20_FACTORY_V1,
    topics: [B20_CREATED_TOPIC_V1, `0x000000000000000000000000${TOKEN.slice(2)}`, `0x${'0'.repeat(64)}`],
    data: DATA,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: hashOf(block),
    transactionHash: `0x${(block * 1000 + logIndex).toString(16).padStart(64, '0')}`,
    logIndex: `0x${logIndex.toString(16)}`,
    ...overrides,
  };
}

interface FakeSourceV1 extends LaunchLogSourceV1 {
  calls: string[];
}

function fakeSource(options: {
  logs?: RawLogV1[] | null;
  head?: number | null;
  anchors?: (block: number) => string | null;
}): FakeSourceV1 {
  const logs = options.logs === undefined ? [] : options.logs;
  const head = options.head === undefined ? 10_000 : options.head;
  const anchors = options.anchors ?? hashOf;
  const calls: string[] = [];
  return {
    calls,
    async headBlock() {
      calls.push('headBlock');
      return head;
    },
    async getLogs({ fromBlock, toBlock }) {
      calls.push(`getLogs:${fromBlock}-${toBlock}`);
      if (logs === null) return null;
      return logs.filter((log) => {
        const block = Number(BigInt(log.blockNumber ?? '0x0'));
        return block >= fromBlock && block <= toBlock;
      });
    },
    async blockHash(block) {
      calls.push(`blockHash:${block}`);
      return anchors(block);
    },
  };
}

const CONFIG: DiscoverPassConfigV1 = {
  // Wide enough that a head of 1112 puts the confirmed head (1100) inside the
  // window, so these tests exercise the launch budget rather than the range cap.
  maxRange: 200,
  // Wide enough that most tests here make one request; the pagination tests
  // set their own.
  logWindow: 1000,
  maxLaunches: 200,
  confirmations: 12,
  maxRuntimeMs: 60_000,
  startBlock: 1000,
  rewindDepth: 64,
  leaseTtlMs: 600_000,
};

let runCounter = 0;
async function pass(
  repository: InMemoryB20DiscoverRepositoryV1,
  source: LaunchLogSourceV1,
  overrides: Partial<DiscoverPassConfigV1> = {},
  owner = 'worker-a',
) {
  runCounter += 1;
  return runB20DiscoverPassV1({
    repository,
    source,
    config: { ...CONFIG, ...overrides },
    owner,
    runId: `run-${runCounter}`,
    now: () => new Date('2026-08-03T00:00:00.000Z'),
  });
}

describe('a pass never starts from a guess', () => {
  test('no cursor and no configured start block stops the run', async () => {
    // §12.11. The alternative — starting "somewhere recent" — silently defines
    // away every launch before the guess.
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const source = fakeSource({});
    const outcome = await pass(repository, source, { startBlock: null });
    assert.equal(outcome.result, 'configuration_required');
    assert.equal(source.calls.length, 0, 'the endpoint is not touched at all');
    assert.equal(await repository.getCursor(B20_DISCOVER_LANE_V1), null);
    const runs = await repository.listRecentRuns({ key: B20_DISCOVER_LANE_V1, limit: 5 });
    assert.equal(runs[0]?.result, 'configuration_required');
  });

  test('a configured start block bootstraps the cursor exactly once', async () => {
    // §12.12. The second pass reads on from where the first stopped, not from
    // the configured block again.
    const repository = new InMemoryB20DiscoverRepositoryV1();
    await pass(repository, fakeSource({ head: 1112 }), { startBlock: 1001 });
    const cursor = await repository.getCursor(B20_DISCOVER_LANE_V1);
    assert.equal(cursor?.lastProcessedBlock, '1100');

    const second = fakeSource({ head: 1212 });
    await pass(repository, second, { startBlock: 1001 });
    assert.ok(
      second.calls.some((call) => call.startsWith('getLogs:1101-')),
      `the second pass must resume at 1101, got ${second.calls.join(', ')}`,
    );
  });
});

describe('a failed pass leaves the cursor exactly where it was', () => {
  test('an unavailable endpoint is recorded as a failure, not an empty range', async () => {
    // §12.13. "The endpoint was down" and "the chain was quiet" must never be
    // the same row.
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const outcome = await pass(repository, fakeSource({ logs: null }));
    assert.equal(outcome.result, 'endpoint_unavailable');
    const cursor = await repository.getCursor(B20_DISCOVER_LANE_V1);
    assert.equal(cursor?.lastProcessedBlock, '999', 'still the bootstrap block');
    assert.equal(cursor?.operatorState, 'endpoint_unavailable');
    const runs = await repository.listRecentRuns({ key: B20_DISCOVER_LANE_V1, limit: 5 });
    assert.equal(runs[0]?.result, 'endpoint_unavailable');
    assert.equal(runs[0]?.launchesInserted, 0);
  });

  test('a changed event shape stops the feed and stores nothing from the range', async () => {
    // §12.14. The signature is derived from an observed topic0, not published.
    // If it changes, the only honest outcome is "no launch feed".
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const broken = launchLog(1005);
    broken.topics = [B20_CREATED_TOPIC_V1, `0x${'0'.repeat(64)}`];
    const outcome = await pass(repository, fakeSource({ logs: [broken, launchLog(1006)] }));

    assert.equal(outcome.result, 'decoder_mismatch');
    assert.equal(outcome.refusal, 'topic_count_mismatch');
    assert.equal((await repository.getCursor(B20_DISCOVER_LANE_V1))?.lastProcessedBlock, '999');
    assert.equal(
      (await repository.listLaunches({ key: B20_DISCOVER_LANE_V1, limit: 10 })).length,
      0,
      'not even the launch that decoded cleanly',
    );
    assert.equal((await repository.getCursor(B20_DISCOVER_LANE_V1))?.operatorState, 'decoder_mismatch');
  });

  test('a refusal never records a token against the failure', async () => {
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const broken = launchLog(1005, 0, { data: '0x' });
    const outcome = await pass(repository, fakeSource({ logs: [broken] }));
    const runs = await repository.listRecentRuns({ key: B20_DISCOVER_LANE_V1, limit: 5 });
    assert.ok(!JSON.stringify(runs).includes(TOKEN));
    assert.ok(!JSON.stringify(outcome).includes(TOKEN));
  });

  test('a lost anchor read stops the pass rather than moving the cursor blind', async () => {
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const outcome = await pass(repository, fakeSource({ logs: [launchLog(1005)], anchors: () => null }));
    assert.equal(outcome.result, 'endpoint_unavailable');
    assert.equal((await repository.getCursor(B20_DISCOVER_LANE_V1))?.lastProcessedBlock, '999');
  });

  test('the lease is released even when the pass fails', async () => {
    // A crashed worker holding the cursor would stop ingestion until the TTL
    // expired, and the TTL is a backstop rather than the mechanism.
    const repository = new InMemoryB20DiscoverRepositoryV1();
    await pass(repository, fakeSource({ logs: null }));
    assert.equal((await repository.getCursor(B20_DISCOVER_LANE_V1))?.leaseOwner, null);
  });
});

describe('a clean pass stores what it read and says what it did not reach', () => {
  test('launches are stored and the cursor moves with the anchor of its own block', async () => {
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const outcome = await pass(repository, fakeSource({ logs: [launchLog(1005), launchLog(1010)], head: 1112 }));
    assert.equal(outcome.result, 'success');
    assert.equal(outcome.launchesInserted, 2);
    const cursor = await repository.getCursor(B20_DISCOVER_LANE_V1);
    assert.equal(cursor?.lastProcessedBlock, '1100');
    assert.equal(cursor?.lastProcessedBlockHash, hashOf(1100), 'the hash of 1100, not of a launch block');
  });

  test('a stored launch records how far behind the head it was', async () => {
    const repository = new InMemoryB20DiscoverRepositoryV1();
    await pass(repository, fakeSource({ logs: [launchLog(1005)], head: 1112 }));
    const [stored] = await repository.listLaunches({ key: B20_DISCOVER_LANE_V1, limit: 5 });
    assert.equal(stored?.confirmationCount, 1112 - 1005);
    assert.equal(stored?.decimals, 18);
    assert.equal(stored?.symbol, 'DINo1');
  });

  test('nothing past the confirmation window is neither a failure nor an advance', async () => {
    const repository = new InMemoryB20DiscoverRepositoryV1();
    await repository.initialiseCursor({ key: B20_DISCOVER_LANE_V1, startBlock: '1000', now: '2026-08-03T00:00:00.000Z' });
    const outcome = await pass(repository, fakeSource({ head: 1005 }));
    assert.equal(outcome.result, 'nothing_confirmed');
    assert.equal((await repository.getCursor(B20_DISCOVER_LANE_V1))?.lastProcessedBlock, '1000');
  });

  test('a budget stops on a block boundary and the next pass picks up the rest', async () => {
    // §12.20. Only complete blocks are committed, so the remainder is
    // not_checked rather than lost.
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const logs = [launchLog(1005), launchLog(1006), launchLog(1007)];
    const first = await pass(repository, fakeSource({ logs }), { maxLaunches: 2, maxRange: 500 });
    assert.equal(first.result, 'budget_exhausted');
    assert.equal(first.budgetExhausted, true);
    assert.equal(first.launchesInserted, 2);
    assert.equal((await repository.getCursor(B20_DISCOVER_LANE_V1))?.lastProcessedBlock, '1006');

    const second = await pass(repository, fakeSource({ logs, head: 1019 }), { maxLaunches: 2, maxRange: 500 });
    assert.equal(second.launchesInserted, 1, 'the block the budget stopped before');
    assert.equal((await repository.listLaunches({ key: B20_DISCOVER_LANE_V1, limit: 10 })).length, 3);
  });

  test('a repeated pass over the same chain state changes nothing', async () => {
    // §12.19. The property that makes this safe on a timer.
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const logs = [launchLog(1005)];
    await pass(repository, fakeSource({ logs, head: 1112 }));
    const outcome = await pass(repository, fakeSource({ logs, head: 1112 }));
    assert.equal(outcome.result, 'nothing_confirmed');
    assert.equal((await repository.listLaunches({ key: B20_DISCOVER_LANE_V1, limit: 10 })).length, 1);
    assert.equal((await repository.getCursor(B20_DISCOVER_LANE_V1))?.lastProcessedBlock, '1100');
  });
});

describe('a reorg takes back what the chain took back', () => {
  test('a cold cursor is not a reorg', async () => {
    // §12.16. Claiming one would rewind a healthy cursor on every fresh deploy.
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const source = fakeSource({ head: 1112 });
    const outcome = await pass(repository, source);
    assert.equal(outcome.result, 'success');
    assert.equal(outcome.markedNonCanonical, 0);
  });

  test('a changed hash beneath the cursor rewinds it and un-canonicalises what it read', async () => {
    // §12.15/§12.17. Silently keeping a launch from a block that no longer
    // exists would leave a token in the feed the chain never produced.
    const repository = new InMemoryB20DiscoverRepositoryV1();
    await pass(repository, fakeSource({ logs: [launchLog(1005), launchLog(1090)], head: 1112 }));
    assert.equal((await repository.listLaunches({ key: B20_DISCOVER_LANE_V1, limit: 10 })).length, 2);

    const reorged = fakeSource({
      head: 1112,
      logs: [],
      anchors: (block) => (block === 1100 ? hashOf(999_999) : hashOf(block)),
    });
    const outcome = await pass(repository, reorged);

    assert.equal(outcome.result, 'reorg_rewound');
    assert.equal(outcome.endCursorBlock, '1036', 'back by the configured rewind depth');
    assert.equal(outcome.markedNonCanonical, 1, 'only the launch above the rewind point');
    const canonical = await repository.listLaunches({ key: B20_DISCOVER_LANE_V1, limit: 10 });
    assert.deepEqual(canonical.map((launch) => launch.blockNumber), ['1005']);
    const all = await repository.listLaunches({ key: B20_DISCOVER_LANE_V1, limit: 10, includeNonCanonical: true });
    assert.equal(all.length, 2, 'the reorged-out launch is kept as evidence');
    assert.equal((await repository.getCursor(B20_DISCOVER_LANE_V1))?.operatorState, 'reorg_rewound');
  });

  test('a rewind does not read logs in the same pass', async () => {
    // The rewound range is read on the NEXT pass, from a cursor that is
    // already correct. Reading it now would be reading from a cursor that was
    // wrong a moment ago.
    const repository = new InMemoryB20DiscoverRepositoryV1();
    await pass(repository, fakeSource({ head: 1112 }));
    const reorged = fakeSource({ head: 1112, anchors: (block) => (block === 1100 ? hashOf(7) : hashOf(block)) });
    await pass(repository, reorged);
    assert.ok(!reorged.calls.some((call) => call.startsWith('getLogs')));
  });
});

describe('two workers cannot both advance one cursor', () => {
  test('the second exits immediately rather than waiting', async () => {
    // §12.18. A queued second worker is a slower double read, not a safer one.
    const repository = new InMemoryB20DiscoverRepositoryV1();
    await repository.initialiseCursor({ key: B20_DISCOVER_LANE_V1, startBlock: '1000', now: '2026-08-03T00:00:00.000Z' });
    await repository.acquireWorkerLease({
      key: B20_DISCOVER_LANE_V1,
      owner: 'worker-b',
      now: '2026-08-03T00:00:00.000Z',
      ttlMs: 600_000,
    });
    const source = fakeSource({ logs: [launchLog(1005)] });
    const outcome = await pass(repository, source);
    assert.equal(outcome.result, 'run_already_active');
    assert.equal(source.calls.length, 0, 'it does not even read the head');
    assert.equal((await repository.getCursor(B20_DISCOVER_LANE_V1))?.lastProcessedBlock, '1000');
  });

  test('the run is recorded so an operator can see how often it happens', async () => {
    const repository = new InMemoryB20DiscoverRepositoryV1();
    await repository.initialiseCursor({ key: B20_DISCOVER_LANE_V1, startBlock: '1000', now: '2026-08-03T00:00:00.000Z' });
    await repository.acquireWorkerLease({
      key: B20_DISCOVER_LANE_V1,
      owner: 'worker-b',
      now: '2026-08-03T00:00:00.000Z',
      ttlMs: 600_000,
    });
    await pass(repository, fakeSource({}));
    const runs = await repository.listRecentRuns({ key: B20_DISCOVER_LANE_V1, limit: 5 });
    assert.equal(runs[0]?.result, 'run_already_active');
    assert.equal(runs[0]?.errorCategory, 'lease_held');
  });
});

describe('the command line bounds everything a timer could spend', () => {
  test('defaults are safe to leave alone', () => {
    const args = parseB20DiscoverArgsV1([]);
    assert.equal(args.maxRange, B20_DISCOVER_DEFAULTS_V1.maxRange);
    assert.equal(args.confirmations, B20_DISCOVER_DEFAULTS_V1.confirmations);
    assert.equal(args.startBlock, null, 'no start block is not a default start block');
    assert.equal(args.dryRun, false);
  });

  test('the start block comes from the environment and must be a block number', () => {
    assert.equal(parseB20DiscoverArgsV1([], { B20_DISCOVER_START_BLOCK: '49401482' }).startBlock, 49_401_482);
    // Not rounded, not ignored, not defaulted — refused.
    assert.throws(
      () => parseB20DiscoverArgsV1([], { B20_DISCOVER_START_BLOCK: 'latest' }),
      B20DiscoverArgError,
    );
    assert.throws(() => parseB20DiscoverArgsV1([], { B20_DISCOVER_START_BLOCK: '-5' }), B20DiscoverArgError);
  });

  test('an explicit flag overrides the environment', () => {
    const args = parseB20DiscoverArgsV1(['--start-block=100'], { B20_DISCOVER_START_BLOCK: '900' });
    assert.equal(args.startBlock, 100);
  });

  test('durations and counts are validated rather than coerced', () => {
    assert.equal(parseB20DiscoverArgsV1(['--max-runtime=2m']).maxRuntimeMs, 120_000);
    assert.equal(parseB20DiscoverArgsV1(['--max-range=50']).maxRange, 50);
    for (const bad of ['--max-range=0', '--max-range=abc', '--max-runtime=soon', '--nonsense=1', '--confirmations=-1']) {
      assert.throws(() => parseB20DiscoverArgsV1([bad]), B20DiscoverArgError, `${bad} must be refused`);
    }
  });

  test('every result has an exit code, and only refusals are non-zero', () => {
    for (const [result, code] of Object.entries(B20_DISCOVER_EXIT_CODES_V1)) {
      assert.equal(typeof code, 'number', `${result} needs an exit code`);
    }
    assert.equal(B20_DISCOVER_EXIT_CODES_V1.success, 0);
    assert.equal(B20_DISCOVER_EXIT_CODES_V1.nothing_confirmed, 0);
    assert.equal(B20_DISCOVER_EXIT_CODES_V1.budget_exhausted, 0);
    assert.equal(B20_DISCOVER_EXIT_CODES_V1.reorg_rewound, 0);
    // A changed event shape is the one somebody has to look at.
    assert.equal(B20_DISCOVER_EXIT_CODES_V1.decoder_mismatch, 2);
    // Overlapping timer firings are expected; paging on them trains an
    // operator to ignore the code that matters.
    assert.notEqual(B20_DISCOVER_EXIT_CODES_V1.run_already_active, 0);
    assert.notEqual(B20_DISCOVER_EXIT_CODES_V1.run_already_active, B20_DISCOVER_EXIT_CODES_V1.decoder_mismatch);
  });
});

describe('what a run prints says what happened, including what did not', () => {
  test('a successful run reports both ends of the cursor', async () => {
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const outcome = await pass(repository, fakeSource({ logs: [launchLog(1005)], head: 1112 }));
    const summary = formatB20DiscoverSummaryV1(outcome);
    assert.match(summary, /Start cursor: 999/);
    assert.match(summary, /End cursor: 1,100/);
    assert.match(summary, /New launches stored: 1/);
    assert.match(summary, /Budget exhausted: no/);
  });

  test('a refusal states that the cursor did not move and nothing was stored', async () => {
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const broken = launchLog(1005);
    broken.topics = [B20_CREATED_TOPIC_V1, `0x${'0'.repeat(64)}`];
    const summary = formatB20DiscoverSummaryV1(await pass(repository, fakeSource({ logs: [broken] })));
    assert.match(summary, /B20 Discover stopped/);
    assert.match(summary, /State: decoder_mismatch/);
    assert.match(summary, /Cursor unchanged: 999/);
    assert.match(summary, /No launches from the refused range were stored/);
    assert.match(summary, /Decoder refusal: topic_count_mismatch/);
  });

  test('a missing start block tells the operator what to set', async () => {
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const summary = formatB20DiscoverSummaryV1(await pass(repository, fakeSource({}), { startBlock: null }));
    assert.match(summary, /B20_DISCOVER_START_BLOCK/);
  });

  test('an exhausted budget says the rest was not checked, never that it was empty', async () => {
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const outcome = await pass(repository, fakeSource({ logs: [launchLog(1005), launchLog(1006)] }), {
      maxLaunches: 1,
      maxRange: 500,
    });
    assert.match(formatB20DiscoverSummaryV1(outcome), /not_checked/);
  });

  test('a summary never contains an endpoint or a credential', async () => {
    const repository = new InMemoryB20DiscoverRepositoryV1();
    const summary = formatB20DiscoverSummaryV1(await pass(repository, fakeSource({ logs: null })));
    for (const forbidden of ['http', '://', 'key', 'postgres']) {
      assert.ok(!summary.toLowerCase().includes(forbidden), `the summary must not contain "${forbidden}"`);
    }
  });
});

describe('the worker is read-only against Base', () => {
  test('no signer, no submission path, no balance provider', () => {
    // §12.21/§12.22. A property of the code, not a promise in a comment.
    //
    // Scanned with COMMENTS STRIPPED, and the provider check targets CALL and
    // IMPORT shapes rather than the bare vendor name. The risk is
    // `alchemy_getTokenBalances` or an SDK import; a help line telling an
    // operator that Alchemy's free tier caps `eth_getLogs` at ten blocks is the
    // opposite of a risk — it is the reason the pagination exists.
    for (const file of ['b20_discover.ts', 'b20DiscoverRun.ts', 'b20DiscoverCli.ts']) {
      const source = codeOnlyV1(readFileSync(path.join(here, file), 'utf8'));
      for (const forbidden of [
        'signTransaction',
        'privateKey',
        'sendCalls',
        'eth_sendRawTransaction',
        'wallet_sendCalls',
        // Balance providers do not index B20 precompiles; a feed built on one
        // would silently return nothing.
        'alchemy_',
        'alchemy-sdk',
        'moralis',
        'covalent',
        'zerion',
        'getTokenBalances',
        'getWalletTokenBalances',
      ]) {
        assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `${file} must not use ${forbidden}`);
      }
      // And no import from any of them, whatever it is called.
      for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
        const specifier = match[1]!.toLowerCase();
        for (const vendor of ['alchemy', 'moralis', 'covalent', 'zerion']) {
          assert.ok(!specifier.includes(vendor), `${file} must not import from ${match[1]}`);
        }
      }
    }
  });

  test('the log source encodes three read methods and nothing else', () => {
    const source = readFileSync(
      path.join(here, '..', 'lib', 'b20-control', 'src', 'launchSource.ts'),
      'utf8',
    );
    const methods = [...source.matchAll(/'(eth_[a-zA-Z]+)'/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(methods)].sort(), ['eth_blockNumber', 'eth_getBlockByNumber', 'eth_getLogs']);
  });

  test('the entry point never prints the endpoint it was given', () => {
    const source = readFileSync(path.join(here, 'b20_discover.ts'), 'utf8');
    // The URL is read once, handed to the source, and never logged.
    assert.ok(!/console\.(log|error)\([^)]*rpcUrl/.test(source));
  });
});
