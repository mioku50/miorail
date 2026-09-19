import { logger } from '@mioagent/utils';
import { hashApprovedCallsV1, stableHashV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import {
  morphoAfterBorrowV1,
  morphoBorrowPlanV1,
  morphoBorrowSimulationFromBatchV1,
  morphoBorrowVerdictV1,
  morphoLiquidationIncentiveWadV1,
  prepareMorphoBorrowV1,
  readMorphoBorrowStandingV1,
  type MorphoBorrowPlanV1,
  type MorphoBorrowReaderDepsV1,
  type MorphoBorrowStandingV1,
  type MorphoVenueDepsV1,
  borrowReviewV1,
  type BorrowReviewRefusalV1,
  type BorrowReviewV1,
} from '@mioagent/rwa-issuer';
import { buildSimulationChainV1, runSimulationChainV1, type SimulationChainV1 } from './swapSimulation.js';

// ---------------------------------------------------------------------------
// The whole borrow, from a measured market to a reviewed batch — or to the one
// sentence that says why there is nothing to approve.
//
// Nothing below signs anything, holds a key, or broadcasts. The output of a
// successful run is calldata the VENUE wrote, plus the evidence that it was
// executed once against real state and did what the review says.
//
// THE GATE IS STRUCTURAL, NOT A CONVENTION
//
// Calls exist on the `ready` branch and on no other. A caller cannot read them
// out of a refusal, because a refusal has no field to read them from. Every
// earlier version of this shape in this codebase — a 200 carrying a union
// whose unhappy branch a client quietly ignored — is exactly how a refusal
// became a transaction ([[client-drops-the-refusal-branch]]).
//
// EVERY REFUSAL KEEPS TWO NAMES
//
// `refusal` is the precise code an agent can branch on; `review.refusal` is
// the sentence a person reads. They are produced together so a screen and an
// API can never tell a different story about the same run.
// ---------------------------------------------------------------------------

/** Where the run stopped. A reader does not need this; a diagnosis does. */
export type MorphoBorrowStageV1 =
  | 'reading'
  | 'market'
  | 'capacity'
  | 'venue'
  | 'plan'
  | 'simulation';

export interface MorphoBorrowRunRequestV1 {
  /** The tokenized stock being used as collateral, by exact address. */
  collateralTokenAddress: string;
  walletAddress: string;
  /** Exact atomic units of the loan asset. */
  borrowAssets: bigint;
  /** Which market. Optional only when the collateral has exactly one. */
  marketId?: string | null;
}

export interface MorphoBorrowMeasuredV1 {
  blockNumber: number;
  /** What the simulation measured reaching this wallet, in loan atomic units. */
  arrivedAssets: string;
  /** Which reviewed provider executed the batch. */
  providerId: string;
}

export type MorphoBorrowRunV1 =
  | {
      state: 'ready';
      marketId: string;
      review: BorrowReviewV1;
      /** EXACTLY the calls that were simulated, in the order they were simulated. */
      calls: readonly ExecutionCallV1[];
      /** The hash of those calls, so what is signed can be checked against what
       * was measured rather than trusted to have stayed the same. */
      callsHash: string;
      plan: MorphoBorrowPlanV1;
      measured: MorphoBorrowMeasuredV1;
    }
  | {
      state: 'refused';
      stage: MorphoBorrowStageV1;
      /** The precise code. Never softened for display. */
      refusal: string;
      detail: string | null;
      marketId: string | null;
      /** The review a reader should see, when enough was read to render one. */
      review: BorrowReviewV1 | null;
    };

export interface MorphoBorrowRunDepsV1 {
  reader?: MorphoBorrowReaderDepsV1;
  venue?: MorphoVenueDepsV1;
  /** Injected wholesale in tests; production builds the reviewed chain. */
  chain?: SimulationChainV1;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Simulation transport codes that mean nothing was executed, as opposed to
 * something being executed and failing. Both refuse; they refuse differently. */
function reviewRefusalForTransportV1(): BorrowReviewRefusalV1 {
  return 'simulation_not_run';
}

function refusedV1(
  stage: MorphoBorrowStageV1,
  refusal: string,
  detail: string | null,
  marketId: string | null,
  review: BorrowReviewV1 | null,
): MorphoBorrowRunV1 {
  return { state: 'refused', stage, refusal, detail, marketId, review };
}

/**
 * Reads the market and this wallet's position in it, asks the venue to prepare
 * the borrow, executes the prepared batch once against real state, and only
 * then renders something a person may approve.
 *
 * The order is not an implementation detail. Each step exists because the one
 * before it cannot answer the question the next one asks: the arithmetic
 * cannot know what the venue will write, the calldata cannot say what it does,
 * and the simulation cannot say whether the resulting position is one a reader
 * would accept.
 */
export async function runMorphoBorrowV1(
  request: MorphoBorrowRunRequestV1,
  deps: MorphoBorrowRunDepsV1 = {},
): Promise<MorphoBorrowRunV1> {
  const readAt = (deps.now?.() ?? new Date()).toISOString();
  const wallet = request.walletAddress.trim().toLowerCase();
  const ask = request.borrowAssets;
  if (ask <= 0n) {
    return refusedV1('capacity', 'nothing_asked_for', 'the amount to borrow was not positive', null, null);
  }

  // --- 1. The market, and this wallet's standing in it ----------------------
  const reading = await readMorphoBorrowStandingV1({
    tokenAddress: request.collateralTokenAddress,
    walletAddress: wallet,
    deps: deps.reader,
  });
  if (reading.state === 'refused') {
    return refusedV1('reading', reading.refusal, reading.detail, null, null);
  }

  const wanted = request.marketId?.trim().toLowerCase() ?? null;
  let standing: MorphoBorrowStandingV1 | undefined;
  if (wanted !== null) {
    standing = reading.markets.find((entry) => entry.market.marketId.toLowerCase() === wanted);
    if (!standing) {
      return refusedV1('market', 'no_such_market_here', 'the venue holds no such market for this collateral', null, null);
    }
  } else if (reading.markets.length === 1) {
    standing = reading.markets[0];
  } else {
    // Picking one is choosing a reader's terms for them. The ids are returned
    // so the choice can be made rather than guessed at.
    return refusedV1(
      'market',
      'market_not_named',
      reading.markets.map((entry) => entry.market.marketId).join(' '),
      null,
      null,
    );
  }

  const market = standing.market;
  const marketId = market.marketId;
  const loanAddress = market.loan.address;
  const loanDecimals = market.loan.decimals;

  const marketWire = {
    marketId,
    curated: market.curated,
    lltvBps: market.lltvBps,
    collateralSymbol: market.collateral.symbol,
    loanSymbol: market.loan.symbol,
    collateralDecimals: market.collateral.decimals,
    loanDecimals: market.loan.decimals,
    borrowApyWad: market.borrowApyWad,
    blockNumber: market.state.blockNumber,
  };
  const liquidityAssets =
    market.state.totalSupplyAssets > market.state.totalBorrowAssets
      ? market.state.totalSupplyAssets - market.state.totalBorrowAssets
      : 0n;

  const render = (
    before: MorphoBorrowStandingV1['position'] | null,
    after: { position: { collateral: bigint }; health: { healthFactorWad: bigint | null; borrowedAssets: bigint }; liquidationPrice: bigint | null } | null,
    refusal: BorrowReviewRefusalV1 | null,
  ): BorrowReviewV1 =>
    borrowReviewV1({
      market: marketWire,
      before:
        before === null || standing.health === null
          ? null
          : {
              collateral: before.collateral,
              borrowedAssets: standing.health.borrowedAssets,
              healthFactorWad: standing.health.healthFactorWad,
              liquidationPrice: standing.liquidationPrice,
            },
      after:
        after === null
          ? null
          : {
              collateral: after.position.collateral,
              borrowedAssets: after.health.borrowedAssets,
              healthFactorWad: after.health.healthFactorWad,
              liquidationPrice: after.liquidationPrice,
            },
      askAssets: ask,
      collateralPrice: market.state.collateralPrice,
      liquidationIncentiveWad: morphoLiquidationIncentiveWadV1(market.state.lltvWad),
      marketLiquidityAssets: liquidityAssets,
      readAt: reading.readAt,
      refusal,
    });

  // A position that was not read cannot support any claim about this borrow.
  if (standing.position === null || standing.capacity === null) {
    return refusedV1('reading', 'position_unread', null, marketId, render(null, null, 'position_unread'));
  }
  // Without the exact loan contract the arrival cannot be measured, and an
  // unmeasurable arrival is the one thing this flow may not proceed without.
  if (loanAddress === null || loanDecimals === null) {
    return refusedV1(
      'market',
      'loan_asset_unread',
      'the venue did not publish the loan asset exactly, so an arrival could not be measured',
      marketId,
      render(standing.position, null, 'simulation_effect_unread'),
    );
  }

  // --- 2. Does the ask fit, and which side is short ------------------------
  const capacity = standing.capacity;
  if (capacity.assets <= 0n) {
    return refusedV1('capacity', 'nothing_to_borrow', capacity.bound, marketId, render(standing.position, null, 'nothing_to_borrow'));
  }
  if (ask > capacity.assets) {
    const overCollateral = ask > capacity.collateralHeadroomAssets;
    const overLiquidity = ask > capacity.marketLiquidityAssets;
    const reviewRefusal: BorrowReviewRefusalV1 =
      overCollateral && overLiquidity
        ? 'over_both_collateral_and_market'
        : overLiquidity
          ? 'over_market_liquidity'
          : 'would_not_be_healthy';
    return refusedV1(
      'capacity',
      'over_capacity',
      `${capacity.assets.toString()} is available, ${ask.toString()} was asked for`,
      marketId,
      render(standing.position, null, reviewRefusal),
    );
  }

  const after = morphoAfterBorrowV1({ market: market.state, position: standing.position, assets: ask });
  if (after === null) {
    return refusedV1('capacity', 'would_not_be_healthy', null, marketId, render(standing.position, null, 'would_not_be_healthy'));
  }

  // --- 3. The venue writes the calldata ------------------------------------
  const prepared = await prepareMorphoBorrowV1({
    marketId,
    walletAddress: wallet,
    borrowAssets: ask,
    loanDecimals,
    deps: deps.venue,
  });
  if (!prepared.ok) {
    return refusedV1('venue', prepared.refusal, prepared.detail, marketId, render(standing.position, null, 'venue_would_not_prepare'));
  }

  // --- 4. What can be proven from the bytes, before anything is executed ---
  const plan = morphoBorrowPlanV1({
    prepared: prepared.prepared.transactions,
    walletAddress: wallet,
    venueSimulation: prepared.prepared.venueSimulation,
  });
  if (!plan.ok) {
    return refusedV1('plan', plan.refusal, plan.detail, marketId, render(standing.position, null, 'prepared_calls_refused'));
  }

  // --- 5. One execution against real state ---------------------------------
  const callsHash = hashApprovedCallsV1(plan.plan.calls);
  const chain = deps.chain ?? buildSimulationChainV1(deps.env ?? process.env);
  const answer = await runSimulationChainV1({
    chain,
    request: {
      chainId: 8453,
      walletAddress: wallet,
      blueprintHash: stableHashV1('morpho-borrow-request/v1', { marketId, wallet, ask: ask.toString() }),
      callsHash,
      calls: plan.plan.calls,
    },
    nowIso: readAt,
    label: 'Borrow simulation',
    logContext: { marketId, callsHash },
  });
  if (!answer.ok) {
    // Nobody executed it. That is our gap, and it is never a pass.
    logger.warn('Borrow simulation produced no measurement', { marketId, errorCode: answer.errorCode });
    return refusedV1(
      'simulation',
      answer.errorCode,
      null,
      marketId,
      render(standing.position, null, reviewRefusalForTransportV1()),
    );
  }

  const simulation = morphoBorrowSimulationFromBatchV1({
    batch: {
      status: answer.response.status,
      blockNumber: answer.response.blockNumber,
      failedCallIndex: answer.response.failedCallIndex ?? null,
      revertReason: answer.response.revertReason ?? null,
      assetChanges: answer.response.assetChanges ?? null,
    },
    loanTokenAddress: loanAddress,
  });

  // --- 6. The verdict, bound to the measurement ----------------------------
  const verdict = morphoBorrowVerdictV1({ plan: plan.plan, simulation, expectedAssets: ask });
  if (!verdict.ok) {
    const reviewRefusal: BorrowReviewRefusalV1 =
      verdict.refusal === 'not_simulated'
        ? 'simulation_not_run'
        : verdict.refusal === 'reverted'
          ? 'simulation_reverted'
          : verdict.refusal === 'venue_and_miorail_disagree'
            ? 'venue_and_miorail_disagree'
            : verdict.refusal === 'arrival_unread'
              ? 'simulation_effect_unread'
              : 'simulation_delivered_something_else';
    return refusedV1(
      'simulation',
      verdict.refusal,
      verdict.detail,
      marketId,
      render(standing.position, null, reviewRefusal),
    );
  }
  if (simulation.state !== 'executed' || !simulation.arrival.read) {
    // Unreachable through `morphoBorrowVerdictV1`, and asserted rather than
    // assumed: this is the branch that hands over calldata.
    return refusedV1('simulation', 'arrival_unread', null, marketId, render(standing.position, null, 'simulation_effect_unread'));
  }

  return {
    state: 'ready',
    marketId,
    review: render(standing.position, after, null),
    calls: plan.plan.calls,
    callsHash,
    plan: plan.plan,
    measured: {
      blockNumber: simulation.blockNumber,
      arrivedAssets: simulation.arrival.assets.toString(),
      providerId: answer.providerId,
    },
  };
}
