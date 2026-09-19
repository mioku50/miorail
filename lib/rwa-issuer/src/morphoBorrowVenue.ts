// ---------------------------------------------------------------------------
// Asking the venue to write the transaction.
//
// Miorail does not author lending calldata. Morpho publishes an MCP server that
// prepares it, and the division of labour is the point: the venue knows its own
// bundler, and we do the part it does not do — compute, measure, and refuse.
//
// This client is deliberately NOT the LLM-facing Morpho tool provider. That one
// exposes four read tools and nothing that prepares a transaction, so no model
// can talk a preparation into existence. Here the arguments are written by the
// server from measured inputs, and `morpho_prepare_borrow` is the only tool
// this module can call.
//
// WHAT COMES BACK, MEASURED 2026-09-19
//
//   transactions[] { to, data, value, chainId, description }
//   requirements[]                         — what the venue says is still owed
//   outcome.market { healthFactor, isHealthy, maxBorrowable, … }
//   simulation.transfers[] { token{address,symbol}, from, to, amount }
//   simulation.postState.market { borrowBefore, borrowAfter, … }
//   warnings[] { level, message, code? }
//
// Everything here is the venue's CLAIM. The transactions are carried because
// they are what a wallet would sign; every number beside them is carried as
// something the venue said, never as something Miorail established.
//
// `maxBorrowable` is the clearest case. On the curated NVDAc market it read
// 1,778.99 USDC while the market held 823 — it is the health headroom alone,
// published under a name that invites reading it as what can be drawn. It
// travels only so a review can show the two side by side.
//
// THE VENUE RETURNS SIGNABLE TRANSACTIONS EVEN WHEN ITS OWN SIMULATION FAILED
//
// Measured the same day: asked for 1,200 USDC on that market, Morpho answered
// `SIMULATION_REVERTED — insufficient liquidity` AND returned two transactions.
// A client that reads `transactions` and not `warnings` hands a user a
// transaction that reverts. So an error-level warning is carried out as the
// venue refusing, and disagreement with our own measurement stops the flow
// rather than picking a winner.
// ---------------------------------------------------------------------------

import { partnerFetch } from '@mioagent/security/httpAllowlist';

import type { PreparedTransactionV1 } from './morphoBorrowPlan.js';

export const MORPHO_MCP_ENDPOINT_V1 = 'https://mcp.morpho.org/';
export const MORPHO_PREPARE_BORROW_TOOL_V1 = 'morpho_prepare_borrow';
/** Base mainnet. This module speaks to one chain and takes no argument for it. */
export const MORPHO_VENUE_CHAIN_V1 = 'base';

export const MORPHO_VENUE_REFUSALS_V1 = [
  /** The venue could not be reached, or did not answer in time. */
  'venue_unreachable',
  /** The venue answered and declined to prepare anything. */
  'venue_refused',
  /** The venue answered in a shape this build cannot read. */
  'venue_answer_unreadable',
  /** The venue answered, and prepared no transaction at all. */
  'venue_prepared_nothing',
  /** The venue prepared calls for a chain this surface does not execute on. */
  'venue_prepared_another_chain',
] as const;
export type MorphoVenueRefusalV1 = (typeof MORPHO_VENUE_REFUSALS_V1)[number];

/** One movement the venue says its batch performs. A claim, never evidence. */
export interface MorphoVenueClaimedTransferV1 {
  tokenAddress: string | null;
  tokenSymbol: string | null;
  to: string | null;
  /** Human-readable, exactly as the venue printed it. */
  amount: string | null;
}

