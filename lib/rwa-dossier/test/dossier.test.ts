import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { type B20ReaderV1, type B20RpcResultV1 } from '@mioagent/b20-control';
import { OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1 } from '@mioagent/market-tail';
import {
  CashExitMeasurementRunV1Schema,
  CashExitSourceObservationV1Schema,
  createMemoryMarketTailRepository,
  createMemoryOfficialCashExitRepository,
  createMemoryOfficialAssetRepository,
  hashCashExitObservationV1,
  hashCashExitRunV1,
} from '@mioagent/route-storage';
import { ZERO_HASH_V1 } from '@mioagent/route-domain';

import {
  assembleOfficialAssetDossierV1,
  compareReferenceAndExecutableV1,
  readB20MultiplierV1,
  readTokenizedStockReferenceV1,
  type ExecutableValueV1,
} from '../src/index.js';

const TOKEN = '0xb2000000000000000000007bf6d5cbb0e24cb301';
const OTHER_TOKEN = '0xb2000000000000000000007bf6d5cbb0e24cb302';
const FEED = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const OLD_SINGLETON = '0x3333333333333333333333333333333333333333';
const COUNTERPARTY = '0x4444444444444444444444444444444444444444';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as const;
const NOW = new Date('2026-08-25T12:00:00.000Z');

function word(value: bigint): string {
  const unsigned = value < 0n ? (1n << 256n) + value : value;
  return unsigned.toString(16).padStart(64, '0');
}

function roundData(input: {
  answer: bigint;
  updatedAt: bigint;
  roundId?: bigint;
  answeredInRound?: bigint;
}): string {
  const roundId = input.roundId ?? 7n;
  return `0x${word(roundId)}${word(input.answer)}${word(input.updatedAt - 60n)}${word(input.updatedAt)}${word(input.answeredInRound ?? roundId)}`;
}

function reader(
  input: { answer?: bigint; updatedAt?: bigint; answeredInRound?: bigint } = {},
): B20ReaderV1 {
  const ok = (value: string): B20RpcResultV1<string> => ({ ok: true, value, raw: value });
  const updatedAt = input.updatedAt ?? BigInt(NOW.getTime() / 1_000 - 3_600);
  return {
    async readBlockAnchor() {
      return {
        ok: true,
        value: { blockNumber: '5000', blockHash: BLOCK_HASH, blockTag: '0x1388' },
        raw: '',
      };
    },
    async readIsB20() {
      // The dossier must not turn a failed/negative control-plane read into a
      // statement about official identity, whose trust root is the reviewed
      // exact-address snapshot.
      return { ok: true, value: false, raw: `0x${word(0n)}` };
    },
    async readIsB20Initialized() {
      return { ok: true, value: true, raw: `0x${word(1n)}` };
    },
    async readVariantActivated() {
      return { ok: true, value: true, raw: `0x${word(1n)}` };
    },
    async call(call) {
      if (call.to === FEED && call.data === '0x313ce567') return ok(`0x${word(8n)}`);
      if (call.to === FEED && call.data === '0xfeaf968c') {
        return ok(
          roundData({
            answer: input.answer ?? 12_345_000_000n,
            updatedAt,
            answeredInRound: input.answeredInRound,
          }),
        );
      }
      return { ok: false, reason: 'reverted', revertSelector: null };
    },
  };
}

async function corpus() {
  const official = createMemoryOfficialAssetRepository();
  await official.recordSnapshot({
    snapshot: {
      sourceKind: 'base_docs_technical',
      sourceUrl: 'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base',
      observedAt: '2026-08-25T10:00:00.000Z',
      status: 'ok',
      documentHash: 'a'.repeat(64),
      corpusHash: 'b'.repeat(64),
      detail: null,
    },
    assets: [
      {
        chainId: 8453,
        tokenAddress: TOKEN,
        sourceKind: 'base_docs_technical',
        ticker: 'ACMEon',
        displayName: 'ACME Tokenized Stock',
        issuer: 'Coinbase',
        referenceFeedAddress: FEED,
      },
    ],
  });
  return official;
}

