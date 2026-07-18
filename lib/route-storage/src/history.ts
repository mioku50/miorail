import { RouteStorageIntegrityError } from './types.js';

// T58: opaque cursor for Route Run history pagination — base64url(JSON
// {createdAt, id}). Never a raw offset (so pages stay stable under
// concurrent inserts); the caller never needs to understand its shape.

export interface RouteHistoryCursorV1 {
  createdAt: string;
  id: string;
}

export function encodeRouteHistoryCursorV1(cursor: RouteHistoryCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Decodes and validates an opaque history cursor. Throws
 * RouteStorageIntegrityError (mapped by the API route to 400) on anything
 * malformed — never silently falls back to "no cursor". */
export function decodeRouteHistoryCursorV1(raw: string): RouteHistoryCursorV1 {
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new RouteStorageIntegrityError('Route Run history cursor is not valid base64url JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).createdAt !== 'string' ||
    typeof (parsed as Record<string, unknown>).id !== 'string' ||
    Number.isNaN(Date.parse((parsed as { createdAt: string }).createdAt))
  ) {
    throw new RouteStorageIntegrityError('Route Run history cursor has an invalid shape');
  }
  const { createdAt, id } = parsed as RouteHistoryCursorV1;
  return { createdAt, id };
}

export interface RouteRunHistoryItemV1 {
  routeRunId: string;
  createdAt: string;
  runStatus: string;
  intentHash: string;
  /** Best-effort human-readable summary derived from the stored intent
   * (goal + asset symbols + amount); falls back to the intentHash alone
   * when the intent doesn't carry enough to summarize. */
  intentSummary: string;
  blueprintId: string | null;
  blueprintStatus: string | null;
  proofId: string | null;
  proofFinalStatus: string | null;
  reconciliationState: string | null;
  provider: string | null;
}

export interface RouteRunHistoryPageV1 {
  items: RouteRunHistoryItemV1[];
  nextCursor: string | null;
}

export interface RouteRunHistoryParamsV1 {
  limit: number;
  cursor?: string | null;
}

/** Best-effort human-readable intent summary, derived only from fields the
 * Route Run's own intent payload already carries — never a separate query.
 * Falls back to the intentHash when the intent doesn't have enough to
 * summarize (goal/asset symbols/amount all present). */
export function summarizeRouteIntentV1(intent: {
  goal?: string | null;
  fromAsset?: { symbol: string } | null;
  toAsset?: { symbol: string } | null;
  amount?: { amountDecimal: string } | null;
  intentHash: string;
}): string {
  if (intent.goal && intent.fromAsset && intent.toAsset && intent.amount) {
    return `${intent.goal} ${intent.amount.amountDecimal} ${intent.fromAsset.symbol} -> ${intent.toAsset.symbol}`;
  }
  return intent.intentHash;
}
