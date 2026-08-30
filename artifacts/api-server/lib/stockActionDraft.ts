import crypto from 'node:crypto';

import type { StockExecutionHandoffV1 } from '@mioagent/rwa-market-reality/execution-handoff';

// ---------------------------------------------------------------------------
// Connected Intelligence 1 — the stock action draft.
//
// What an external assistant is allowed to carry away from a Stocks
// conversation, and nothing else: WHICH exact representation is being reviewed,
// and WHICH exact question. Not what it costs.
//
// Signed and stateless, exactly like the MCP handoff token it sits beside. That
// is not a storage shortcut, it is the guarantee: a draft that carries no live
// terms cannot go stale into a number, because there is no number in it to go
// stale. Everything financial is re-derived when the review page opens, from
// canonical evidence, under the session of the wallet the draft is bound to.
//
// Three properties are load-bearing:
//
//   * BOUND TO ONE WALLET. The claims carry the tenant the private MCP identity
//     proved. A draft minted in one conversation cannot be opened by another
//     account, and the review endpoint checks the session against the claim
//     rather than trusting the URL.
//   * SHORT-LIVED. A conversational turn is seconds; a review that opens hours
//     later is a different market. The ceiling is a property of this file, not
//     of whoever last edited the environment.
//   * KEYED BY DERIVATION. Its own domain string, so a draft can never verify
//     as a handoff token and a handoff token can never verify as a draft.
// ---------------------------------------------------------------------------

export const STOCK_ACTION_DRAFT_PREFIX_V1 = 'miorail-stock-action-v1';

/** Fifteen minutes. Long enough to open a link, short enough that the review is
 * about the market the conversation was about. */
export const STOCK_ACTION_DRAFT_DEFAULT_TTL_MS_V1 = 15 * 60 * 1000;
export const STOCK_ACTION_DRAFT_MAX_TTL_MS_V1 = 60 * 60 * 1000;
export const STOCK_ACTION_DRAFT_MIN_TTL_MS_V1 = 60 * 1000;

/**
 * Everything a draft carries.
 *
 * Deliberately the identity half of `StockExecutionHandoffV1` and none of its
 * evidence half: `evidenceState`, `quoteExpiresAt` and anything derived from a
 * quote are absent, because a draft that remembered the state of a quote would
 * be a draft that could describe an expired one as current.
 */
export interface StockActionDraftClaimsV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453;
  actionDraftId: string;
  tokenAddress: `0x${string}`;
  caip10: string;
  underlyingKey: string;
  issuerId: StockExecutionHandoffV1['issuerId'];
  issuerInstrumentKey: string;
  representationKind: StockExecutionHandoffV1['representationKind'];
  direction: StockExecutionHandoffV1['direction'];
  requestedCashAtomic: string;
  destination: 'USDC';
  routePolicyKey: string;
  /** A BUY spends an exact cash amount; a SELL of "cash worth" has no exact
   * token amount until something prices it. Carried so the review does not have
   * to re-derive intent from the direction. */
  sizeBasis: StockExecutionHandoffV1['sizeBasis'];
  issuedAt: string;
  expiresAt: string;
}

export type StockActionDraftRefusalV1 =
  | 'stock_action_draft_missing'
  | 'stock_action_draft_malformed'
  | 'stock_action_draft_bad_signature'
  | 'stock_action_draft_expired'
  | 'stock_action_draft_wrong_wallet';

export const STOCK_ACTION_DRAFT_REFUSAL_COPY_V1: Record<StockActionDraftRefusalV1, string> = {
  stock_action_draft_missing: 'This review link carries no Miorail action draft.',
  stock_action_draft_malformed: 'That is not a Miorail action draft.',
  stock_action_draft_bad_signature:
    'That action draft was not issued by this Miorail server, or the server’s signing secret has changed since.',
  stock_action_draft_expired:
    'That action draft has expired. Drafts are deliberately short-lived, because a review that opens later is about a different market — ask Miorail to prepare it again.',
  stock_action_draft_wrong_wallet:
    'That action draft belongs to a different wallet. Miorail will not open one account’s review under another’s session.',
};

function signingKeyV1(secret: string): Buffer {
  // Its own domain, never the session secret directly and never the MCP
  // handoff's derivation: one leak must not be two, and a draft must not verify
  // as a bearer credential.
  return crypto.createHmac('sha256', secret).update('miorail-stock-action-draft/v1').digest();
}

export function stockActionDraftTtlMsV1(
  raw: string | undefined = process.env.MIORAIL_STOCK_ACTION_DRAFT_TTL_MS,
): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return STOCK_ACTION_DRAFT_DEFAULT_TTL_MS_V1;
  return Math.min(
    STOCK_ACTION_DRAFT_MAX_TTL_MS_V1,
    Math.max(STOCK_ACTION_DRAFT_MIN_TTL_MS_V1, parsed),
  );
}

