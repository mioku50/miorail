// ---------------------------------------------------------------------------
// Reading through Alchemy while it is affordable, and through the public
// endpoint when it is not.
//
// WHY THIS EXISTS AT ALL, MEASURED
//
// The public Base endpoint caps a JSON-RPC batch at TEN calls (`-32014`) and
// throttles under sustained reads: the same hundred-contract sweep read 8 of 100
// there and 100 of 100 through Alchemy in one pass. That is not a preference,
// it is the difference between a surface that answers and one that renders
// `unread` and `not_confirmed` — honest-looking absences produced by our own
// transport, on a page about permission.
//
// WHY IT IS A BUDGET AND NOT A SWITCH
//
// Alchemy meters COMPUTE UNITS, not calls, and the plan is 300M a month. The
// budget already in this repository counts calls, which is the wrong unit by a
// factor that varies per method: an `eth_call` is 26 CU and an `eth_getLogs` is
// 75. A call budget either overspends or throttles us for nothing.
//
// WHAT THIS MODULE IS NOT
//
// It is not a rate limiter and it does not retry. It answers one question —
// which endpoint should this batch go to — from a spend figure somebody else
// persists, and it reports what a batch cost so that figure can be kept. A
// process that forgets its spend on restart is not within budget, it is
// unaware, and the two must not look the same.
// ---------------------------------------------------------------------------

/**
 * Alchemy's published compute-unit costs, for the methods Miorail issues.
 *
 * Anything not listed falls back to `RPC_CU_DEFAULT_V1`, which is deliberately
 * the most expensive of the common reads rather than the cheapest: an unpriced
 * method must never be able to under-report a month's spend.
 */
export const RPC_CU_COST_V1: Readonly<Record<string, number>> = {
  eth_blockNumber: 10,
  eth_chainId: 0,
  eth_call: 26,
  eth_getBalance: 19,
  eth_getCode: 19,
  eth_getStorageAt: 17,
  eth_getTransactionReceipt: 15,
  eth_getTransactionByHash: 17,
  eth_getBlockByNumber: 16,
  eth_getLogs: 75,
  eth_estimateGas: 87,
  eth_simulateV1: 300,
  eth_gasPrice: 19,
  eth_feeHistory: 15,
};

export const RPC_CU_DEFAULT_V1 = 75;

export function cuForMethodV1(method: string): number {
  return RPC_CU_COST_V1[method] ?? RPC_CU_DEFAULT_V1;
}

/** A batch costs the sum of its calls. Batching saves round trips, not CU. */
export function cuForBatchV1(methods: readonly string[]): number {
  let total = 0;
  for (const method of methods) total += cuForMethodV1(method);
  return total;
}

/** 300,000,000 a month, the plan this deployment is on. */
export const RPC_MONTHLY_CU_BUDGET_V1 = 300_000_000;

/**
 * How much of the month's budget stays unspent no matter what.
 *
 * A read surface that exhausts the plan on the 28th leaves everything that runs
 * on the 29th with no metered endpoint at all. Ten per cent is held back so the
 * fallback is a decision rather than a cliff.
 */
export const RPC_RESERVE_FRACTION_V1 = 0.1;

export type RpcEndpointChoiceV1 =
  | { provider: 'alchemy'; reason: 'within_budget' }
  | { provider: 'fallback'; reason: 'no_alchemy_endpoint' | 'budget_exhausted' | 'batch_exceeds_remaining' };

export interface RpcBudgetStateV1 {
  /** Compute units already spent this calendar month, from durable storage. */
  spentCu: number;
  /** Null when nothing is configured; a URL is never logged from here. */
  alchemyConfigured: boolean;
  budgetCu?: number;
  reserveFraction?: number;
}

/**
 * Which endpoint this batch goes to.
 *
 * The batch's own cost is part of the decision: a sweep that would cross the
 * reserve is sent to the fallback whole rather than half-served and half-
 * refused, because a partial answer is the shape this repository keeps
 * mistaking for a finding.
 */
export function chooseRpcEndpointV1(
  state: RpcBudgetStateV1,
  batchMethods: readonly string[],
): RpcEndpointChoiceV1 {
  if (!state.alchemyConfigured) return { provider: 'fallback', reason: 'no_alchemy_endpoint' };
  const budget = state.budgetCu ?? RPC_MONTHLY_CU_BUDGET_V1;
  const reserve = budget * (state.reserveFraction ?? RPC_RESERVE_FRACTION_V1);
  const spendable = budget - reserve;
  if (state.spentCu >= spendable) return { provider: 'fallback', reason: 'budget_exhausted' };
  const cost = cuForBatchV1(batchMethods);
  if (state.spentCu + cost > spendable) {
    return { provider: 'fallback', reason: 'batch_exceeds_remaining' };
  }
  return { provider: 'alchemy', reason: 'within_budget' };
}

export interface RpcBudgetReportV1 {
  month: string;
  spentCu: number;
  budgetCu: number;
  spendableCu: number;
  remainingCu: number;
  usedFraction: number;
  /** What the remaining budget buys, in the read this surface issues most. */
  remainingEthCalls: number;
  exhausted: boolean;
}

/** `2026-09`. The window a monthly plan actually resets on. */
export function rpcBudgetMonthV1(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function rpcBudgetReportV1(input: {
  now: Date;
  spentCu: number;
  budgetCu?: number;
  reserveFraction?: number;
}): RpcBudgetReportV1 {
  const budgetCu = input.budgetCu ?? RPC_MONTHLY_CU_BUDGET_V1;
  const spendableCu = budgetCu * (1 - (input.reserveFraction ?? RPC_RESERVE_FRACTION_V1));
  const spentCu = Math.max(0, input.spentCu);
  const remainingCu = Math.max(0, spendableCu - spentCu);
  return {
    month: rpcBudgetMonthV1(input.now),
    spentCu,
    budgetCu,
    spendableCu,
    remainingCu,
    usedFraction: budgetCu === 0 ? 1 : spentCu / budgetCu,
    remainingEthCalls: Math.floor(remainingCu / cuForMethodV1('eth_call')),
    exhausted: remainingCu <= 0,
  };
}