async function tail() {
  const marketTail = createMemoryMarketTailRepository();
  await marketTail.recordPass({
    tailKey: OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1,
    chainId: 8453,
    toBlock: 100,
    observedAt: '2026-08-24T08:00:00.000Z',
    logCalls: 1,
    identityCalls: 1,
    venues: [
      {
        chainId: 8453,
        address: OLD_SINGLETON,
        kind: 'singleton',
        token0: null,
        token1: null,
        firstSeenAt: '2026-08-24T08:00:00.000Z',
        identifiedAt: '2026-08-24T08:00:00.000Z',
      },
    ],
    events: [
      {
        chainId: 8453,
        tokenAddress: TOKEN,
        venueAddress: OLD_SINGLETON,
        direction: 'into_venue',
        counterparty: COUNTERPARTY,
        amountAtomic: '1',
        blockNumber: 100,
        transactionHash: `0x${'01'.repeat(32)}`,
        logIndex: 0,
        observedAt: '2026-08-24T08:00:00.000Z',
      },
    ],
  });
  await marketTail.recordPass({
    tailKey: OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1,
    chainId: 8453,
    toBlock: 5_000,
    observedAt: NOW.toISOString(),
    logCalls: 2,
    identityCalls: 1,
    venues: [
      {
        chainId: 8453,
        address: POOL,
        kind: 'paired_pool',
        token0: TOKEN,
        token1: USDC,
        firstSeenAt: '2026-08-25T11:00:00.000Z',
        identifiedAt: '2026-08-25T11:00:00.000Z',
      },
    ],
    events: [
      {
        chainId: 8453,
        tokenAddress: TOKEN,
        venueAddress: POOL,
        direction: 'out_of_venue',
        counterparty: COUNTERPARTY,
        amountAtomic: '2500000000000000000',
        blockNumber: 4_999,
        transactionHash: `0x${'02'.repeat(32)}`,
        logIndex: 3,
        observedAt: '2026-08-25T11:59:58.000Z',
      },
    ],
  });
  return marketTail;
}

/** A tail that has read blocks and identified no venue at all. */
async function tailWithNoIdentifiedVenue() {
  const marketTail = createMemoryMarketTailRepository();
  await marketTail.recordPass({
    tailKey: OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1,
    chainId: 8453,
    toBlock: 5_000,
    observedAt: NOW.toISOString(),
    logCalls: 1,
    identityCalls: 0,
    venues: [
      {
        chainId: 8453,
        address: POOL,
        kind: 'candidate',
        token0: null,
        token1: null,
        firstSeenAt: NOW.toISOString(),
        identifiedAt: null,
      },
    ],
    events: [],
  });
  return marketTail;
}

