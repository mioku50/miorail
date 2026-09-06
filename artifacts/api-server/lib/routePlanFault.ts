// ---------------------------------------------------------------------------
// Whose failure was it — ours or the market's.
//
// A comparison that never got a route used to answer one code,
// `route_plan_evaluation_failed`, whatever went wrong. The console draws that
// as every adapter "failed / not reached" and "0 sources", which is the exact
// picture of a market that was asked and had nothing to offer.
//
// On 2026-09-06 that picture was drawn while the market was fine. Our own
// language model answered 429 — a rate limit with a ZERO allowance — so the
// goal was never read into an intent and no venue was ever called. Two readers
// took the screen to mean the pair could not be routed on Base.
//
// The rule this module exists to enforce: our failure is named as ours. It
// changes no behaviour on the market's side, and it never puts a provider's
// own message on the wire — the details below are constants, so no key, host
// or upstream body can travel with them.
// ---------------------------------------------------------------------------

/** Where a comparison stopped, in the terms the console draws stages in. */
export type RoutePlanFaultStageV1 = 'planner' | 'server';

export interface RoutePlanFaultV1 {
  code: string;
  status: number;
  /** Reader copy. A constant, never a provider message. */
  detail: string;
  stage: RoutePlanFaultStageV1;
}

/**
 * True when the failure came from the language model lane.
 *
 * Matched on `name` rather than `instanceof`: the error crosses a package
 * boundary and a duplicated class in a second copy of `@mioagent/llm` would
 * make `instanceof` quietly false — which is the failure mode this whole
 * module exists to remove, not one to reintroduce.
 */
export function isPlannerFaultV1(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'LlmHttpError' || name === 'LlmChainExhaustedError';
}

const PLANNER_DETAIL_V1 =
  "Miorail's own language model did not answer, so your goal was never read into an intent " +
  'and no venue was called. This is our failure, not the market’s: nothing here is a finding ' +
  'about this pair, this token or the routes available on Base. Nothing was signed or spent.';

const SERVER_DETAIL_V1 =
  'The route planner stopped before any venue answered. Nothing here is a finding about this ' +
  'pair, this token or the routes available on Base. Nothing was signed or spent.';

/**
 * The response for a comparison that threw.
 *
 * `503` for the planner because it is a dependency that is temporarily away —
 * a status that says "try again", which is exactly what a reader should do —
 * and `500` for everything else, which is unchanged.
 */
export function routePlanFaultV1(error: unknown, codes: { planner: string; server: string }): RoutePlanFaultV1 {
  return isPlannerFaultV1(error)
    ? { code: codes.planner, status: 503, detail: PLANNER_DETAIL_V1, stage: 'planner' }
    : { code: codes.server, status: 500, detail: SERVER_DETAIL_V1, stage: 'server' };
}
