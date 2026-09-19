import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// The borrow draft — what an assistant may carry away from a borrow review.
//
// The same shape as the stock action draft, for the same reasons, and keyed
// differently so neither can ever verify as the other:
//
//   * IT CARRIES THE QUESTION, NEVER THE ANSWER. Which wallet, which market,
//     how much. No health factor, no liquidation price, no capacity, no rate.
//     A draft that remembered a health factor would be a draft that could show
//     a stale one as current — and a stale health factor is the single number
//     in this product that a reader would act on hardest.
//   * BOUND TO ONE WALLET. The tenant the private MCP identity proved. A draft
//     minted in one conversation cannot be opened by another account.
//   * SHORT-LIVED. A borrow review is about the market the conversation was
//     about. Five minutes, not fifteen: the collateral price moves and the
//     market's liquidity is drawn down by other people while the link sits
//     unopened.
//
// Nothing here is executable. A draft is not calldata, it is not an approval,
// and the only thing it entitles a holder to is a fresh review.
// ---------------------------------------------------------------------------

export const BORROW_DRAFT_PREFIX_V1 = 'miorail-borrow-v1';

/** Five minutes. A borrow review is worth less the older it is, and unlike a
 * stock question the numbers behind it move for reasons nobody here caused. */
export const BORROW_DRAFT_DEFAULT_TTL_MS_V1 = 5 * 60 * 1000;
export const BORROW_DRAFT_MAX_TTL_MS_V1 = 15 * 60 * 1000;
export const BORROW_DRAFT_MIN_TTL_MS_V1 = 60 * 1000;

export interface BorrowDraftClaimsV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453;
  borrowDraftId: string;
  /** The tokenized security being used as collateral. */
  collateralTokenAddress: `0x${string}`;
  /** The exact market. Never a token pair, never a venue name. */
  marketId: string;
  /** The amount asked for, in loan-asset atomic units. The question, not a term. */
  borrowAssets: string;
  issuedAt: string;
  expiresAt: string;
}

export const BORROW_DRAFT_REFUSALS_V1 = [
  'borrow_draft_malformed',
  'borrow_draft_signature_invalid',
  'borrow_draft_expired',
  'borrow_draft_wrong_wallet',
] as const;
export type BorrowDraftRefusalV1 = (typeof BORROW_DRAFT_REFUSALS_V1)[number];

function signingKeyV1(secret: string): Buffer {
  // Its own domain string. One leaked secret must not be two capabilities, and
  // a borrow draft must never verify as a stock draft or as a bearer token.
  return crypto.createHmac('sha256', secret).update('miorail-borrow-draft/v1').digest();
}

export function borrowDraftTtlMsV1(
  raw: string | undefined = process.env.MIORAIL_BORROW_DRAFT_TTL_MS,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return BORROW_DRAFT_DEFAULT_TTL_MS_V1;
  return Math.min(BORROW_DRAFT_MAX_TTL_MS_V1, Math.max(BORROW_DRAFT_MIN_TTL_MS_V1, parsed));
}

export interface IssuedBorrowDraftV1 {
  draft: string;
  borrowDraftId: string;
  issuedAt: string;
  expiresAt: string;
}

/** Mints a draft for an ALREADY authenticated wallet and an ALREADY measured
 * market. Every field is checked here rather than assumed: a draft is the one
 * object in this flow that outlives the request that made it. */
export function issueBorrowDraftV1(input: {
  tenantId: string;
  walletAddress: string;
  collateralTokenAddress: string;
  marketId: string;
  borrowAssets: bigint;
  secret: string;
  now: Date;
  ttlMs?: number;
  borrowDraftId?: string;
}): IssuedBorrowDraftV1 {
  const wallet = input.walletAddress.toLowerCase();
  const token = input.collateralTokenAddress.toLowerCase();
  const marketId = input.marketId.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error('borrow_wallet_invalid');
  if (input.tenantId !== `eip155:8453:${wallet}`) throw new Error('borrow_tenant_invalid');
  if (!/^0x[0-9a-f]{40}$/.test(token)) throw new Error('borrow_collateral_invalid');
  if (!/^0x[0-9a-f]{64}$/.test(marketId)) throw new Error('borrow_market_invalid');
  if (input.borrowAssets <= 0n) throw new Error('borrow_amount_invalid');

  const ttl = input.ttlMs ?? borrowDraftTtlMsV1();
  const issuedAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + ttl).toISOString();
  const claims: BorrowDraftClaimsV1 = {
    tenantId: input.tenantId,
    walletAddress: wallet as `0x${string}`,
    chainId: 8453,
    borrowDraftId: input.borrowDraftId ?? crypto.randomUUID(),
    collateralTokenAddress: token as `0x${string}`,
    marketId,
    borrowAssets: input.borrowAssets.toString(),
    issuedAt,
    expiresAt,
  };

  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', signingKeyV1(input.secret))
    .update(`${BORROW_DRAFT_PREFIX_V1}.${body}`)
    .digest('base64url');

  return {
    draft: `${BORROW_DRAFT_PREFIX_V1}.${body}.${signature}`,
    borrowDraftId: claims.borrowDraftId,
    issuedAt,
    expiresAt,
  };
}

export type BorrowDraftVerificationV1 =
  | { ok: true; claims: BorrowDraftClaimsV1 }
  | { ok: false; reason: BorrowDraftRefusalV1 };

/**
 * Verifies a draft against a secret, a clock, and the wallet now asking.
 *
 * The signature is compared in constant time, the expiry is checked against the
 * caller's clock rather than the claim's own optimism, and a draft for another
 * wallet is refused by name rather than being silently treated as invalid —
 * those are different failures and an operator needs to tell them apart.
 */
export function verifyBorrowDraftV1(input: {
  draft: string;
  secret: string;
  now: Date;
  walletAddress?: string | null;
}): BorrowDraftVerificationV1 {
  const parts = String(input.draft ?? '').split('.');
  if (parts.length !== 3 || parts[0] !== BORROW_DRAFT_PREFIX_V1) {
    return { ok: false, reason: 'borrow_draft_malformed' };
  }
  const [, body, signature] = parts;
  const expected = crypto
    .createHmac('sha256', signingKeyV1(input.secret))
    .update(`${BORROW_DRAFT_PREFIX_V1}.${body}`)
    .digest('base64url');
  const given = Buffer.from(signature ?? '', 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return { ok: false, reason: 'borrow_draft_signature_invalid' };
  }

  let claims: BorrowDraftClaimsV1;
  try {
    claims = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8')) as BorrowDraftClaimsV1;
  } catch {
    return { ok: false, reason: 'borrow_draft_malformed' };
  }
  if (
    typeof claims?.walletAddress !== 'string' ||
    typeof claims?.marketId !== 'string' ||
    typeof claims?.borrowAssets !== 'string' ||
    typeof claims?.expiresAt !== 'string' ||
    claims.chainId !== 8453
  ) {
    return { ok: false, reason: 'borrow_draft_malformed' };
  }

  const expiresAt = Date.parse(claims.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= input.now.getTime()) {
    return { ok: false, reason: 'borrow_draft_expired' };
  }
  const asking = input.walletAddress?.trim().toLowerCase();
  if (asking !== undefined && asking !== null && asking !== claims.walletAddress.toLowerCase()) {
    return { ok: false, reason: 'borrow_draft_wrong_wallet' };
  }
  return { ok: true, claims };
}