async function cashExit() {
  const repository = createMemoryOfficialCashExitRepository();
  const startedAt = '2026-08-25T11:59:50.000Z';
  const expiresAt = '2026-08-25T12:00:30.000Z';
  const runId = hashCashExitRunV1({
    schemaVersion: 'official-cash-exit-run/v1',
    chainId: 8453,
    tokenAddress: TOKEN,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: ['kyberswap'],
    destinations: ['USDC'],
    startedAt,
    completedAt: NOW.toISOString(),
    observations: [] as never,
  });
  const leg = (
    direction: 'buy' | 'sell',
    inputAddress: string,
    outputAddress: string,
    inputAtomic: string,
    outputAtomic: string,
  ) => ({
    direction,
    inputAddress,
    outputAddress,
    inputAtomic,
    outputAtomic,
    routeKey: `route-${direction}`,
    candidateHash: `0x${direction === 'buy' ? '11' : '22'.repeat(1)}`.padEnd(
      66,
      direction === 'buy' ? '1' : '2',
    ),
    evidenceHash: `0x${direction === 'buy' ? '33' : '44'.repeat(1)}`.padEnd(
      66,
      direction === 'buy' ? '3' : '4',
    ),
    observedAt: NOW.toISOString(),
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
    tokenSymbol: 'ACMEon',
    tokenDecimals: 8,
    scope: 'public_ladder' as const,
    tenantId: null,
    sizeKind: 'cash_equivalent' as const,
    requestedCashAtomic: '100000000',
    requestedTokenAtomic: null,
    testedTokenAtomic: '50000000',
    destination: 'USDC' as const,
    destinationAddress: USDC,
    destinationDecimals: 6,
    source: 'kyberswap',
    status: 'full' as const,
    evidenceStrength: 'router_quote' as const,
    executionProven: false as const,
    buyQuote: leg('buy', USDC, TOKEN, '100000000', '50000000'),
    sellQuote: leg('sell', TOKEN, USDC, '50000000', '99000000'),
    errorCode: null,
    observedAt: NOW.toISOString(),
    expiresAt,
  };
  const observation = CashExitSourceObservationV1Schema.parse({
    ...draft,
    observationHash: hashCashExitObservationV1(draft),
  });
  const run = CashExitMeasurementRunV1Schema.parse({
    schemaVersion: 'official-cash-exit-run/v1',
    runId,
    chainId: 8453,
    tokenAddress: TOKEN,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: ['kyberswap'],
    destinations: ['USDC'],
    startedAt,
    completedAt: NOW.toISOString(),
    observations: [observation],
  });
  await repository.recordCompletedRun(run);
  return repository;
}

describe('official asset dossier assembly', () => {
  test('a tail with no identified venue is unavailable, not a quiet market', async () => {
    // A movement is stored only once its counterparty is known to be a venue,
    // so with nothing identified the tail can read ten thousand transfers and
    // store none. Measured on the first production pass: 10,824 transfers, 97
    // candidates, none identified. `no_movements_observed` there is a finding
    // about the asset authored entirely by our own backlog — and the Discover
    // overview and this dossier have to agree, because they describe one fact.
    const result = await assembleOfficialAssetDossierV1(
      {
        official: await corpus(),
        marketTail: await tailWithNoIdentifiedVenue(),
        reader: reader(),
        now: () => NOW,
      },
      { chainId: 8453, tokenAddress: TOKEN },
    );
    assert.equal(result.outcome, 'dossier');
    if (result.outcome !== 'dossier') return;
    assert.equal(result.dossier.recentMarketActivity.status, 'unavailable');
    assert.equal(result.dossier.recentMarketActivity.confirmedSwapCount, null);
  });

  test('assembles exact-address evidence deterministically without inventing trades or an underlying', async () => {
    const deps = {
      official: await corpus(),
      marketTail: await tail(),
      reader: reader(),
      now: () => NOW,
    };
    const first = await assembleOfficialAssetDossierV1(deps, {
      chainId: 8453,
      tokenAddress: TOKEN.toUpperCase(),
    });
    const second = await assembleOfficialAssetDossierV1(deps, {
      chainId: 8453,
      tokenAddress: TOKEN,
    });

    assert.equal(first.outcome, 'dossier');
    assert.equal(second.outcome, 'dossier');
    if (first.outcome !== 'dossier' || second.outcome !== 'dossier') return;
    assert.equal(first.dossier.dossierHash, second.dossier.dossierHash);
    assert.equal(first.dossier.assembly, 'deterministic_no_llm_facts');
    assert.equal(first.dossier.identity.tokenAddress, TOKEN);
    assert.equal(first.dossier.identity.underlying.status, 'not_established');
    assert.equal(
      first.dossier.identity.underlying.symbol,
      null,
      'a ticker suffix is never stripped into a fact',
    );

    assert.equal(first.dossier.referenceValue.status, 'fresh');
    assert.equal(first.dossier.referenceValue.totalReturnValue, true);
    assert.equal(first.dossier.referenceValue.multiplierAppliedByFeed, true);
    assert.equal(first.dossier.referenceValue.registryPause, 'unknown');
    assert.equal(first.dossier.comparison.status, 'withheld');
    // An unread registry pause no longer withholds anything; what is missing
    // here is the other half of the comparison.
    assert.equal(first.dossier.comparison.reason, 'executable_value_not_measured');

    assert.equal(first.dossier.marketTopology.directUsdcPoolCount, 1);
    assert.deepEqual(
      first.dossier.marketTopology.venues.map((venue) => venue.address),
      [POOL],
    );
    assert.equal(first.dossier.recentMarketActivity.windowFromBlock, 3_001);
    assert.equal(first.dossier.recentMarketActivity.movementCount, 1);
    assert.equal(first.dossier.recentMarketActivity.confirmedSwapCount, null);
    assert.equal(
      first.dossier.recentMarketActivity.semantics,
      'venue_transfers_not_confirmed_swaps',
    );
    assert.equal(
      first.dossier.recentMarketActivity.latest[0]?.counterpartyRole,
      'unattributed_counterparty',
    );
    assert.ok(!JSON.stringify(first.dossier).includes('"trader"'));
  });

  test('returns a typed absence for another valid address and opens no chain seam', async () => {
    const official = await corpus();
    let chainCalls = 0;
    const offline = reader();
    offline.readBlockAnchor = async () => {
      chainCalls += 1;
      throw new Error('not-in-corpus must stop before RPC');
    };
    const result = await assembleOfficialAssetDossierV1(
      { official, marketTail: await tail(), reader: offline, now: () => NOW },
      { chainId: 8453, tokenAddress: OTHER_TOKEN },
    );
    assert.equal(result.outcome, 'not_in_reviewed_corpus');
    assert.equal(chainCalls, 0);
  });

  test('populates executable value only from a fresh exact quote while keeping reference independent', async () => {
    const result = await assembleOfficialAssetDossierV1(
      {
        official: await corpus(),
        marketTail: await tail(),
        cashExit: await cashExit(),
        reader: reader(),
        now: () => NOW,
      },
      { chainId: 8453, tokenAddress: TOKEN },
    );
    assert.equal(result.outcome, 'dossier');
    if (result.outcome !== 'dossier') return;
    assert.equal(result.dossier.executableValue.status, 'full');
    assert.equal(result.dossier.executableValue.valueAtomic, '19800000000');
    assert.equal(result.dossier.executableValue.decimals, 8);
    assert.equal(result.dossier.executableValue.evidence?.kind, 'router_quote');
    assert.equal(result.dossier.cashExitLadder.rungs[0]?.executionProven, false);
    assert.equal(
      result.dossier.cashExitLadder.rungs[0]?.simulationEvidence.status,
      'not_simulated',
    );
    assert.equal(result.dossier.referenceValue.valueAtomic, '12345000000');
    // A feed publishing inside its heartbeat is a feed that was not paused when
    // it published, so both halves are present and the comparison stands.
    assert.equal(result.dossier.referenceValue.registryPause, 'unknown');
    assert.equal(result.dossier.comparison.status, 'comparable');
    assert.equal(result.dossier.comparison.reason, null);
  });

  test('retains the reviewed feed address when the Base anchor is unavailable', async () => {
    const offline = reader();
    let calls = 0;
    offline.readBlockAnchor = async () => ({ ok: false, reason: 'rpc_unavailable' });
    offline.call = async () => {
      calls += 1;
      throw new Error('no feed read is valid without a pinned block');
    };
    const result = await assembleOfficialAssetDossierV1(
      { official: await corpus(), marketTail: await tail(), reader: offline, now: () => NOW },
      { chainId: 8453, tokenAddress: TOKEN },
    );
    assert.equal(result.outcome, 'dossier');
    if (result.outcome !== 'dossier') return;
    assert.equal(result.dossier.referenceValue.status, 'unavailable');
    assert.equal(result.dossier.referenceValue.feedAddress, FEED);
    assert.equal(result.dossier.referenceValue.comparisonEligible, false);
    assert.equal(calls, 0);
  });
});

describe('tokenized stock reference boundary', () => {
  test('an unread pause flag reports unknown and still compares; a read pause withholds', async () => {
    // The registry publishes no callable ABI, so `registryPause` is null on
    // every production read. Requiring a positive `not_paused` withheld the
    // comparison on every card forever — a refusal about us wearing the feed's
    // name. Publication is the evidence: a paused registry stops the feed.
    const unknown = await readTokenizedStockReferenceV1(reader({ answer: 10_000_000_000n }), {
      feedAddress: FEED,
      anchor: { blockNumber: '5000', blockHash: BLOCK_HASH, blockTag: '0x1388' },
      now: NOW,
      registryPause: null,
    });
    assert.equal(unknown.registryPause, 'unknown', 'unknown is reported, never guessed');
    assert.equal(unknown.status, 'fresh');
    assert.equal(unknown.comparisonEligible, true);
    assert.equal(unknown.withheldReason, null);

    const paused = await readTokenizedStockReferenceV1(reader({ answer: 10_000_000_000n }), {
      feedAddress: FEED,
      anchor: { blockNumber: '5000', blockHash: BLOCK_HASH, blockTag: '0x1388' },
      now: NOW,
      registryPause: true,
    });
    assert.equal(paused.registryPause, 'paused');
    assert.equal(paused.status, 'paused');
    assert.equal(paused.comparisonEligible, false);
    assert.equal(paused.withheldReason, 'reference_paused');
  });

  test('carries the feed total-return value unchanged and compares only when pause state is known', async () => {
    const value = await readTokenizedStockReferenceV1(reader({ answer: 10_000_000_000n }), {
      feedAddress: FEED,
      anchor: { blockNumber: '5000', blockHash: BLOCK_HASH, blockTag: '0x1388' },
      now: NOW,
      registryPause: false,
    });
    assert.equal(value.valueAtomic, '10000000000');
    assert.equal(value.decimals, 8);
    assert.equal(value.totalReturnValue, true);
    assert.equal(value.multiplierAppliedByFeed, true);
    assert.equal(value.comparisonEligible, true);

    const executable: ExecutableValueV1 = {
      status: 'full',
      valueAtomic: '11000000000',
      decimals: 8,
      requestedSizeAtomic: '1000000000000000000',
      executableSizeAtomic: '1000000000000000000',
      destination: 'USDC',
      observedAt: NOW.toISOString(),
      evidence: null,
    };
    assert.deepEqual(compareReferenceAndExecutableV1(value, executable), {
      status: 'comparable',
      differenceBps: '1000',
      reason: null,
    });
  });

  test('withholds divergence for stale data even if an executable value is present', async () => {
    const stale = await readTokenizedStockReferenceV1(
      reader({ updatedAt: BigInt(NOW.getTime() / 1_000 - 27 * 60 * 60) }),
      {
        feedAddress: FEED,
        anchor: { blockNumber: '5000', blockHash: BLOCK_HASH, blockTag: '0x1388' },
        now: NOW,
        registryPause: false,
      },
    );
    assert.equal(stale.status, 'stale');
    assert.equal(stale.comparisonEligible, false);
    assert.deepEqual(
      compareReferenceAndExecutableV1(stale, {
        status: 'full',
        valueAtomic: '1',
        decimals: 8,
        requestedSizeAtomic: '1',
        executableSizeAtomic: '1',
        destination: 'USDC',
        observedAt: NOW.toISOString(),
        evidence: null,
      }),
      { status: 'withheld', differenceBps: null, reason: 'reference_stale' },
    );
  });

  test('rejects a round that was not answered in its declared round', async () => {
    const invalid = await readTokenizedStockReferenceV1(reader({ answeredInRound: 6n }), {
      feedAddress: FEED,
      anchor: { blockNumber: '5000', blockHash: BLOCK_HASH, blockTag: '0x1388' },
      now: NOW,
      registryPause: false,
    });
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.valueAtomic, null);
    assert.equal(invalid.withheldReason, 'reference_invalid');
  });
});