export interface MorphoPreparedBorrowV1 {
  /** Exactly what the venue handed over, in its order. */
  transactions: readonly PreparedTransactionV1[];
  /**
   * The venue's own verdict, when it published one.
   *
   * `null` means the venue published NO simulation — never that it passed.
   */
  venueSimulation: { reverted: boolean; reason: string | null } | null;
  /** What the venue says will move. Compared against our measurement, never
   * substituted for it. */
  claimedTransfers: readonly MorphoVenueClaimedTransferV1[];
  /** Whatever the venue still says is owed. Carried verbatim for the review. */
  requirements: readonly string[];
  /**
   * The venue's published headroom, in loan-asset atomic units.
   *
   * This is the collateral constraint alone and ignores whether the market
   * holds the assets. Never shown as what a reader can borrow.
   */
  maxBorrowableAssets: bigint | null;
  /** The venue's own sentence for the whole operation. A label. */
  summary: string | null;
}

export type MorphoPrepareBorrowResultV1 =
  | { ok: true; prepared: MorphoPreparedBorrowV1 }
  | { ok: false; refusal: MorphoVenueRefusalV1; detail: string | null };

const BASE_CHAIN_ID_V1 = 8453;

/**
 * An atomic amount as the exact decimal string the venue's schema asks for.
 *
 * `borrowAmount` is documented as human-readable decimals, so the conversion
 * happens here rather than anywhere near a float. The round trip is not
 * trusted either: what actually arrives is measured, and a venue that read
 * this string as some other number fails the arrival check.
 */
