import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import {
  B20_MEASUREMENT_VERSION_V1,
  InMemoryB20DiscoverRepositoryV1,
  InMemoryB20ObservationRepositoryV1,
  OBSERVATION_JSONB_NUMERICS_V1 as B20_OBSERVATION_JSONB_NUMERICS_V1,
  RouteStorageIntegrityError,
  assertObservationV1,
  capacitySamplesHashV1,
  observationEvidenceHashV1,
  observationIdV1,
} from '../src/index.js';
import {
  describeB20ObservationRepositoryV1,
  observationFixtureV1,
  observationHashV1,
} from './b20Observations.contract.js';
import { launchFixtureV1, runFixtureV1 } from './b20Discover.contract.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const LANE = {
  chainId: 8453 as const,
  factoryAddress: '0xb20f000000000000000000000000000000000000' as const,
  decoderVersion: 'b20-created/v1' as const,
};

// ---------------------------------------------------------------------------
// T69-B §1/§13 — what an observation row is allowed to say.
// ---------------------------------------------------------------------------

describe('a stored observation cannot claim more than it measured', () => {
  test('there is no qualified state to write', () => {
    // §16.11, at the storage layer. Even a caller that tried could not.
    assert.throws(
      () => assertObservationV1(observationFixtureV1({ state: 'qualified' as never })),
      RouteStorageIntegrityError,
    );
  });

  test('a pass is always labelled as a pre-entry measurement', () => {
    assert.throws(
      () => assertObservationV1(observationFixtureV1({ reasonCode: 'no_exit_route' })),
      RouteStorageIntegrityError,
    );
  });

  test('a rejection must name why', () => {
    // "Rejected" with no reason is an accusation with no evidence, published
    // about somebody's token, unattended.
    assert.throws(
      () =>
        assertObservationV1(
          observationFixtureV1({ state: 'rejected', reasonCode: null }),
        ),
      RouteStorageIntegrityError,
    );
    assert.doesNotThrow(() =>
      assertObservationV1(observationFixtureV1({ state: 'rejected', reasonCode: 'transfers_paused' })),
    );
  });

  test('a rejection cannot carry an unmeasured reason, or the reverse', () => {
    assert.throws(
      () => assertObservationV1(observationFixtureV1({ state: 'rejected', reasonCode: 'controls_incomplete' })),
      RouteStorageIntegrityError,
    );
    assert.throws(
      () => assertObservationV1(observationFixtureV1({ state: 'unmeasured', reasonCode: 'transfers_paused' })),
      RouteStorageIntegrityError,
    );
  });

  test('a candidate has nothing to explain yet', () => {
    assert.throws(
      () => assertObservationV1(observationFixtureV1({ state: 'candidate', reasonCode: 'quoted_pre_entry' })),
      RouteStorageIntegrityError,
    );
  });

  test('a pass presupposes both legs and the measurements it passed on', () => {
    for (const broken of [
      { entryRouteFound: false },
      { exitRouteFound: false },
      { factoryConfirmed: false },
      { optimisticRoundTripBps: null },
      { largestPassingSizeAtomic: null },
      { controlsComplete: false },
      { transfersPaused: true },
    ]) {
      assert.throws(
        () => assertObservationV1(observationFixtureV1(broken as never)),
        RouteStorageIntegrityError,
        `a provisional row must not survive ${JSON.stringify(broken)}`,
      );
    }
  });

  test('a cost that passed cannot exceed the tolerance it was measured against', () => {
    assert.throws(
      () => assertObservationV1(observationFixtureV1({ optimisticRoundTripBps: 900 })),
      RouteStorageIntegrityError,
    );
  });

  test('a best-route claim needs a proven route and complete coverage', () => {
    // §16.12 at the storage layer: the stronger claim cannot be stored without
    // the weaker one under it.
    assert.throws(
      () => assertObservationV1(observationFixtureV1({ routeCoverage: 'partial', bestRouteConfirmed: true })),
      RouteStorageIntegrityError,
    );
    assert.throws(
      () => assertObservationV1(observationFixtureV1({ viableRouteConfirmed: false, bestRouteConfirmed: true })),
      RouteStorageIntegrityError,
    );
    assert.doesNotThrow(() =>
      assertObservationV1(
        observationFixtureV1({ routeCoverage: 'partial', bestRouteConfirmed: false }),
      ),
    );
  });

  test('an observation must go stale after it was measured', () => {
    assert.throws(
      () => assertObservationV1(observationFixtureV1({ staleAfter: '2026-08-03T00:00:00.000Z' })),
      RouteStorageIntegrityError,
    );
  });

  test('the id and the evidence hash must be derived, not asserted', () => {
    const observation = observationFixtureV1();
    assert.throws(
      () => assertObservationV1({ ...observation, id: 'made-up' }),
      RouteStorageIntegrityError,
    );
    assert.throws(
      () => assertObservationV1({ ...observation, evidenceHash: observationHashV1('f') }),
      RouteStorageIntegrityError,
    );
  });
});

