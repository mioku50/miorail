import {
  CASH_EXIT_DEFAULT_USDC_SIZES_ATOMIC_V1,
  type CashExitMeasurementRunV1,
  type CashExitQuoteLegV1,
  type CashExitSourceObservationV1,
} from '@mioagent/route-storage';

import {
  CashExitLadderV1Schema,
  type CashExitLadderRungV1,
  type CashExitLadderV1,
} from './contracts.js';

function evidenceV1(quote: CashExitQuoteLegV1, source: string) {
  return {
    kind: 'router_quote' as const,
    source,
    direction: quote.direction,
    routeKey: quote.routeKey,
    candidateHash: quote.candidateHash,
    evidenceHash: quote.evidenceHash,
    observedAt: quote.observedAt,
    expiresAt: quote.expiresAt,
    blockNumber: quote.blockNumber,
  };
}

function sourceProjectionV1(row: CashExitSourceObservationV1, nowMs: number) {
  const fresh = Date.parse(row.expiresAt) > nowMs;
  return {
    source: row.source,
    status: fresh ? row.status : ('not_measured' as const),
    errorCode: fresh ? row.errorCode : null,
    observedAt: fresh ? row.observedAt : null,
    expiresAt: fresh ? row.expiresAt : null,
    buyEvidenceHash: fresh ? (row.buyQuote?.evidenceHash ?? null) : null,
    sellEvidenceHash: fresh ? (row.sellQuote?.evidenceHash ?? null) : null,
  };
}

function bestFullV1(
  rows: readonly CashExitSourceObservationV1[],
): CashExitSourceObservationV1 | null {
  return (
    rows
      .filter((row) => row.status === 'full' && row.sellQuote !== null)
      .sort((left, right) => {
        const leftOutput = BigInt(left.sellQuote!.outputAtomic);
        const rightOutput = BigInt(right.sellQuote!.outputAtomic);
        return leftOutput < rightOutput
          ? 1
          : leftOutput > rightOutput
            ? -1
            : left.source.localeCompare(right.source);
      })[0] ?? null
  );
}

/**
 * What the run found at this rung, ignoring the quote window.
 *
 * The same rows the fresh projection reads, without the freshness filter. A
 * negative outcome -- the router does not list this token, no route at this
 * size -- is the only thing a rung ever had to say, and dropping it at expiry
 * turned "we asked and the answer was no" into "nobody has looked".
 */
function lastMeasuredV1(
  rows: readonly CashExitSourceObservationV1[],
  sample: CashExitSourceObservationV1,
): CashExitLadderRungV1['lastMeasured'] {
  const best = bestFullV1(rows);
  const status = best
    ? ('full' as const)
    : rows.some((row) => row.status === 'measurement_failed')
      ? ('measurement_failed' as const)
      : rows.some((row) => row.status === 'buy_only')
        ? ('buy_only' as const)
        : ('unavailable' as const);
  const returned = best?.sellQuote?.outputAtomic ?? null;
  return {
    status,
    // The first code any source gave. Sources agree in practice; when they do
    // not, the rung's own status already says the outcome was mixed.
    errorCode: rows.map((row) => row.errorCode).find((code) => code !== null) ?? null,
    observedAt:
      rows
        .map((row) => row.observedAt)
        .sort()
        .at(-1) ?? sample.observedAt,
    roundTripCostBps:
      best && sample.destination === 'USDC' && sample.requestedCashAtomic !== null && returned !== null
        ? (
            ((BigInt(sample.requestedCashAtomic) - BigInt(returned)) * 10_000n) /
            BigInt(sample.requestedCashAtomic)
          ).toString()
        : null,
    returnedAtomic: returned,
  };
}

