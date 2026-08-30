import crypto from 'node:crypto';

import type { StockExecutionHandoffV1 } from '@mioagent/rwa-market-reality/execution-handoff';

// ---------------------------------------------------------------------------
// Connected Intelligence 2 — what an explicit confirmation produces.
//
// A stock clearance is NOT a B20 clearance wearing a stock's address. The B20
// one certifies a round trip through Aerodrome after a wallet-bound
// simulation; this one records that a person looked at freshly established
// terms for ONE exact reviewed representation and said yes. They authorise
// different things and they must not be mistaken for each other, so this has
// its own type, its own key derivation and its own refusal vocabulary.
//
// What it carries is identity, never terms. The executable request is derived
// AFTER this, from state read then — so a clearance cannot age into a price.
// What it does carry is the route identity the review was confirmed under:
// the reviewed policy and the approved sources. If either has moved by the
// time the action is fetched, this clearance is about a question that no
// longer exists and it refuses.
//
// SHORT-LIVED, and shorter than the draft that preceded it. A draft is an
// invitation to look; this is the last thing standing between a conversation
// and a wallet prompt.
// ---------------------------------------------------------------------------

export const STOCK_ACTION_CLEARANCE_PREFIX_V1 = 'miorail-stock-clearance-v1';

export const STOCK_ACTION_CLEARANCE_DEFAULT_TTL_MS_V1 = 5 * 60 * 1000;
export const STOCK_ACTION_CLEARANCE_MAX_TTL_MS_V1 = 15 * 60 * 1000;
export const STOCK_ACTION_CLEARANCE_MIN_TTL_MS_V1 = 30 * 1000;

export interface StockActionClearanceClaimsV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453;
  clearanceId: string;
  /** The draft this confirmation answered, so the two can be joined in audit. */
  actionDraftId: string;

  tokenAddress: `0x${string}`;
  caip10: string;
  underlyingKey: string;
  issuerId: StockExecutionHandoffV1['issuerId'];
  issuerInstrumentKey: string;
  representationKind: StockExecutionHandoffV1['representationKind'];

  direction: StockExecutionHandoffV1['direction'];
  requestedCashAtomic: string;
  cashAddress: string;
  destination: 'USDC';
  sizeBasis: StockExecutionHandoffV1['sizeBasis'];

  /** The measurement basis the person confirmed under. */
  routePolicyKey: string;
  approvedSources: string[];

  issuedAt: string;
  expiresAt: string;
}

export type StockActionClearanceRefusalV1 =
  | 'stock_clearance_missing'
  | 'stock_clearance_malformed'
  | 'stock_clearance_bad_signature'
  | 'stock_clearance_expired'
  | 'stock_clearance_wrong_wallet';

export const STOCK_ACTION_CLEARANCE_REFUSAL_COPY_V1: Record<
  StockActionClearanceRefusalV1,
  string
> = {
  stock_clearance_missing: 'No confirmed stock clearance was supplied.',
  stock_clearance_malformed: 'That is not a Miorail stock clearance.',
  stock_clearance_bad_signature:
    'That clearance was not issued by this Miorail server, or the server’s signing secret has changed since.',
  stock_clearance_expired:
    'That confirmation has expired. A confirmation authorises one action against the terms that were on screen, and those terms are no longer current — review again.',
  stock_clearance_wrong_wallet:
    'That clearance belongs to a different wallet. Miorail will not act on one account’s confirmation for another.',
};

function signingKeyV1(secret: string): Buffer {
  // Its own domain. A draft must never verify as a clearance: one says "look
  // at this", the other says "this person said yes".
  return crypto.createHmac('sha256', secret).update('miorail-stock-action-clearance/v1').digest();
}

export function stockActionClearanceTtlMsV1(
  raw: string | undefined = process.env.MIORAIL_STOCK_ACTION_CLEARANCE_TTL_MS,
): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return STOCK_ACTION_CLEARANCE_DEFAULT_TTL_MS_V1;
  return Math.min(
    STOCK_ACTION_CLEARANCE_MAX_TTL_MS_V1,
    Math.max(STOCK_ACTION_CLEARANCE_MIN_TTL_MS_V1, parsed),
  );
}

export interface IssuedStockActionClearanceV1 {
  clearance: string;
  clearanceId: string;
  issuedAt: string;
  expiresAt: string;
}

/**
 * Mints a clearance from a handoff that was rebuilt at review time.
 *
 * Takes the REBUILT handoff, never the draft's remembered fields: the point of
 * the confirmation boundary is that what the person confirmed was established
 * then, and a clearance built from the draft would carry the older question
 * forward under a newer signature.
 */
