import {
  measureOfficialCashExitV1,
  projectCashExitRunV1,
  type CashExitLadderRungV1,
} from '@mioagent/rwa-cash-exit';
import type {
  CashExitMeasurementRunV1,
  OfficialCashExitRepositoryV1,
} from '@mioagent/route-storage';
import type { SwapRouteAdapter } from '@mioagent/swap-adapters';

// ---------------------------------------------------------------------------
// Phase 17.9 — the review measures what it is about to confirm.
//
// The defect this closes, stated plainly: the review page assembled the board
// at the CASH size the draft carried, and then took a TOKEN amount from the
// holder and minted a clearance for it. Nothing reconciled the two. A draft
// prepared at $0.09 rendered the market for $0.09, and one press of "Use
// available balance" confirmed a whole position — which might be $500 — against
// that picture. The signature further down the line was honestly priced, because
// the release step re-plans at the exact amount. The APPROVAL was not: the
// reader said yes to a photograph of a different, much smaller trade.
//
// So this module answers one question and only that question: what do the
// reviewed routers say about selling EXACTLY this many atoms of this token,
// right now.
//
// Three properties it exists to hold:
//
//   * The size is the holder's number. It is never derived from a price, never
//     rounded to a ladder rung, and never inferred from a cash figure. It is
//     measured as given or it is not measured at all.
//
//   * A measurement is not a permission. This returns evidence with its own
//     clock; whether anything may be confirmed is decided by the caller, and
//     what may be signed is decided again, later, by the route run.
//
//   * Miorail's own failure never wears the market's name. A router that could
//     not be reached is `measurement_failed` and says so; only an explicit
//     no-route from a router that answered is `unavailable`.
// ---------------------------------------------------------------------------

/** The reviewed cash side. A sell's terms are established against USDC only —
 * the same destination the whole reviewed question is about. */
const TERMS_DESTINATION_V1 = 'USDC' as const;

export type StockSellTermsV1 =
  /** Routers answered for this exact amount. `rung` carries what they said. */
  | { status: 'established'; rung: CashExitLadderRungV1 }
  /**
   * Routers answered, and none of them will sell this amount. A market fact
   * about this size — and never about the token, the direction or the holder.
   */
  | { status: 'no_route'; rung: CashExitLadderRungV1 }
  /**
   * OURS. The measurement did not complete, so nothing is known about this
   * size. Never rendered as a market verdict.
   */
  | { status: 'not_established'; code: string };

/**
 * Find the terms for one exact token amount inside a completed run.
 *
 * Pure, so the rule can be tested without a router: the rung must be the
 * position-shaped one, for this exact amount, to USDC. A run that measured a
 * different amount answers a different question and is not accepted as an
 * answer to this one.
 */
export function stockSellTermsFromRunV1(input: {
  run: CashExitMeasurementRunV1 | null;
  tokenAmountAtomic: string;
  now: Date;
}): StockSellTermsV1 {
  if (!input.run) return { status: 'not_established', code: 'stock_sell_terms_not_measured' };
  const rung = projectCashExitRunV1(input.run, input.now).find(
    (row) =>
      row.sizeKind === 'actual_position' &&
      row.requestedTokenAtomic === input.tokenAmountAtomic &&
      row.destination === TERMS_DESTINATION_V1,
  );
  if (!rung) return { status: 'not_established', code: 'stock_sell_terms_not_measured' };
  // `partial` is a cash-ladder inference — a smaller rung standing in for a
  // bigger one — and it is never produced for a position rung. Listing it here
  // would suggest this surface can answer a size it did not measure.
  if (rung.status === 'full') return { status: 'established', rung };
  if (rung.status === 'unavailable' || rung.status === 'buy_only') {
    return { status: 'no_route', rung };
  }
  return { status: 'not_established', code: 'stock_sell_terms_measurement_failed' };
}

/**
 * Whether a set of established terms is still open.
 *
 * Separate from the status because they are separate facts: routers answered,
 * and their answer has a life. An expired quote is not a failed measurement and
 * must never be re-labelled as one — but it is also not something to confirm
 * against, so the caller measures again.
 */
export function stockSellTermsOpenV1(terms: StockSellTermsV1, now: Date): boolean {
  if (terms.status !== 'established') return false;
  const expiresAt = terms.rung.expiresAt;
  return expiresAt !== null && Date.parse(expiresAt) > now.getTime();
}

