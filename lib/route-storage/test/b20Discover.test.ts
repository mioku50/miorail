import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import {
  B20_DISCOVER_INERT_RESULTS_V1,
  B20_DISCOVER_LANE_V1,
  B20_DISCOVER_RUN_RESULTS_V1,
  InMemoryB20DiscoverRepositoryV1,
  RouteStorageIntegrityError,
  assertDiscoverRunV1,
  assertStoredLaunchV1,
  discoverCommitRefusalV1,
  discoverCursorIdV1,
  discoverStartCursorV1,
  storedLaunchFromDecodedV1,
} from '../src/index.js';
import { describeB20DiscoverRepositoryV1, hashV1, launchFixtureV1, runFixtureV1 } from './b20Discover.contract.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// T69-A — the rules that must hold before any of this reaches a database.
// ---------------------------------------------------------------------------

describe('a worker never guesses where to start reading', () => {
  test('no cursor and no configuration is an operator decision, not a default', () => {
    // §4/§12.11. The alternative — starting "somewhere recent" — silently
    // defines away every launch before the guess, and nothing downstream could
    // tell that from a chain with no launches on it.
    assert.equal(
      discoverStartCursorV1({ cursor: null, configuredStartBlock: null }).status,
      'configuration_required',
    );
  });

  test('a configured start block becomes the block BEFORE it', () => {
    // The cursor names the last block already read; the operator names the
    // first block they want read. Off by one here re-reads or skips a block.
    const start = discoverStartCursorV1({ cursor: null, configuredStartBlock: 49_401_482 });
    assert.equal(start.status, 'initialise');
    assert.equal(start.status === 'initialise' && start.startBlock, '49401481');
  });

  test('block zero is a legitimate start and does not underflow', () => {
    const start = discoverStartCursorV1({ cursor: null, configuredStartBlock: 0 });
    assert.equal(start.status === 'initialise' && start.startBlock, '0');
  });

  test('a nonsense configured block is refused rather than rounded into one', () => {
    for (const value of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      assert.equal(
        discoverStartCursorV1({ cursor: null, configuredStartBlock: value }).status,
        'configuration_required',
        `${value} must not become a start block`,
      );
    }
  });

  test('an existing cursor always wins over configuration', () => {
    // §12.12. Configuration bootstraps a lane once. A start block that moved a
    // live cursor would re-read history or skip everything in between.
    const cursor = {
      id: discoverCursorIdV1(B20_DISCOVER_LANE_V1),
      ...B20_DISCOVER_LANE_V1,
      lastProcessedBlock: '1000',
      lastProcessedBlockHash: null,
      operatorState: null,
      lastRunId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const start = discoverStartCursorV1({ cursor, configuredStartBlock: 9_999_999 });
    assert.equal(start.status, 'existing');
    assert.equal(start.status === 'existing' && start.cursor.lastProcessedBlock, '1000');
  });

  test('one lane has one id, whatever case it is written in', () => {
    assert.equal(
      discoverCursorIdV1({ ...B20_DISCOVER_LANE_V1, factoryAddress: B20_DISCOVER_LANE_V1.factoryAddress.toUpperCase() }),
      discoverCursorIdV1(B20_DISCOVER_LANE_V1),
    );
  });
});

describe('a run that failed cannot look like a run that read nothing', () => {
  test('every inert result is refused if it claims to have moved the cursor', () => {
    // §6/§10. The single rule the whole feature rests on. A failed endpoint run
    // that recorded an advanced cursor skips every block it never read, and
    // nothing re-reads an old range.
    for (const result of B20_DISCOVER_INERT_RESULTS_V1) {
      assert.throws(
        () => assertDiscoverRunV1(runFixtureV1({ result, endCursorBlock: '1100', startCursorBlock: '1000' })),
        RouteStorageIntegrityError,
        `${result} must not move the cursor`,
      );
    }
  });

  test('every inert result is refused if it claims to have stored a launch', () => {
    for (const result of B20_DISCOVER_INERT_RESULTS_V1) {
      assert.throws(
        () =>
          assertDiscoverRunV1(
            runFixtureV1({ result, endCursorBlock: '1000', launchesRead: 1, launchesInserted: 1 }),
          ),
        RouteStorageIntegrityError,
      );
    }
  });

  test('only a reorg rewind may move the cursor backwards', () => {
    assert.throws(
      () => assertDiscoverRunV1(runFixtureV1({ result: 'success', startCursorBlock: '1100', endCursorBlock: '1000' })),
      RouteStorageIntegrityError,
    );
    assert.doesNotThrow(() =>
      assertDiscoverRunV1(
        runFixtureV1({
          result: 'reorg_rewound',
          startCursorBlock: '1100',
          endCursorBlock: '1000',
          launchesRead: 0,
          launchesInserted: 0,
        }),
      ),
    );
  });

  test('a run cannot have stored more launches than it read', () => {
    assert.throws(
      () => assertDiscoverRunV1(runFixtureV1({ launchesRead: 1, launchesInserted: 2 })),
      RouteStorageIntegrityError,
    );
  });

  test('a run cannot finish before it started', () => {
    assert.throws(
      () => assertDiscoverRunV1(runFixtureV1({ startedAt: '2026-08-03T00:01:00.000Z' })),
      RouteStorageIntegrityError,
    );
  });

  test('the error category is a code, never a provider message', () => {
    // A provider message carries an endpoint, and an endpoint carries a key.
    assert.throws(
      () =>
        assertDiscoverRunV1(
          runFixtureV1({
            result: 'endpoint_unavailable',
            endCursorBlock: '1000',
            launchesRead: 0,
            launchesInserted: 0,
            errorCategory: 'FetchError: request to https://mainnet.example/v2/KEY failed',
          }),
        ),
      RouteStorageIntegrityError,
    );
  });

  test('the declared result vocabulary is exactly what the migration allows', () => {
    const migration = readFileSync(
      path.join(here, '..', '..', 'db', 'drizzle', '0028_t69a_b20_discover_ingestion.sql'),
      'utf8',
    );
    const match = /b20_discover_runs_result_check" CHECK \("result" IN \(([^)]*)\)\)/.exec(migration);
    assert.ok(match, 'the result CHECK must be present');
    const allowed = match[1]!.split(',').map((value) => value.trim().replace(/'/g, ''));
    // Drift here shows up as a run the application produces and the database
    // refuses — at 3am, on a timer, with nobody reading the exit code.
    assert.deepEqual([...allowed].sort(), [...B20_DISCOVER_RUN_RESULTS_V1].sort());
  });
});

describe('a launch is chain evidence and nothing else', () => {
  test('a decoded launch becomes a stored launch without gaining a field', () => {
    const stored = storedLaunchFromDecodedV1({
      launch: {
        chainId: 8453,
        factoryAddress: B20_DISCOVER_LANE_V1.factoryAddress,
        tokenAddress: '0xb200000000000000000000d6f666fe8b27595c01',
        variant: 'asset',
        name: 'o1 mascot',
        symbol: 'DINo1',
        decimals: 18,
        blockNumber: '49401482',
        blockHash: hashV1('a'),
        transactionHash: hashV1('1'),
        transactionIndex: null,
        logIndex: 3,
        decoderVersion: B20_DISCOVER_LANE_V1.decoderVersion,
      },
      detectedAt: '2026-08-03T00:00:00.000Z',
      confirmationCount: 12,
    });
    assert.equal(stored.id, `${hashV1('1')}:3`);
    assert.equal(stored.canonical, true);
    assert.equal(stored.nonCanonicalAt, null);
    assert.equal(stored.transactionIndex, null, 'absent rather than invented');
  });

  test('unknown decimals stay unknown', () => {
    // Defaulting to 18 would misprice every amount downstream, silently.
    const stored = launchFixtureV1({ decimals: null });
    assert.equal(assertStoredLaunchV1(stored).decimals, null);
  });

  test('a launch cannot be both canonical and reorged out', () => {
    assert.throws(
      () => assertStoredLaunchV1(launchFixtureV1({ canonical: true, nonCanonicalAt: '2026-08-03T00:00:00.000Z' })),
      RouteStorageIntegrityError,
    );
    assert.throws(
      () => assertStoredLaunchV1(launchFixtureV1({ canonical: false, nonCanonicalAt: null })),
      RouteStorageIntegrityError,
    );
  });

  test('a launch from another chain or another factory is not storable', () => {
    assert.throws(() => assertStoredLaunchV1(launchFixtureV1({ chainId: 1 as never })), RouteStorageIntegrityError);
    assert.throws(
      () => assertStoredLaunchV1(launchFixtureV1({ factoryAddress: '0x1111111111111111111111111111111111111111' as never })),
      RouteStorageIntegrityError,
    );
  });

  test('a launch decoded by an unknown decoder is not evidence', () => {
    assert.throws(
      () => assertStoredLaunchV1(launchFixtureV1({ decoderVersion: 'b20-created/v2' as never })),
      RouteStorageIntegrityError,
    );
  });
});

describe('a commit may not claim more than it read', () => {
  const cursor = {
    id: discoverCursorIdV1(B20_DISCOVER_LANE_V1),
    ...B20_DISCOVER_LANE_V1,
    lastProcessedBlock: '1000',
    lastProcessedBlockHash: null,
    operatorState: null,
    lastRunId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  } as const;

  test('a launch past the block the cursor names is refused', () => {
    const refusal = discoverCommitRefusalV1({
      cursor,
      launches: [launchFixtureV1({ blockNumber: '1200' })],
      nextBlock: '1100',
      nextBlockHash: hashV1('b'),
    });
    assert.match(String(refusal), /beyond the block/);
  });

  test('a launch from a block the cursor already passed is refused', () => {
    const refusal = discoverCommitRefusalV1({
      cursor,
      launches: [launchFixtureV1({ blockNumber: '900' })],
      nextBlock: '1100',
      nextBlockHash: hashV1('b'),
    });
    assert.match(String(refusal), /already passed/);
  });

  test('a launch from another decoder version cannot ride along', () => {
    const refusal = discoverCommitRefusalV1({
      cursor,
      launches: [{ ...launchFixtureV1({ blockNumber: '1050' }), decoderVersion: 'b20-created/v9' as never }],
      nextBlock: '1100',
      nextBlockHash: hashV1('b'),
    });
    assert.match(String(refusal), /another decoder version/);
  });

  test('an advance with no anchor hash is refused', () => {
    assert.match(
      String(
        discoverCommitRefusalV1({ cursor, launches: [], nextBlock: '1100', nextBlockHash: '0xnothex' }),
      ),
      /hash of the block it names/,
    );
  });

  test('a clean commit has nothing to refuse', () => {
    assert.equal(
      discoverCommitRefusalV1({
        cursor,
        launches: [launchFixtureV1({ blockNumber: '1050' })],
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
      }),
      null,
    );
  });
});

describe('nothing in discover storage can reach a wallet or a balance provider', () => {
  test('no signer, no submission, no credentials', () => {
    // §11/§12.21/§12.22. Ingestion is read-only against Base by construction,
    // not by intention.
    for (const file of ['b20Discover.ts', 'b20DiscoverMemory.ts', 'b20DiscoverDatabase.ts']) {
      const source = readFileSync(path.join(here, '..', 'src', file), 'utf8');
      for (const forbidden of [
        'moralis',
        'alchemy',
        'covalent',
        'zerion',
        'privateKey',
        'signTransaction',
        'sendCalls',
        'eth_sendRawTransaction',
        'DATABASE_URL',
        'RPC_URL',
        'apiKey',
        'authorization',
      ]) {
        assert.ok(
          !source.toLowerCase().includes(forbidden.toLowerCase()),
          `${file} must not mention ${forbidden}`,
        );
      }
    }
  });
});

// The same contract, against the store that has to behave exactly like the
// database. The Postgres side runs it in lib/db/migration0028.constraints.test.ts.
describeB20DiscoverRepositoryV1('in-memory', async () => {
  const repository = new InMemoryB20DiscoverRepositoryV1();
  return {
    repository,
    async breakWrites() {
      repository.failNextWrite = 'simulated storage failure';
    },
    async healWrites() {
      repository.failNextWrite = null;
    },
  };
});