export interface IssuedStockActionDraftV1 {
  draft: string;
  actionDraftId: string;
  issuedAt: string;
  expiresAt: string;
}

/**
 * Mints a draft for an ALREADY authenticated wallet, from an ALREADY validated
 * handoff.
 *
 * Takes the handoff rather than loose fields on purpose: the handoff is what
 * canonical Stocks evidence produced, so there is no argument by which a caller
 * could put a representation into a draft that the evidence did not name.
 */
export function issueStockActionDraftV1(input: {
  tenantId: string;
  walletAddress: string;
  handoff: StockExecutionHandoffV1;
  secret: string;
  now: Date;
  ttlMs?: number;
  actionDraftId?: string;
}): IssuedStockActionDraftV1 {
  const wallet = input.walletAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error('stock_action_wallet_invalid');
  if (input.tenantId !== `eip155:8453:${wallet}`) throw new Error('stock_action_tenant_invalid');

  const ttl = input.ttlMs ?? stockActionDraftTtlMsV1();
  const issuedAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + ttl).toISOString();
  const claims: StockActionDraftClaimsV1 = {
    tenantId: input.tenantId,
    walletAddress: wallet as `0x${string}`,
    chainId: 8453,
    actionDraftId: input.actionDraftId ?? crypto.randomUUID(),
    tokenAddress: input.handoff.tokenAddress as `0x${string}`,
    caip10: input.handoff.caip10,
    underlyingKey: input.handoff.underlyingKey,
    issuerId: input.handoff.issuerId,
    issuerInstrumentKey: input.handoff.issuerInstrumentKey,
    representationKind: input.handoff.representationKind,
    direction: input.handoff.direction,
    requestedCashAtomic: input.handoff.requestedCashAtomic,
    destination: 'USDC',
    routePolicyKey: input.handoff.routePolicyKey,
    sizeBasis: input.handoff.sizeBasis,
    issuedAt,
    expiresAt,
  };

  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', signingKeyV1(input.secret))
    .update(`${STOCK_ACTION_DRAFT_PREFIX_V1}.${body}`)
    .digest('base64url');

  return {
    draft: `${STOCK_ACTION_DRAFT_PREFIX_V1}.${body}.${signature}`,
    actionDraftId: claims.actionDraftId,
    issuedAt,
    expiresAt,
  };
}

export type StockActionDraftVerificationV1 =
  | { ok: true; claims: StockActionDraftClaimsV1 }
  | { ok: false; reason: StockActionDraftRefusalV1 };

/**
 * Verifies a draft and returns the exact question it names.
 *
 * The signature is checked before the claims are trusted for anything, and the
 * comparison is timing-safe. `expectTenantId` is the SESSION's tenant, not the
 * URL's: a draft opened under another account is refused rather than resolved.
 */
export function verifyStockActionDraftV1(input: {
  draft: string | null | undefined;
  secret: string;
  now: Date;
  expectTenantId?: string;
}): StockActionDraftVerificationV1 {
  const raw = (input.draft ?? '').trim();
  if (!raw) return { ok: false, reason: 'stock_action_draft_missing' };

  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== STOCK_ACTION_DRAFT_PREFIX_V1) {
    return { ok: false, reason: 'stock_action_draft_malformed' };
  }
  const [, body, signature] = parts;

  const expected = crypto
    .createHmac('sha256', signingKeyV1(input.secret))
    .update(`${STOCK_ACTION_DRAFT_PREFIX_V1}.${body}`)
    .digest('base64url');
  const given = Buffer.from(signature ?? '', 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return { ok: false, reason: 'stock_action_draft_bad_signature' };
  }

  let claims: StockActionDraftClaimsV1;
  try {
    claims = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'stock_action_draft_malformed' };
  }

  if (
    typeof claims?.tenantId !== 'string' ||
    typeof claims?.walletAddress !== 'string' ||
    claims.chainId !== 8453 ||
    !/^0x[0-9a-f]{40}$/.test(claims.walletAddress) ||
    !/^0x[0-9a-f]{40}$/.test(claims.tokenAddress ?? '') ||
    claims.tenantId !== `eip155:8453:${claims.walletAddress}` ||
    claims.destination !== 'USDC'
  ) {
    return { ok: false, reason: 'stock_action_draft_malformed' };
  }

  const expiresAt = Date.parse(claims.expiresAt ?? '');
  if (!Number.isFinite(expiresAt) || expiresAt <= input.now.getTime()) {
    return { ok: false, reason: 'stock_action_draft_expired' };
  }

  if (input.expectTenantId !== undefined && input.expectTenantId !== claims.tenantId) {
    return { ok: false, reason: 'stock_action_draft_wrong_wallet' };
  }

  return { ok: true, claims };
}