export function atomicToDecimalStringV1(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError('decimals must be an integer between 0 and 36');
  }
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function textOrNullV1(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** An unsigned integer in the venue's JSON, which may arrive as a number or a
 * string. Anything else is absent rather than guessed at. */
function atomicOrNullV1(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

/** The venue streams its answer as SSE, and the last `data:` line is the
 * envelope. A plain JSON body is accepted too, so a transport change does not
 * read as the venue being unreachable. */
function parseEnvelopeV1(body: string): unknown {
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);
  return JSON.parse(dataLines.at(-1) ?? body.trim());
}

export interface MorphoVenueDepsV1 {
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  /** Injected so a test is not at the mercy of a random id. */
  requestId?: string;
}

/**
 * Asks the venue to prepare a borrow, and reads its answer for what it is.
 *
 * Nothing here is signed, nothing is broadcast, and no key is held. The result
 * is calldata plus a set of claims, and every one of those claims is checked
 * against a measurement before a reader is ever shown a transaction.
 */
export async function prepareMorphoBorrowV1(input: {
  marketId: string;
  walletAddress: string;
  /** Exact atomic units of the loan asset. */
  borrowAssets: bigint;
  loanDecimals: number;
  deps?: MorphoVenueDepsV1;
}): Promise<MorphoPrepareBorrowResultV1> {
  const deps = input.deps ?? {};
  const marketId = input.marketId.trim().toLowerCase();
  const wallet = input.walletAddress.trim();
  if (!/^0x[0-9a-f]{64}$/.test(marketId)) {
    return { ok: false, refusal: 'venue_answer_unreadable', detail: 'not an exact market id' };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return { ok: false, refusal: 'venue_answer_unreadable', detail: 'not an exact wallet address' };
  }
  if (input.borrowAssets <= 0n) {
    return { ok: false, refusal: 'venue_answer_unreadable', detail: 'nothing was asked for' };
  }

  let body: string;
  try {
    const response = await partnerFetch(
      deps.endpoint ?? MORPHO_MCP_ENDPOINT_V1,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: deps.requestId ?? `miorail-borrow-${marketId.slice(2, 14)}`,
          method: 'tools/call',
          params: {
            name: MORPHO_PREPARE_BORROW_TOOL_V1,
            arguments: {
              chain: MORPHO_VENUE_CHAIN_V1,
              marketId,
              userAddress: wallet,
              borrowAmount: atomicToDecimalStringV1(input.borrowAssets, input.loanDecimals),
            },
          },
        }),
      },
      { timeoutMs: deps.timeoutMs ?? 12_000, fetchImpl: deps.fetchImpl },
    );
    if (!response.ok) {
      // The status only: an upstream body can echo an endpoint.
      return { ok: false, refusal: 'venue_unreachable', detail: `the venue returned HTTP ${response.status}` };
    }
    body = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return {
      ok: false,
      refusal: 'venue_unreachable',
      detail: /abort|timeout/i.test(message) ? 'the venue did not answer in time' : 'the venue could not be reached',
    };
  }

  let envelope: Record<string, any>;
  try {
    envelope = parseEnvelopeV1(body) as Record<string, any>;
  } catch {
    return { ok: false, refusal: 'venue_answer_unreadable', detail: 'the answer was not JSON' };
  }
  if (envelope?.error) {
    return { ok: false, refusal: 'venue_refused', detail: textOrNullV1(envelope.error?.message) };
  }
  const result = envelope?.result as Record<string, any> | undefined;
  if (result?.isError === true) {
    return { ok: false, refusal: 'venue_refused', detail: null };
  }

  const text = Array.isArray(result?.content)
    ? result.content.find((item: any) => item?.type === 'text' && typeof item.text === 'string')?.text
    : null;
  let payload: Record<string, any>;
  try {
    payload = (typeof text === 'string' ? JSON.parse(text) : result) as Record<string, any>;
  } catch {
    return { ok: false, refusal: 'venue_answer_unreadable', detail: 'the payload was not JSON' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, refusal: 'venue_answer_unreadable', detail: 'the payload was not an object' };
  }

  const rawTransactions = Array.isArray(payload.transactions) ? payload.transactions : [];
  if (rawTransactions.length === 0) {
    return { ok: false, refusal: 'venue_prepared_nothing', detail: null };
  }
  const transactions: PreparedTransactionV1[] = [];
  for (const entry of rawTransactions) {
    const row = entry as Record<string, any>;
    // A call for another chain is not a call this surface may hand anybody,
    // whatever else is right about it.
    if (row.chainId !== undefined && row.chainId !== null && Number(row.chainId) !== BASE_CHAIN_ID_V1) {
      return {
        ok: false,
        refusal: 'venue_prepared_another_chain',
        detail: `the venue prepared a call for chain ${String(row.chainId)}`,
      };
    }
    transactions.push({
      to: String(row.to ?? ''),
      data: String(row.data ?? ''),
      value: row.value ?? null,
      description: textOrNullV1(row.description),
    });
  }

  // The venue simulated when it published a simulation. An absent block is not
  // a pass, and an empty warnings array on a run that DID happen is.
  const simulated = payload.simulation && typeof payload.simulation === 'object';
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  const errorWarning = warnings.find(
    (entry: any) => typeof entry?.level === 'string' && entry.level.toLowerCase() === 'error',
  );
  const venueSimulation = simulated
    ? {
        // Any error-level warning is read as the venue refusing this
        // preparation. Classifying its errors further would be us deciding
        // which of the venue's objections matter.
        reverted: errorWarning !== undefined,
        reason: errorWarning
          ? textOrNullV1(errorWarning.message) ?? textOrNullV1(errorWarning.code)
          : null,
      }
    : null;

  const claimedTransfers: MorphoVenueClaimedTransferV1[] = (
    Array.isArray(payload.simulation?.transfers) ? payload.simulation.transfers : []
  ).map((entry: any) => ({
    tokenAddress: textOrNullV1(entry?.token?.address)?.toLowerCase() ?? null,
    tokenSymbol: textOrNullV1(entry?.token?.symbol),
    to: textOrNullV1(entry?.to)?.toLowerCase() ?? null,
    amount: textOrNullV1(entry?.amount?.value) ?? (typeof entry?.amount?.value === 'number' ? String(entry.amount.value) : null),
  }));

  const requirements = (Array.isArray(payload.requirements) ? payload.requirements : [])
    .map((entry: any) => textOrNullV1(typeof entry === 'string' ? entry : entry?.description ?? entry?.message))
    .filter((entry: string | null): entry is string => entry !== null);

  return {
    ok: true,
    prepared: {
      transactions,
      venueSimulation,
      claimedTransfers,
      requirements,
      maxBorrowableAssets: atomicOrNullV1(payload.outcome?.market?.maxBorrowable),
      summary: textOrNullV1(payload.summary),
    },
  };
}