// ---------------------------------------------------------------------------
// Phase 9A — the multiplier is read, disclosed, and never applied twice.
//
// Measured on Base at block 50,473,631: all thirteen Coinbase representations
// return exactly 1e18, and `WAD_PRECISION()` returns 1e18 alongside. A value
// that is 1.0 everywhere today is exactly why this is read rather than assumed
// — the day a dividend moves it, a stored 1.0 becomes a lie.
// ---------------------------------------------------------------------------

describe('representation multiplier', () => {
  const ANCHOR = { blockNumber: '5000', blockHash: BLOCK_HASH, blockTag: '0x1388' } as const;
  const WAD = `0x${(10n ** 18n).toString(16).padStart(64, '0')}`;

  function multiplierReader(answers: Record<string, { ok: boolean; value?: string; reason?: string }>) {
    return {
      async call(input: { data: string }) {
        const answer = answers[input.data];
        if (!answer) return { ok: false as const, reason: 'reverted' as const };
        return answer.ok
          ? { ok: true as const, value: answer.value!, raw: answer.value! }
          : { ok: false as const, reason: answer.reason as never };
      },
      async readBlockAnchor() {
        return { ok: true as const, value: ANCHOR };
      },
    } as never;
  }

  test('reads the scale rather than assuming 1e18, and never applies it to the reference', async () => {
    const value = 1_057_380_318_816_778_075n;
    const read = await readB20MultiplierV1(
      multiplierReader({
        '0x1b3ed722': { ok: true, value: `0x${value.toString(16).padStart(64, '0')}` },
        '0x664808a8': { ok: true, value: WAD },
      }),
      { tokenAddress: TOKEN, anchor: ANCHOR, now: NOW },
    );
    assert.equal(read.status, 'read');
    assert.equal(read.rawValue, value.toString());
    assert.equal(read.scale, (10n ** 18n).toString());
    // Decimal string arithmetic: the last digits are the difference between a
    // share count that reconciles and one that does not.
    assert.equal(read.normalized, '1.057380318816778075');
    assert.equal(read.oneToOne, false);
    assert.equal(read.appliedToReference, false, 'the total-return feed already applied it');
    assert.equal(read.evidence?.method, 'multiplier(); WAD_PRECISION()');
  });

  test('one token is one share only when the two words are equal', async () => {
    const read = await readB20MultiplierV1(
      multiplierReader({ '0x1b3ed722': { ok: true, value: WAD }, '0x664808a8': { ok: true, value: WAD } }),
      { tokenAddress: TOKEN, anchor: ANCHOR, now: NOW },
    );
    assert.equal(read.oneToOne, true);
    assert.equal(read.normalized, '1.000000000000000000');
  });

  test('a contract that does not implement it is absent; an endpoint that would not answer is ours', async () => {
    const absent = await readB20MultiplierV1(
      multiplierReader({ '0x1b3ed722': { ok: false, reason: 'reverted' }, '0x664808a8': { ok: true, value: WAD } }),
      { tokenAddress: TOKEN, anchor: ANCHOR, now: NOW },
    );
    assert.equal(absent.status, 'absent');
    assert.equal(absent.unavailableReason, 'not_implemented');
    assert.equal(absent.oneToOne, null, 'an unread multiplier never claims one-to-one');

    const ours = await readB20MultiplierV1(
      multiplierReader({ '0x1b3ed722': { ok: false, reason: 'rate_limited' }, '0x664808a8': { ok: true, value: WAD } }),
      { tokenAddress: TOKEN, anchor: ANCHOR, now: NOW },
    );
    assert.equal(ours.status, 'unavailable');
    assert.equal(ours.unavailableReason, 'chain_read_failed');
  });

  test('a scale that is not a power of ten has no decimal rendering this build will invent', async () => {
    const read = await readB20MultiplierV1(
      multiplierReader({
        '0x1b3ed722': { ok: true, value: WAD },
        '0x664808a8': { ok: true, value: `0x${(3n).toString(16).padStart(64, '0')}` },
      }),
      { tokenAddress: TOKEN, anchor: ANCHOR, now: NOW },
    );
    assert.equal(read.status, 'invalid');
    assert.equal(read.unavailableReason, 'answer_unusable');
  });
});
