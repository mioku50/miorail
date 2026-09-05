import assert from 'node:assert/strict';
import test, { beforeEach, describe } from 'node:test';

import {
  MCP_MEASURE_PER_MINUTE_V1,
  McpPrivateError,
  measureRuntimeV1,
  miorailMeasureMarketRealityV1,
} from './tools.js';
import type { McpPrivateIdentityV1 } from './session.js';

// ---------------------------------------------------------------------------
// The measure tool is the only thing on either MCP surface that spends money's
// worth of provider calls on demand. Every test here is about what it refuses
// to do, or about a refusal saying whose problem it is.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
let tenantSeq = 0;
const identity = (): McpPrivateIdentityV1 => {
  tenantSeq += 1;
  // A fresh tenant per test: the budget is per wallet and module-level, so
  // sharing one would make these tests depend on their own order.
  return {
    tenantId: `eip155:8453:tenant-${tenantSeq}`,
    walletAddress: WALLET,
    chainId: 8453,
    tokenId: 'token-under-test',
    source: 'handoff_token',
  };
};

const QUESTION = {
  underlyingKey: 'security:isin:US67066G1040',
  sizeUsd: 100,
  direction: 'buy' as const,
  destination: 'USDC' as const,
  chain: 'base' as const,
};

// A complete v2 answer with nothing established: the honest shape a measurement
// returns when the routers had nothing to say at this exact size, which is also
// the shape whose wording most needs guarding.
const ANSWER = {
  schemaVersion: 'market-reality/v2' as const,
  question: {
    chainId: 8453,
    underlyingKey: QUESTION.underlyingKey,
    direction: 'buy' as const,
    requestedCashAtomic: '100000000',
    cashAsset: 'USDC' as const,
    cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    cashDecimals: 6,
    destination: 'USDC' as const,
    exactSizeOnly: true,
    baseOnly: true,
  },
  universe: {
    reviewedRepresentationCount: 3,
    positiveSupplyRepresentationCount: 2,
    zeroSupplyRepresentationCount: 1,
    unresolvedSupplyRepresentationCount: 0,
  },
  marketOutcomeCoverage: {
    policy: 'same_reviewed_router_policy_exact_size_direction_and_destination' as const,
    eligibleRepresentationCount: 2,
    establishedOutcomeCount: 0,
    status: 'incomplete' as const,
    reason: 'No positive-supply representation has a fresh exact-direction outcome.',
  },
  numericComparisonCoverage: {
    policy: 'fresh_numeric_quotes_same_exact_question_and_normalization' as const,
    eligibleRepresentationCount: 2,
    pricedRepresentationCount: 0,
    status: 'incomplete' as const,
    reason: 'No fresh normalized quote.',
  },
  ranking: {
    status: 'withheld' as const,
    policy: 'withheld_phase_10b8' as const,
    orderedTokenAddresses: [],
    reason: 'coverage_incomplete' as const,
  },
  quoteEvidenceIsExecutionProof: false,
  representations: [],
  assembledAt: '2026-09-05T12:00:00.000Z',
};

const MEASUREMENT = {
  measured: 0,
  reusedOpen: 0,
  reusedCooldown: 3,
  excludedZeroSupply: 0,
  unresolved: 0,
  joinedInFlight: 0,
};

const original = { measure: measureRuntimeV1.measure, timeoutMs: measureRuntimeV1.timeoutMs };
let calls = 0;

beforeEach(() => {
  calls = 0;
  measureRuntimeV1.timeoutMs = original.timeoutMs;
  measureRuntimeV1.measure = (async () => {
    calls += 1;
    return { ok: true as const, payload: { ...ANSWER, measurement: MEASUREMENT } };
  }) as never;
});

test.after(() => {
  Object.assign(measureRuntimeV1, original);
});

async function refusalOf(promise: Promise<unknown>): Promise<McpPrivateError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof McpPrivateError, 'the refusal is a typed private error');
    return error;
  }
  throw new Error('expected a refusal');
}

describe('a measurement costs something, so it is bounded', () => {
  test('the budget refuses before it spends, not after', async () => {
    const who = identity();
    for (let i = 0; i < MCP_MEASURE_PER_MINUTE_V1; i += 1) {
      await miorailMeasureMarketRealityV1(who, QUESTION);
    }
    assert.equal(calls, MCP_MEASURE_PER_MINUTE_V1);

    const refusal = await refusalOf(miorailMeasureMarketRealityV1(who, QUESTION));
    assert.equal(refusal.code, 'measure_rate_limited');
    // The point: the coordinator was never reached.
    assert.equal(calls, MCP_MEASURE_PER_MINUTE_V1, 'a refused call must spend nothing');
    // And the caller is pointed at the answer that already exists.
    assert.match(refusal.message, /compare_market_reality/);
  });

  test('the budget is per wallet, not global', async () => {
    const first = identity();
    for (let i = 0; i < MCP_MEASURE_PER_MINUTE_V1; i += 1) {
      await miorailMeasureMarketRealityV1(first, QUESTION);
    }
    await refusalOf(miorailMeasureMarketRealityV1(first, QUESTION));
    // A second wallet is not punished for the first one's loop.
    await assert.doesNotReject(() => miorailMeasureMarketRealityV1(identity(), QUESTION));
  });
});