describe('identity and evidence answer different questions', () => {
  test('identity is launch, block, version and profile', () => {
    const base = {
      launchId: 'l',
      observationBlockNumber: '1',
      measurementVersion: B20_MEASUREMENT_VERSION_V1,
      profileIdentity: 'p',
    };
    assert.equal(observationIdV1(base), observationIdV1({ ...base }));
    for (const change of [
      { launchId: 'other' },
      { observationBlockNumber: '2' },
      { measurementVersion: 'b20-observation/v2' },
      { profileIdentity: 'q' },
    ]) {
      assert.notEqual(observationIdV1({ ...base, ...change }), observationIdV1(base));
    }
  });

  test('evidence covers what was measured and not when', () => {
    // The property idempotency rests on: a retry a second later must hash the
    // same, or every retry would look like a disagreement.
    const observation = observationFixtureV1();
    const later = { ...observation, measuredAt: '2026-08-04T00:00:05.000Z', createdAt: '2026-08-04T00:00:05.000Z' };
    assert.equal(observationEvidenceHashV1(later), observation.evidenceHash);
    // But a changed measurement does change it.
    assert.notEqual(
      observationEvidenceHashV1({ ...observation, optimisticRoundTripBps: 101 }),
      observation.evidenceHash,
    );
  });

  test('the capacity samples hash is order-independent and content-sensitive', () => {
    const ascending = [
      { sizeAtomic: '1000', slippageBps: 10 },
      { sizeAtomic: '2000', slippageBps: 50 },
    ];
    assert.equal(capacitySamplesHashV1(ascending), capacitySamplesHashV1([...ascending].reverse()));
    assert.notEqual(
      capacitySamplesHashV1(ascending),
      capacitySamplesHashV1([{ sizeAtomic: '1000', slippageBps: 10 }, { sizeAtomic: '2000', slippageBps: null }]),
      'an unpriced rung is not the same measurement as a priced one',
    );
  });
});

describe('nothing in observation storage can reach a wallet', () => {
  test('no signer, no submission, no credentials, no state override', () => {
    // §15/§16.32.
    for (const file of ['b20Observations.ts', 'b20ObservationsMemory.ts', 'b20ObservationsDatabase.ts']) {
      const source = readFileSync(path.join(here, '..', 'src', file), 'utf8');
      for (const forbidden of [
        'privateKey',
        'signTransaction',
        'sendCalls',
        'eth_sendRawTransaction',
        'stateOverride',
        'state_override',
        'approve(',
        'DATABASE_URL',
        'RPC_URL',
        'apiKey',
        'authorization',
        'moralis',
        'alchemy',
      ]) {
        assert.ok(
          !source.toLowerCase().includes(forbidden.toLowerCase()),
          `${file} must not mention ${forbidden}`,
        );
      }
    }
  });
});