/**
 * Establish the terms for selling exactly this many token atoms.
 *
 * Reuses an open measurement when one exists for this exact amount, and spends
 * router calls otherwise. The reuse is an optimisation with a hard edge: it
 * accepts only a run that measured THIS amount and whose quotes are still open,
 * so it can never answer with evidence for a size nobody asked about.
 */
export async function establishStockSellTermsV1(input: {
  repository: OfficialCashExitRepositoryV1;
  adapters: readonly SwapRouteAdapter[];
  token: { address: `0x${string}`; symbol: string; decimals: number };
  tokenAmountAtomic: string;
  walletAddress: `0x${string}`;
  tenantId: string;
  now: () => Date;
  /** Typed against the measurer's own parameter, so a capture adapter this
   * function could not actually pass along fails here rather than at runtime. */
  captureMarketRealitySnapshots?: Parameters<
    typeof measureOfficialCashExitV1
  >[0]['captureMarketRealitySnapshots'];
  /** Skip the reuse read. The confirm step does not pass this; a caller that
   * has just measured does. */
  forceMeasure?: boolean;
}): Promise<StockSellTermsV1> {
  if (!/^[1-9][0-9]*$/.test(input.tokenAmountAtomic)) {
    return { status: 'not_established', code: 'stock_action_sell_requires_exact_size' };
  }

  if (!input.forceMeasure) {
    const existing = await input.repository
      .latestCompletedRun({
        chainId: 8453,
        tokenAddress: input.token.address,
        scope: 'tenant_position',
        tenantId: input.tenantId,
      })
      .catch(() => null);
    const reused = stockSellTermsFromRunV1({
      run: existing,
      tokenAmountAtomic: input.tokenAmountAtomic,
      now: input.now(),
    });
    if (stockSellTermsOpenV1(reused, input.now())) return reused;
  }

  let run: CashExitMeasurementRunV1;
  try {
    run = await measureOfficialCashExitV1({
      repository: input.repository,
      adapters: input.adapters,
      token: input.token,
      walletAddress: input.walletAddress,
      tenantId: input.tenantId,
      scope: 'tenant_position',
      positionTokenAtomic: input.tokenAmountAtomic,
      // The reviewed question is cash-denominated in USDC. Measuring the ETH
      // leg here would spend a router call on a destination this review cannot
      // carry anyway.
      destinations: [TERMS_DESTINATION_V1],
      now: input.now,
      captureMarketRealitySnapshots: input.captureMarketRealitySnapshots,
    });
  } catch {
    // Ours. The reader is told the size could not be measured, which is a
    // statement about Miorail and about nothing else.
    return { status: 'not_established', code: 'stock_sell_terms_measurement_failed' };
  }
  return stockSellTermsFromRunV1({
    run,
    tokenAmountAtomic: input.tokenAmountAtomic,
    now: input.now(),
  });
}

/**
 * The wire shape the review surfaces read.
 *
 * Deliberately narrow. The rung carries evidence hashes and a simulation block
 * that belong to the ladder projection; a review needs the size, what it
 * fetches, who answered, and the two clocks — and a field a screen does not
 * need is a field that can be rendered wrongly.
 */
export function stockSellTermsWireV1(terms: StockSellTermsV1): Record<string, unknown> {
  if (terms.status === 'not_established') {
    return { status: 'not_established', code: terms.code, sizeMeasured: false };
  }
  const rung = terms.rung;
  return {
    status: terms.status,
    sizeMeasured: true,
    /** The holder's own number, echoed back so it can be checked rather than
     * trusted. */
    tokenAmountAtomic: rung.requestedTokenAtomic,
    tokenDecimals: rung.tokenDecimals,
    destination: rung.destination,
    destinationDecimals: rung.destinationDecimals,
    /** What the routers said this exact amount fetches. A price, with a life —
     * never a size, and never carried anywhere as one. */
    returnedAtomic: rung.returnedAtomic,
    sources: rung.sources.map((source) => ({
      source: source.source,
      status: source.status,
      errorCode: source.errorCode,
    })),
    approvedSources: rung.approvedSources,
    observedAt: rung.observedAt,
    expiresAt: rung.expiresAt,
    /** Literals, so a reader of the payload can check them. Measuring terms
     * builds nothing and authorises nothing. */
    createsApproval: false,
    createsCalldata: false,
    createsTransaction: false,
  };
}
