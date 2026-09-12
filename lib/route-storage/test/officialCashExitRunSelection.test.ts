import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { createMemoryOfficialCashExitRepository } from '../src/officialCashExitMemory.js';
import {
  CashExitSourceObservationV1Schema,
  CashExitMeasurementRunV1Schema,
  hashCashExitObservationV1,
  hashCashExitRunV1,
} from '../src/officialCashExit.js';
import { ZERO_HASH_V1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// "The newest run" and "the newest run that answers this question" are two
// different reads, and they were one.
//
// The public ladder measures four fixed sizes. A size asked for on demand
// writes its own run, and the next scheduled pass then becomes the newest run
// WITHOUT containing that size — so an established route policy becomes
// `route_policy_not_established` minutes after it was measured, while the rows
// sit in the database untouched.
//
// Measured on production 2026-09-04 on NVDAc: $0.10 runs completed at 20:06 and
// 20:08, the four-size ladder pass completed at 20:17, and
// `miorail_prepare_stock_action` refused from that moment on.
//
// The memory repository must apply the same preference as Postgres. A fake that
// answers what the database will not is how three shipped bugs got past the
// tests.
// ---------------------------------------------------------------------------

const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function runV1(size: string | readonly string[], completedAt: string) {
  const sizes = typeof size === 'string' ? [size] : [...size];
  // An expiry must follow its observation, so the schema is given a real
  // twenty-second window rather than the same instant twice.
  const expiresAt = new Date(Date.parse(completedAt) + 20_000).toISOString();
  const runId = hashCashExitRunV1({
    schemaVersion: 'official-cash-exit-run/v1',
    chainId: 8453,
    tokenAddress: TOKEN,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: ['kyberswap'],
    destinations: ['USDC'],
    startedAt: completedAt,
    completedAt,
    observations: [] as never,
  });
  const quote = (direction: 'buy' | 'sell', inputAtomic: string, outputAtomic: string) => ({
    direction,
    inputAddress: direction === 'buy' ? USDC : TOKEN,
    outputAddress: direction === 'buy' ? TOKEN : USDC,
    inputAtomic,
    outputAtomic,
    routeKey: `route-${direction}`,
    candidateHash: `0x${'1'.repeat(64)}`,
    evidenceHash: `0x${'3'.repeat(64)}`,
    observedAt: completedAt,
    expiresAt,
    blockNumber: '5000',
    liquiditySources: ['aerodrome-cl'],
  });
  const draft = {
    schemaVersion: 'official-cash-exit-observation/v1' as const,
    observationHash: ZERO_HASH_V1,
    runId,
    chainId: 8453 as const,
    tokenAddress: TOKEN,
    tokenSymbol: 'NVDAc',
    tokenDecimals: 8,
    scope: 'public_ladder' as const,
    tenantId: null,
    sizeKind: 'cash_equivalent' as const,
    requestedCashAtomic: sizes[0]!,
    requestedTokenAtomic: null,
    testedTokenAtomic: '40000000',
    destination: 'USDC' as const,
    destinationAddress: USDC,
    destinationDecimals: 6,
    source: 'kyberswap',
    status: 'full' as const,
    evidenceStrength: 'router_quote' as const,
    executionProven: false as const,
    buyQuote: quote('buy', sizes[0]!, '40000000'),
    sellQuote: quote('sell', '40000000', sizes[0]!),
    errorCode: null,
    observedAt: completedAt,
    expiresAt,
  };
  return CashExitMeasurementRunV1Schema.parse({
    schemaVersion: 'official-cash-exit-run/v1',
    runId,
    chainId: 8453,
    tokenAddress: TOKEN,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: ['kyberswap'],
    destinations: ['USDC'],
    startedAt: completedAt,
    completedAt,
    // One observation per rung, each with its own size in its own quotes: a
    // buy leg that spends a different size than the rung asks for is not the
    // rung's evidence, and the schema says so.
    observations: sizes.map((rung) => {
      const row = {
        ...draft,
        requestedCashAtomic: rung,
        buyQuote: quote('buy', rung, '40000000'),
        sellQuote: quote('sell', '40000000', rung),
      };
      return CashExitSourceObservationV1Schema.parse({
        ...row,
        observationHash: hashCashExitObservationV1(row),
      });
    }),
  });
}

describe('the run that answers the question, not merely the newest one', () => {
  const onDemand = runV1('100000', '2026-09-04T17:08:00.000Z');
  const ladderPass = runV1('100000000', '2026-09-04T17:17:00.000Z');

  async function repositoryV1() {
    const repository = createMemoryOfficialCashExitRepository();
    await repository.recordCompletedRun(onDemand);
    await repository.recordCompletedRun(ladderPass);
    return repository;
  }

  const ask = async (containingRequestedCashAtomic: string | null) =>
    (
      await (await repositoryV1()).latestCompletedRun({
        chainId: 8453,
        tokenAddress: TOKEN,
        scope: 'public_ladder',
        containingRequestedCashAtomic,
      })
    )?.runId;

  test('a size only an older run measured comes back from that run', async () => {
    assert.equal(await ask('100000'), onDemand.runId);
  });

  test('a ladder size still comes from the newest pass', async () => {
    // Nothing regressed for the four sizes the schedule always covers.
    assert.equal(await ask('100000000'), ladderPass.runId);
  });

  test('a size nobody ever measured falls back rather than reaching further back', async () => {
    // The caller must refuse exactly as it did before, on the newest run, not
    // be handed some ancient run that happens to hold a different size.
    assert.equal(await ask('777'), ladderPass.runId);
  });

  test('with no size asked for, the read is the old one to the letter', async () => {
    assert.equal(await ask(null), ladderPass.runId);
    assert.equal(await ask(undefined as never), ladderPass.runId);
  });
});

// ---------------------------------------------------------------------------
// And the mirror of it, found on 2026-09-12.
//
// The same scope carries both kinds of run, so the preference above solved one
// direction and left the other open: an on-demand measurement of ONE size is
// newer than the hourly four-size pass, so "the newest run" was a single rung
// and the whole cost curve — measured all day, sitting in the database —
// could not be read. Two page views were enough to hide it.
// ---------------------------------------------------------------------------
describe('the run that measured the whole ladder, not merely the newest one', () => {
  const LADDER = ['100000000', '1000000000', '10000000000', '100000000000'] as const;
  const ladderPass = runV1(LADDER, '2026-09-12T10:13:39.000Z');
  const oneSizeA = runV1('1000000000', '2026-09-12T10:45:26.000Z');
  const oneSizeB = runV1('1000000000', '2026-09-12T11:08:13.000Z');

  async function repositoryV1() {
    const repository = createMemoryOfficialCashExitRepository();
    for (const run of [ladderPass, oneSizeA, oneSizeB]) await repository.recordCompletedRun(run);
    return repository;
  }

  const ask = async (input: {
    containingRequestedCashAtomic?: string | null;
    containingAllRequestedCashAtomic?: readonly string[] | null;
  }) =>
    (
      await (await repositoryV1()).latestCompletedRun({
        chainId: 8453,
        tokenAddress: TOKEN,
        scope: 'public_ladder',
        ...input,
      })
    )?.runId;

  test('asking for the whole set reaches the pass that measured it', async () => {
    assert.equal(await ask({ containingAllRequestedCashAtomic: LADDER }), ladderPass.runId);
  });

  test('asking for nothing still returns the newest run', async () => {
    // The preference changes no existing caller.
    assert.equal(await ask({}), oneSizeB.runId);
    assert.equal(await ask({ containingAllRequestedCashAtomic: null }), oneSizeB.runId);
  });

  test('a run that answers both questions outranks a newer one that answers half', async () => {
    // Postgres sorts by the exact-size CASE, then the set one, then time. The
    // ladder pass holds this size AND the whole set, so it wins over the newer
    // single-rung runs that hold only the size.
    assert.equal(
      await ask({
        containingRequestedCashAtomic: '1000000000',
        containingAllRequestedCashAtomic: LADDER,
      }),
      ladderPass.runId,
    );
  });

  test('a size outside the ladder still beats the ladder, as it did before', async () => {
    // The 2026-09-04 fix, unchanged: an on-demand size nobody else measured is
    // reached even when the caller would also like the whole set.
    const repository = await repositoryV1();
    const odd = runV1('100000', '2026-09-12T09:00:00.000Z');
    await repository.recordCompletedRun(odd);
    const chosen = await repository.latestCompletedRun({
      chainId: 8453,
      tokenAddress: TOKEN,
      scope: 'public_ladder',
      containingRequestedCashAtomic: '100000',
      containingAllRequestedCashAtomic: LADDER,
    });
    assert.equal(chosen?.runId, odd.runId);
  });

  test('a set nobody has ever covered falls back to the newest run', async () => {
    assert.equal(
      await ask({ containingAllRequestedCashAtomic: ['777', '888'] }),
      oneSizeB.runId,
    );
  });
});