function baseRungV1(rows: readonly CashExitSourceObservationV1[], now: Date): CashExitLadderRungV1 {
  const sample = rows[0]!;
  const nowMs = now.getTime();
  const fresh = rows.filter((row) => Date.parse(row.expiresAt) > nowMs);
  const sources = rows.map((row) => sourceProjectionV1(row, nowMs));
  const best = bestFullV1(fresh);
  const complete = fresh.length === rows.length;
  const status = best
    ? 'full'
    : !complete
      ? 'not_measured'
      : fresh.some((row) => row.status === 'measurement_failed')
        ? 'measurement_failed'
        : fresh.some((row) => row.status === 'buy_only')
          ? 'buy_only'
          : 'unavailable';
  const quotes = best
    ? [best.buyQuote, best.sellQuote].filter((quote): quote is CashExitQuoteLegV1 => quote !== null)
    : [];
  const returned = best?.sellQuote?.outputAtomic ?? null;
  const roundTripCostBps =
    best &&
    sample.destination === 'USDC' &&
    sample.requestedCashAtomic !== null &&
    returned !== null
      ? (
          ((BigInt(sample.requestedCashAtomic) - BigInt(returned)) * 10_000n) /
          BigInt(sample.requestedCashAtomic)
        ).toString()
      : null;
  return {
    sizeKind: sample.sizeKind,
    requestedCashAtomic: sample.requestedCashAtomic,
    requestedTokenAtomic: sample.requestedTokenAtomic,
    tokenDecimals: sample.tokenDecimals,
    destination: sample.destination,
    destinationAddress: sample.destinationAddress,
    destinationDecimals: sample.destination === 'USDC' ? 6 : 18,
    status,
    exactTestedTokenAtomic: best?.testedTokenAtomic ?? null,
    exactExecutableTokenAtomic: best?.testedTokenAtomic ?? null,
    returnedAtomic: returned,
    roundTripCostBps,
    lowerBoundRequestedCashAtomic: null,
    derivedFromExactRung: false,
    interpolated: false,
    evidenceStrength: 'router_quote',
    executionProven: false,
    approvedSources: rows.map((row) => row.source).sort(),
    sources,
    quoteEvidence: quotes.map((quote) => evidenceV1(quote, best!.source)),
    simulationEvidence: {
      status: 'not_simulated',
      kind: 'route_simulation',
      candidateHash: null,
      evidenceHash: null,
      observedAt: null,
      blockNumber: null,
    },
    lastMeasured: lastMeasuredV1(rows, sample),
    observedAt:
      best?.observedAt ??
      (complete
        ? (fresh
            .map((row) => row.observedAt)
            .sort()
            .at(-1) ?? null)
        : null),
    expiresAt:
      best?.expiresAt ?? (complete ? (fresh.map((row) => row.expiresAt).sort()[0] ?? null) : null),
  };
}

export function projectCashExitRunV1(
  run: CashExitMeasurementRunV1,
  now: Date,
): CashExitLadderRungV1[] {
  const groups = new Map<string, CashExitSourceObservationV1[]>();
  for (const row of run.observations) {
    const size = row.requestedCashAtomic ?? `position:${row.requestedTokenAtomic}`;
    const key = `${size}:${row.destination}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const rungs = [...groups.values()].map((rows) =>
    baseRungV1(
      rows.sort((a, b) => a.source.localeCompare(b.source)),
      now,
    ),
  );
  rungs.sort((left, right) => {
    if (left.sizeKind !== right.sizeKind) return left.sizeKind === 'cash_equivalent' ? -1 : 1;
    const leftSize = BigInt(left.requestedCashAtomic ?? left.requestedTokenAtomic ?? '0');
    const rightSize = BigInt(right.requestedCashAtomic ?? right.requestedTokenAtomic ?? '0');
    return leftSize < rightSize
      ? -1
      : leftSize > rightSize
        ? 1
        : left.destination.localeCompare(right.destination);
  });
  for (const rung of rungs) {
    if (rung.sizeKind !== 'cash_equivalent' || !['buy_only', 'unavailable'].includes(rung.status))
      continue;
    const smaller = rungs
      .filter(
        (candidate) =>
          candidate.sizeKind === 'cash_equivalent' &&
          candidate.destination === rung.destination &&
          candidate.status === 'full' &&
          BigInt(candidate.requestedCashAtomic!) < BigInt(rung.requestedCashAtomic!),
      )
      .sort((left, right) =>
        BigInt(left.requestedCashAtomic!) > BigInt(right.requestedCashAtomic!) ? -1 : 1,
      )[0];
    if (!smaller) continue;
    rung.status = 'partial';
    rung.exactExecutableTokenAtomic = smaller.exactExecutableTokenAtomic;
    rung.returnedAtomic = smaller.returnedAtomic;
    rung.roundTripCostBps = smaller.roundTripCostBps;
    rung.lowerBoundRequestedCashAtomic = smaller.requestedCashAtomic;
    rung.derivedFromExactRung = true;
    rung.quoteEvidence = smaller.quoteEvidence;
    rung.observedAt = smaller.observedAt;
    rung.expiresAt = smaller.expiresAt;
  }
  return rungs;
}

export function assembleCashExitLadderV1(input: {
  publicRun: CashExitMeasurementRunV1 | null;
  positionRun?: CashExitMeasurementRunV1 | null;
  now: Date;
}): CashExitLadderV1 {
  const publicRungs = input.publicRun ? projectCashExitRunV1(input.publicRun, input.now) : [];
  const positionRungs = input.positionRun ? projectCashExitRunV1(input.positionRun, input.now) : [];
  const rungs = [...publicRungs, ...positionRungs];
  return CashExitLadderV1Schema.parse({
    status: rungs.some((rung) => rung.status !== 'not_measured') ? 'measured' : 'not_measured',
    semantics: 'asset_level_approved_router_quotes',
    directPoolMeasurementsAreDiagnosticOnly: true,
    exactSizesOnly: true,
    defaultCashSizesAtomic: [...CASH_EXIT_DEFAULT_USDC_SIZES_ATOMIC_V1],
    approvedSources: input.publicRun?.approvedSources ?? input.positionRun?.approvedSources ?? [],
    publicRunId: input.publicRun?.runId ?? null,
    positionRunId: input.positionRun?.runId ?? null,
    rungs,
  });
}
