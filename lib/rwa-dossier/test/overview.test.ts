import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { CashExitMeasurementRunV1 } from '@mioagent/route-storage';

import {
  executableFromRunV1,
  previewLadderFromRunV1,
  routeStatusFromPreviewV1,
} from '../src/overview.js';

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ETH = '0x4200000000000000000000000000000000000006';

function observationV1(input: {
  size: string;
  status: 'full' | 'unavailable' | 'measurement_failed' | 'buy_only';
  returned?: string;
  destination?: 'USDC' | 'ETH';
  source?: string;
  errorCode?: string;
}) {
  const destination = input.destination ?? 'USDC';
  const full = input.status === 'full';
  return {
    runId: '0x' + '9'.repeat(64),
    scope: 'public_ladder' as const,
    source: input.source ?? 'kyberswap',
    status: input.status,
    chainId: 8453 as const,
    buyQuote: full
      ? {
          routeKey: '0x' + '1'.repeat(64),
          direction: 'buy' as const,
          expiresAt: '2026-08-20T10:00:20.000Z',
          observedAt: '2026-08-20T10:00:00.000Z',
          blockNumber: null,
          inputAtomic: input.size,
          evidenceHash: '0x' + '2'.repeat(64),
          inputAddress: USDC,
          outputAtomic: '32220799',
          candidateHash: '0x' + '1'.repeat(64),
          outputAddress: AAPL,
          liquiditySources: ['aerodrome'],
        }
      : null,
    sizeKind: 'cash_equivalent' as const,
    tenantId: null,
    errorCode: full ? null : (input.errorCode ?? 'provider_no_route'),
    expiresAt: '2026-08-20T10:00:20.000Z',
    sellQuote: full
      ? {
          routeKey: '0x' + '3'.repeat(64),
          direction: 'sell' as const,
          expiresAt: '2026-08-20T10:00:20.000Z',
          observedAt: '2026-08-20T10:00:00.000Z',
          blockNumber: null,
          inputAtomic: '32220799',
          evidenceHash: '0x' + '4'.repeat(64),
          inputAddress: AAPL,
          outputAtomic: input.returned ?? '99902125',
          candidateHash: '0x' + '3'.repeat(64),
          outputAddress: destination === 'USDC' ? USDC : ETH,
          liquiditySources: ['aerodrome'],
        }
      : null,
    observedAt: '2026-08-20T10:00:00.000Z',
    destination,
    tokenSymbol: 'AAPLc',
    tokenAddress: AAPL,
    schemaVersion: 'official-cash-exit-observation/v1' as const,
    tokenDecimals: 8,
    executionProven: false as const,
    observationHash: '0x' + 'a'.repeat(64),
    evidenceStrength: 'router_quote' as const,
    testedTokenAtomic: full ? '32220799' : null,
    destinationAddress: destination === 'USDC' ? USDC : ETH,
    destinationDecimals: destination === 'USDC' ? (6 as const) : (18 as const),
    requestedCashAtomic: input.size,
    requestedTokenAtomic: null,
  };
}

function runV1(observations: ReturnType<typeof observationV1>[]): CashExitMeasurementRunV1 {
  return {
    schemaVersion: 'official-cash-exit-run/v1',
    runId: '0x' + '9'.repeat(64),
    chainId: 8453,
    tokenAddress: AAPL,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: ['kyberswap'],
    destinations: ['USDC'],
    startedAt: '2026-08-20T10:00:00.000Z',
    completedAt: '2026-08-20T10:00:01.000Z',
    observations,
  } as unknown as CashExitMeasurementRunV1;
}

// ---------------------------------------------------------------------------
// The list projection, and the one thing it must not inherit from the
// executable one: a quote's twenty-second expiry.
// ---------------------------------------------------------------------------

describe('the executable value a Discover card carries', () => {
  test('the cash a rung handed back and the price it implies are separate fields', () => {
    // $100 in, 0.32220799 AAPLc tested, $99.902125 back. The card shows the
    // cash; the reference feed is per share, so the comparison may only read
    // the price. Handing it the cash total is what renders as 31,015%.
    const run = runV1([observationV1({ size: '100000000', status: 'full' })]);
    const executable = executableFromRunV1(run, previewLadderFromRunV1(run));

    assert.equal(executable.status, 'full');
    assert.equal(executable.valueAtomic, '99902125');
    assert.equal(executable.decimals, 6);
    assert.equal(executable.perTokenValueAtomic, '31005477238');
    assert.equal(executable.perTokenDecimals, 8);
  });

  test('no tested amount means no price, and the pair stays absent together', () => {
    const run = runV1([observationV1({ size: '100000000', status: 'unavailable' })]);
    const executable = executableFromRunV1(run, previewLadderFromRunV1(run));

    assert.equal(executable.status, 'unavailable');
    assert.equal(executable.perTokenValueAtomic, null);
    assert.equal(executable.perTokenDecimals, null);
  });
});

