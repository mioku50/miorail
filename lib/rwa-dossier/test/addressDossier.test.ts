import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { AddressIdentityV1Schema, type AddressIdentityV1 } from '../src/addressDossier.js';
import { addressAssertionsV1, cashExitChangeV1 } from '../src/assembleAddress.js';

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const IMPOSTOR = '0xb200000000000000000000dead0000000000ad01';
const BUNDLER = '0x1111111111111111111111111111111111111111';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function identityV1(overrides: Partial<AddressIdentityV1> = {}): AddressIdentityV1 {
  return {
    standing: 'unknown_to_miorail',
    official: null,
    project: null,
    launch: null,
    lookalike: null,
    origin: { status: 'no_launch_row', deployerAddress: null, relation: null, readAt: null },
    contract: { status: 'read', isB20: true, symbol: 'X', name: 'X', decimals: 18 },
    ...overrides,
  } as AddressIdentityV1;
}

const CONTROLS_V1 = {
  status: 'complete' as const,
  blockNumber: '1',
  blockHash: `0x${'a'.repeat(64)}`,
  observedAt: '2026-08-25T12:00:00.000Z',
  multiplier: { status: 'exact_chain_read' as const, atomic: '1', decimals: 18 as const, evidence: null },
  fields: [],
};

function marketV1(routeStatus: Parameters<typeof addressAssertionsV1>[0]['market']['routeStatus']) {
  return {
    routeStatus,
    measuredAt: null,
    approvedSources: ['kyberswap'],
    ladder: [],
    change: {
      status: 'first_reading' as const,
      previousMeasuredAt: null,
      measuredAt: null,
      rungs: [],
    },
    topology: {
      status: 'observed' as const,
      checkedAt: '2026-08-25T12:00:00.000Z',
      checkedThroughBlock: 1,
      venueCount: 0,
      pairedPoolCount: 0,
      singletonCount: 0,
      directCashPoolCount: 0,
      directUsdcPoolCount: 0,
      directEthPoolCount: 0,
      venues: [],
      evidence: null,
    },
    activity: {
      status: 'observed' as const,
      semantics: 'venue_transfers_not_confirmed_swaps' as const,
      checkedAt: '2026-08-25T12:00:00.000Z',
      windowFromBlock: 1,
      windowToBlock: 2,
      movementCount: 3,
      outOfVenueCount: 2,
      intoVenueCount: 1,
      confirmedSwapCount: null,
      latest: [],
      evidence: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Identity safety, and the difference between "no" and "not established".
// ---------------------------------------------------------------------------

describe('the address identity', () => {
  test('a relayed launch shows the relation and never an address', () => {
    // Measured across the stored corpus: 458 launches were sent to the ERC-4337
    // EntryPoint by EIGHT senders. On a relayed transaction `tx.from` is
    // whoever paid to include it, and presenting that as a deployer files one
    // project's record under another's infrastructure.
    const refused = AddressIdentityV1Schema.safeParse(
      identityV1({
        origin: {
          status: 'relayed',
          deployerAddress: BUNDLER,
          relation: 'bundler',
          readAt: '2026-08-25T12:00:00.000Z',
        },
      }),
    );
    assert.equal(refused.success, false);

    const allowed = AddressIdentityV1Schema.safeParse(
      identityV1({
        origin: {
          status: 'established',
          deployerAddress: BUNDLER,
          relation: 'direct',
          readAt: '2026-08-25T12:00:00.000Z',
        },
      }),
    );
    assert.equal(allowed.success, true);
  });

  test('an established origin has to be a direct-to-factory launch', () => {
    const parsed = AddressIdentityV1Schema.safeParse(
      identityV1({
        origin: {
          status: 'established',
          deployerAddress: BUNDLER,
          relation: 'intermediary',
          readAt: '2026-08-25T12:00:00.000Z',
        },
      }),
    );
    assert.equal(parsed.success, false);
  });

  test('an official contract can never also be a lookalike of one', () => {
    const parsed = AddressIdentityV1Schema.safeParse(
      identityV1({
        standing: 'official',
        official: {
          ticker: 'AAPLc',
          displayName: null,
          issuer: 'coinbase',
          listedIn: ['base_docs_technical'],
          sourceDiscrepancy: false,
          referenceFeedAddress: null,
        },
        lookalike: {
          officialAddress: AAPL,
          officialTicker: 'AAPLc',
          matchKind: 'symbol_exact',
          matchedAlias: 'published_ticker',
          matchedValue: 'AAPLc',
          firstFlaggedAt: '2026-08-25T12:00:00.000Z',
        },
      }),
    );
    assert.equal(parsed.success, false);
  });
});

describe('what changed since the previous comparable reading', () => {
  const runV1 = (input: {
    runId: string;
    completedAt: string;
    size: string;
    status: 'full' | 'unavailable';
    returned?: string;
  }) =>
    ({
      schemaVersion: 'official-cash-exit-run/v1',
      runId: input.runId,
      chainId: 8453,
      tokenAddress: AAPL,
      scope: 'public_ladder',
      tenantId: null,
      approvedSources: ['kyberswap'],
      destinations: ['USDC'],
      startedAt: input.completedAt,
      completedAt: input.completedAt,
      observations: [
        {
          runId: input.runId,
          scope: 'public_ladder',
          source: 'kyberswap',
          status: input.status,
          chainId: 8453,
          buyQuote: null,
          sizeKind: 'cash_equivalent',
          tenantId: null,
          errorCode: input.status === 'full' ? null : 'provider_no_route',
          expiresAt: '2026-08-25T12:00:20.000Z',
          sellQuote:
            input.status === 'full'
              ? {
                  routeKey: '0x' + '3'.repeat(64),
                  direction: 'sell',
                  expiresAt: '2026-08-25T12:00:20.000Z',
                  observedAt: '2026-08-25T12:00:00.000Z',
                  blockNumber: null,
                  inputAtomic: '1',
                  evidenceHash: '0x' + '4'.repeat(64),
                  inputAddress: AAPL,
                  outputAtomic: input.returned ?? '99902125',
                  candidateHash: '0x' + '3'.repeat(64),
                  outputAddress: USDC,
                  liquiditySources: [],
                }
              : null,
          observedAt: '2026-08-25T12:00:00.000Z',
          destination: 'USDC',
          tokenSymbol: 'AAPLc',
          tokenAddress: AAPL,
          schemaVersion: 'official-cash-exit-observation/v1',
          tokenDecimals: 8,
          executionProven: false,
          observationHash: '0x' + 'a'.repeat(64),
          evidenceStrength: 'router_quote',
          testedTokenAtomic: input.status === 'full' ? '1' : null,
          destinationAddress: USDC,
          destinationDecimals: 6,
          requestedCashAtomic: input.size,
          requestedTokenAtomic: null,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  test('one reading is a first reading, not a change of nothing', () => {
    const change = cashExitChangeV1({
      previous: null,
      next: runV1({ runId: '0x' + '1'.repeat(64), completedAt: '2026-08-25T11:00:00.000Z', size: '100000000', status: 'full' }),
    });
    assert.equal(change.status, 'first_reading');
    assert.deepEqual(change.rungs, []);
    assert.equal(change.previousMeasuredAt, null);
  });

  test('the same size in both readings is compared, and the move is stored signed', () => {
    const change = cashExitChangeV1({
      previous: runV1({
        runId: '0x' + '1'.repeat(64),
        completedAt: '2026-08-25T10:00:00.000Z',
        size: '100000000',
        status: 'full',
        returned: '99902125',
      }),
      next: runV1({
        runId: '0x' + '2'.repeat(64),
        completedAt: '2026-08-25T11:00:00.000Z',
        size: '100000000',
        status: 'full',
        returned: '97000000',
      }),
    });
    assert.equal(change.status, 'compared');
    assert.equal(change.rungs.length, 1);
    const rung = change.rungs[0]!;
    assert.equal(
      Number(rung.roundTripCostBps) - Number(rung.previousRoundTripCostBps),
      Number(rung.changeBps),
    );
  });

  test('a size present in only one reading is not a change', () => {
    const change = cashExitChangeV1({
      previous: runV1({ runId: '0x' + '1'.repeat(64), completedAt: '2026-08-25T10:00:00.000Z', size: '100000000', status: 'full' }),
      next: runV1({ runId: '0x' + '2'.repeat(64), completedAt: '2026-08-25T11:00:00.000Z', size: '1000000000', status: 'full' }),
    });
    // A different question, not a movement. Reporting it as one would put a
    // change on screen that nothing measured.
    assert.equal(change.status, 'not_comparable');
    assert.deepEqual(change.rungs, []);
  });

  test('a rung with a cost on only one side reports no move', () => {
    const change = cashExitChangeV1({
      previous: runV1({ runId: '0x' + '1'.repeat(64), completedAt: '2026-08-25T10:00:00.000Z', size: '100000000', status: 'unavailable' }),
      next: runV1({ runId: '0x' + '2'.repeat(64), completedAt: '2026-08-25T11:00:00.000Z', size: '100000000', status: 'full' }),
    });
    assert.equal(change.status, 'compared');
    // Subtracting a number from an absence is how a first measurement becomes
    // a dramatic move.
    assert.equal(change.rungs[0]!.changeBps, null);
    assert.equal(change.rungs[0]!.previousStatus, 'unavailable');
  });
});

describe('what the read settled, and what it did not', () => {
  test('an address nothing knows produces unknowns, never negative findings', () => {
    const { established, unknown } = addressAssertionsV1({
      identity: identityV1(),
      referenceValue: null,
      controls: CONTROLS_V1 as never,
      market: marketV1('not_measured') as never,
    });
    const claims = unknown.map((row) => row.claim);
    assert.ok(claims.includes('Whether an issuer publishes this exact address.'));
    assert.ok(claims.includes('What it costs to get out.'));
    // Every unknown is phrased as not-established. None of them asserts a
    // negative about the token.
    for (const row of unknown) {
      assert.ok(!/\bis not (a|an|the)\b/i.test(row.claim), `"${row.claim}" reads as a negative finding`);
    }
    assert.deepEqual(established, []);
  });

  test('a refused cash entry claims nothing about exiting a held position', () => {
    const { established, unknown } = addressAssertionsV1({
      identity: identityV1(),
      referenceValue: null,
      controls: CONTROLS_V1 as never,
      market: marketV1('no_entry_route_at_measured_sizes') as never,
    });
    assert.ok(
      established.some((row) => row.claim.includes('sell it to you for cash')),
      'the refused entry is stated',
    );
    assert.ok(
      unknown.some((row) => row.claim === 'Whether a position already held could be sold.'),
      'and the untested half is named as unknown',
    );
  });

  test('our own failed call is never an assertion about the market', () => {
    const { established, unknown } = addressAssertionsV1({
      identity: identityV1(),
      referenceValue: null,
      controls: CONTROLS_V1 as never,
      market: marketV1('measurement_failed') as never,
    });
    assert.deepEqual(established, []);
    assert.ok(
      unknown.some((row) => row.reason.includes('says nothing about the market')),
      'the failure is named as ours',
    );
  });

  test('who holds a control is always unknown, because B20 does not enumerate', () => {
    const { unknown } = addressAssertionsV1({
      identity: identityV1(),
      referenceValue: null,
      controls: CONTROLS_V1 as never,
      market: marketV1('not_measured') as never,
    });
    assert.ok(unknown.some((row) => row.claim === 'Who holds these controls.'));
  });

  test('a lookalike is stated as a resemblance and the addresses are the reason', () => {
    const { established } = addressAssertionsV1({
      identity: identityV1({
        lookalike: {
          officialAddress: AAPL,
          officialTicker: 'AAPLc',
          matchKind: 'symbol_exact',
          matchedAlias: 'published_ticker',
          matchedValue: 'AAPLc',
          firstFlaggedAt: '2026-08-25T12:00:00.000Z',
        },
      }),
      referenceValue: null,
      controls: CONTROLS_V1 as never,
      market: marketV1('not_measured') as never,
    });
    const row = established.find((entry) => entry.claim.includes('also answers to'))!;
    assert.match(row.evidence, /addresses differ/i);
    const text = JSON.stringify(established).toLowerCase();
    for (const word of ['scam', 'fraud', 'suspicious', 'impostor']) {
      assert.equal(text.includes(word), false, `an assertion must not say "${word}"`);
    }
  });

  test('a relayed launch is an unknown launcher, and no address is asserted', () => {
    const { established, unknown } = addressAssertionsV1({
      identity: identityV1({
        origin: {
          status: 'relayed',
          deployerAddress: null,
          relation: 'bundler',
          readAt: '2026-08-25T12:00:00.000Z',
        },
      }),
      referenceValue: null,
      controls: CONTROLS_V1 as never,
      market: marketV1('not_measured') as never,
    });
    const row = unknown.find((entry) => entry.claim === 'Who launched this contract.')!;
    assert.match(row.reason, /bundler acting for somebody else/);
    assert.equal(JSON.stringify(established).includes(BUNDLER), false);
    assert.equal(JSON.stringify(unknown).includes(BUNDLER), false);
  });

  test('nothing in the assertions calls a movement a trade', () => {
    // The evidence layer establishes venue TRANSFERS. Until a venue-specific
    // swap confirmer exists, no surface may promote one into a trade, a buy, a
    // sell or a person doing either.
    const { established, unknown } = addressAssertionsV1({
      identity: identityV1(),
      referenceValue: null,
      controls: CONTROLS_V1 as never,
      market: marketV1('cash_route_established') as never,
    });
    const text = JSON.stringify([...established, ...unknown]).toLowerCase();
    for (const word of ['trade', 'trader', 'buyer', 'seller', 'bought', 'sold']) {
      assert.equal(text.includes(word), false, `an assertion must not say "${word}"`);
    }
    void IMPOSTOR;
  });
});