// The same contract the Postgres repository must satisfy. The Postgres side
// runs it in b20Observations.postgres.test.ts.
describeB20ObservationRepositoryV1('in-memory', async () => {
  const launches = new InMemoryB20DiscoverRepositoryV1();
  const repository = new InMemoryB20ObservationRepositoryV1(launches);
  return {
    repository,
    async seedLaunch(input) {
      // Just below the first launch block the contract seeds, so every commit
      // moves the cursor forward exactly as a real pass would.
      await launches.initialiseCursor({ key: LANE, startBlock: '999', now: '2026-08-04T00:00:00.000Z' });
      await launches.acquireWorkerLease({
        key: LANE,
        owner: 'seed',
        now: '2026-08-04T00:00:00.000Z',
        ttlMs: 600_000,
      });
      const [transactionHash] = input.id.split(':');
      await launches.commitRange({
        key: LANE,
        owner: 'seed',
        launches: [
          launchFixtureV1({
            blockNumber: input.blockNumber ?? '1050',
            transactionHash: transactionHash!,
            logIndex: 0,
            tokenAddress: input.tokenAddress,
            detectedAt: input.detectedAt,
            createdAt: input.detectedAt,
          }),
        ],
        // Each seed is its own commit, so the cursor moves to exactly the block
        // it just took — the repository refuses a commit that does not advance,
        // and one that claims blocks past the launch it carries.
        nextBlock: input.blockNumber ?? '1050',
        nextBlockHash: observationHashV1('b'),
        run: runFixtureV1({
          id: `seed-${input.id}`,
          startCursorBlock: '999',
          endCursorBlock: input.blockNumber ?? '1050',
        }),
        now: '2026-08-04T00:00:00.000Z',
      });
      await launches.releaseWorkerLease({ key: LANE, owner: 'seed', now: '2026-08-04T00:00:00.000Z' });
    },
  };
});

describe('the mover query cannot lose precision on a large amount', () => {
  const database = readFileSync(path.join(here, '..', 'src', 'b20ObservationsDatabase.ts'), 'utf8');
  const migration = readFileSync(
    path.join(here, '..', '..', 'db', 'drizzle', '0029_t69b_b20_opportunity_observations.sql'),
    'utf8',
  );

  test('every numeric column is re-cast to text inside the jsonb', () => {
    // `to_jsonb(row.*)` renders a numeric as a JSON NUMBER, and a 78-digit
    // atomic amount comes back as a float — the evidence hash then stops
    // matching, but only for amounts large enough to matter, which is exactly
    // the case nobody has a fixture for.
    for (const column of B20_OBSERVATION_JSONB_NUMERICS_V1) {
      assert.ok(
        database.includes(`'${column}', o.${column}::text`),
        `the latest observation does not re-cast ${column}`,
      );
      assert.ok(
        database.includes(`'${column}', b.${column}::text`),
        `the baseline observation does not re-cast ${column}`,
      );
    }
  });

  test('the list covers every numeric column the table actually has', () => {
    // The half that keeps working when somebody adds a column: read the
    // migration, not the code that is supposed to match it.
    const declared = [...migration.matchAll(/"([a-z_]+)"\s+numeric\b/g)].map((match) => match[1]!);
    assert.ok(declared.length > 0, 'no numeric columns were found in migration 0029');
    const missing = declared.filter(
      (column) => !(B20_OBSERVATION_JSONB_NUMERICS_V1 as readonly string[]).includes(column),
    );
    assert.deepEqual(missing, [], `these numeric columns would be returned as floats: ${missing.join(', ')}`);
  });
});

describe('launch-buyer evidence reaches every Discover read', () => {
  const database = readFileSync(path.join(here, '..', 'src', 'b20ObservationsDatabase.ts'), 'utf8');

  test('market, feed and token-detail queries all join the measured launch window', () => {
    // The row mapper already treats a missing buyer row as honest null. If a
    // read path forgets this join, every measured concentration also becomes
    // null and the UI looks identical to a window nobody measured.
    assert.equal(
      database.match(/LEFT JOIN b20_launch_buyers lb ON lb\.token_address = l\.token_address/g)?.length,
      3,
    );
    assert.equal(
      database.match(/lb\.buyer_count, lb\.top_buyer_share_bps, lb\.top_three_share_bps/g)?.length,
      3,
    );
  });
});