describe('the Discover ladder preview', () => {
  test('a run whose quotes lapsed days ago is still a measurement', () => {
    // Read through the freshness-gated projection this run is `not_measured`,
    // which is correct for "can I execute right now" and false for "what did a
    // round trip cost". Thirteen assets reading "not measured" on a list is
    // exactly the sentence this tab exists to distinguish from "no route".
    const preview = previewLadderFromRunV1(runV1([observationV1({ size: '100000000', status: 'full' })]));
    assert.deepEqual(preview, [
      {
        requestedCashAtomic: '100000000',
        destination: 'USDC',
        status: 'full',
        roundTripCostBps: '9',
        derivedFromExactRung: false,
        lowerBoundRequestedCashAtomic: null,
        entryRouteRefused: false,
      },
    ]);
    assert.equal(routeStatusFromPreviewV1(preview), 'cash_route_established');
  });

  test('nothing measured is not the same word as nothing found', () => {
    assert.equal(routeStatusFromPreviewV1(previewLadderFromRunV1(null)), 'not_measured');
    assert.equal(
      routeStatusFromPreviewV1(
        previewLadderFromRunV1(runV1([observationV1({ size: '100000000', status: 'unavailable' })])),
      ),
      'no_route_at_measured_sizes',
    );
  });

  test('our own failed call never reads as an asset with no market', () => {
    assert.equal(
      routeStatusFromPreviewV1(
        previewLadderFromRunV1(
          runV1([observationV1({ size: '100000000', status: 'measurement_failed' })]),
        ),
      ),
      'measurement_failed',
    );
  });

  test('a refused buy leg is the router answering, and it gets its own word', () => {
    // The measurement stops at `measurement_failed` on purpose: the ladder is
    // sized in cash, so with no buy route the sell was never attempted and
    // nothing may be claimed about exiting a held position. But the router DID
    // answer, and that answer is a fact about the market.
    const preview = previewLadderFromRunV1(
      runV1([
        observationV1({
          size: '100000000',
          status: 'measurement_failed',
          errorCode: 'cash_size_anchor_no_route',
        }),
      ]),
    );
    assert.equal(preview[0]!.entryRouteRefused, true);
    assert.equal(routeStatusFromPreviewV1(preview), 'no_entry_route_at_measured_sizes');
  });

  test('one asset with a refused entry and one with a real outage is an outage', () => {
    // Mixed, so the pass cannot claim a market finding it does not have for
    // every size it asked about.
    const preview = previewLadderFromRunV1(
      runV1([
        observationV1({
          size: '100000000',
          status: 'measurement_failed',
          errorCode: 'cash_size_anchor_no_route',
        }),
        observationV1({
          size: '1000000000',
          status: 'measurement_failed',
          errorCode: 'provider_timeout',
        }),
      ]),
    );
    assert.equal(routeStatusFromPreviewV1(preview), 'measurement_failed');
  });

  test('sizes are ordered smallest first and never interpolated between', () => {
    const preview = previewLadderFromRunV1(
      runV1([
        observationV1({ size: '100000000000', status: 'unavailable' }),
        observationV1({ size: '100000000', status: 'full' }),
        observationV1({ size: '1000000000', status: 'full', returned: '990000000' }),
      ]),
    );
    assert.deepEqual(
      preview.map((rung) => [rung.requestedCashAtomic, rung.status, rung.roundTripCostBps]),
      [
        ['100000000', 'full', '9'],
        ['1000000000', 'full', '100'],
        // Not carried down from the smaller rung. A list showing $1,000's cost
        // under a $100,000 heading is a measurement of something else.
        ['100000000000', 'unavailable', null],
      ],
    );
    assert.equal(preview.every((rung) => rung.derivedFromExactRung === false), true);
  });

  test('the ETH leg is not shown beside the cash one, so two costs cannot be read as one', () => {
    const preview = previewLadderFromRunV1(
      runV1([
        observationV1({ size: '100000000', status: 'full' }),
        observationV1({ size: '100000000', status: 'full', destination: 'ETH' }),
      ]),
    );
    assert.equal(preview.length, 1);
    assert.equal(preview[0]!.destination, 'USDC');
  });

  test('the best source at a size wins, and a completed round trip beats a refusal', () => {
    const preview = previewLadderFromRunV1(
      runV1([
        observationV1({ size: '100000000', status: 'unavailable', source: 'aardvark' }),
        observationV1({ size: '100000000', status: 'full', source: 'kyberswap' }),
      ]),
    );
    assert.equal(preview[0]!.status, 'full');
    assert.equal(preview[0]!.roundTripCostBps, '9');
  });
});