export function issueStockActionClearanceV1(input: {
  tenantId: string;
  walletAddress: string;
  actionDraftId: string;
  handoff: StockExecutionHandoffV1;
  secret: string;
  now: Date;
  ttlMs?: number;
  clearanceId?: string;
}): IssuedStockActionClearanceV1 {
  const wallet = input.walletAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error('stock_clearance_wallet_invalid');
  if (input.tenantId !== `eip155:8453:${wallet}`) throw new Error('stock_clearance_tenant_invalid');

  const ttl = input.ttlMs ?? stockActionClearanceTtlMsV1();
  const issuedAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + ttl).toISOString();
  const claims: StockActionClearanceClaimsV1 = {
    tenantId: input.tenantId,
    walletAddress: wallet as `0x${string}`,
    chainId: 8453,
    clearanceId: input.clearanceId ?? crypto.randomUUID(),
    actionDraftId: input.actionDraftId,
    tokenAddress: input.handoff.tokenAddress as `0x${string}`,
    caip10: input.handoff.caip10,
    underlyingKey: input.handoff.underlyingKey,
    issuerId: input.handoff.issuerId,
    issuerInstrumentKey: input.handoff.issuerInstrumentKey,
    representationKind: input.handoff.representationKind,
    direction: input.handoff.direction,
    requestedCashAtomic: input.handoff.requestedCashAtomic,
    cashAddress: input.handoff.cashAddress,
    destination: 'USDC',
    sizeBasis: input.handoff.sizeBasis,
    routePolicyKey: input.handoff.routePolicyKey,
    approvedSources: [...input.handoff.approvedSources],
    issuedAt,
    expiresAt,
  };

  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', signingKeyV1(input.secret))
    .update(`${STOCK_ACTION_CLEARANCE_PREFIX_V1}.${body}`)
    .digest('base64url');

  return {
    clearance: `${STOCK_ACTION_CLEARANCE_PREFIX_V1}.${body}.${signature}`,
    clearanceId: claims.clearanceId,
    issuedAt,
    expiresAt,
  };
}

export type StockActionClearanceVerificationV1 =
  | { ok: true; claims: StockActionClearanceClaimsV1 }
  | { ok: false; reason: StockActionClearanceRefusalV1 };

/**
 * Verifies a clearance against the tenant that PROVED itself.
 *
 * `expectTenantId` is the authenticated identity, never a field a caller sent.
 * A clearance minted for one wallet and presented under another's token is a
 * refusal, not a lookup.
 */
export function verifyStockActionClearanceV1(input: {
  clearance: string | null | undefined;
  secret: string;
  now: Date;
  expectTenantId: string;
}): StockActionClearanceVerificationV1 {
  const raw = (input.clearance ?? '').trim();
  if (!raw) return { ok: false, reason: 'stock_clearance_missing' };

  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== STOCK_ACTION_CLEARANCE_PREFIX_V1) {
    return { ok: false, reason: 'stock_clearance_malformed' };
  }
  const [, body, signature] = parts;

  const expected = crypto
    .createHmac('sha256', signingKeyV1(input.secret))
    .update(`${STOCK_ACTION_CLEARANCE_PREFIX_V1}.${body}`)
    .digest('base64url');
  const given = Buffer.from(signature ?? '', 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return { ok: false, reason: 'stock_clearance_bad_signature' };
  }

  let claims: StockActionClearanceClaimsV1;
  try {
    claims = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'stock_clearance_malformed' };
  }

  if (
    typeof claims?.tenantId !== 'string' ||
    typeof claims?.walletAddress !== 'string' ||
    claims.chainId !== 8453 ||
    !/^0x[0-9a-f]{40}$/.test(claims.walletAddress) ||
    !/^0x[0-9a-f]{40}$/.test(claims.tokenAddress ?? '') ||
    claims.tenantId !== `eip155:8453:${claims.walletAddress}` ||
    claims.destination !== 'USDC' ||
    !Array.isArray(claims.approvedSources) ||
    claims.approvedSources.length === 0
  ) {
    return { ok: false, reason: 'stock_clearance_malformed' };
  }

  const expiresAt = Date.parse(claims.expiresAt ?? '');
  if (!Number.isFinite(expiresAt) || expiresAt <= input.now.getTime()) {
    return { ok: false, reason: 'stock_clearance_expired' };
  }

  if (input.expectTenantId !== claims.tenantId) {
    return { ok: false, reason: 'stock_clearance_wrong_wallet' };
  }

  return { ok: true, claims };
}