describe('a timeout is not a failed measurement', () => {
  test('it says the run continues, and to read rather than press again', async () => {
    measureRuntimeV1.timeoutMs = () => 10;
    measureRuntimeV1.measure = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { ok: true as const, payload: { ...ANSWER, measurement: MEASUREMENT } };
    }) as never;

    const refusal = await refusalOf(miorailMeasureMarketRealityV1(identity(), QUESTION));
    assert.equal(refusal.code, 'measure_still_running');
    assert.match(refusal.message, /has not been abandoned/);
    assert.match(refusal.message, /Do not call this again/);
    assert.match(refusal.message, /compare_market_reality/);
    // It really did start the work; the caller is waiting on it, not on nothing.
    assert.equal(calls, 1);
  });
});

describe('a failure is Miorail’s, and says so', () => {
  test('a provider or storage failure never becomes a finding about the token', async () => {
    for (const code of [
      'market_reality_chain_unavailable',
      'market_reality_storage_unavailable',
      'market_reality_failed',
    ]) {
      measureRuntimeV1.measure = (async () => ({ ok: false as const, status: 503, code })) as never;
      const refusal = await refusalOf(miorailMeasureMarketRealityV1(identity(), QUESTION));
      assert.equal(refusal.code, code);
      assert.match(
        refusal.message,
        /Miorail|not a statement about any representation/,
        `${code} must name Miorail as the subject`,
      );
      assert.doesNotMatch(refusal.message, /illiquid|untradeable|no route|not available/i);
    }
  });

  test('an unknown code still refuses as Miorail’s gap rather than silently', async () => {
    measureRuntimeV1.measure = (async () => ({
      ok: false as const,
      status: 500,
      code: 'something_new',
    })) as never;
    const refusal = await refusalOf(miorailMeasureMarketRealityV1(identity(), QUESTION));
    assert.equal(refusal.code, 'something_new');
    assert.match(refusal.message, /never about the representation/);
  });
});

describe('what the caller is told about the work it caused', () => {
  test('the measurement envelope is passed through, not summarised away', async () => {
    const result = await miorailMeasureMarketRealityV1(identity(), QUESTION);
    // measured: 0 beside reusedCooldown: 3 is the sentence that stops a loop.
    assert.deepEqual(result.measurement, MEASUREMENT);
    assert.equal(result.quoteOnly, true);
    assert.equal(result.executionEvidenceIncluded, false);
    assert.equal(result.schemaVersion, 'miorail-agent-market-reality/v1');
  });

  test('the reading is the same one the public comparison ships', async () => {
    const result = await miorailMeasureMarketRealityV1(identity(), QUESTION);
    const summary = (result.miorailSummary as { summary?: string }).summary ?? '';
    assert.ok(summary.length > 0, 'a deterministic summary travels with the answer');
    // Nothing here may read as a market verdict.
    assert.doesNotMatch(summary, /illiquid|untradeable|safe|good deal/i);
  });

  test('the size is the question, and it reaches the coordinator unchanged', async () => {
    let seen: unknown = null;
    measureRuntimeV1.measure = (async (input: unknown) => {
      seen = input;
      return { ok: true as const, payload: { ...ANSWER, measurement: MEASUREMENT } };
    }) as never;
    const who = identity();
    await miorailMeasureMarketRealityV1(who, { ...QUESTION, sizeUsd: 10_000 });
    assert.deepEqual((seen as { question: unknown }).question, {
      underlyingKey: QUESTION.underlyingKey,
      direction: 'buy',
      // $10,000, exactly -- not a $100 question multiplied.
      requestedCashAtomic: '10000000000',
      destination: 'USDC',
    });
    // The wallet comes from the proved identity, never from an argument.
    assert.equal((seen as { walletAddress: string }).walletAddress, WALLET);
    assert.equal((seen as { tenantId: string }).tenantId, who.tenantId);
  });

  test('a wallet cannot be passed in', async () => {
    await assert.rejects(() =>
      miorailMeasureMarketRealityV1(identity(), {
        ...QUESTION,
        walletAddress: '0x2222222222222222222222222222222222222222',
      } as never),
    );
  });
});
