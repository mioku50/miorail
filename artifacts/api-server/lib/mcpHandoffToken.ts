import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// T72-B §1/§10 — the wallet-bound handoff token.
//
// An MCP client is not a browser. It holds a static config file and sends a
// header; it has no cookie jar, no SIWE flow and no way to be redirected
// through a login. So the wallet binding has to travel in a bearer credential
// that the browser session mints AFTER the wallet has already proved itself.
//
// The token asserts exactly one thing: "this caller is the wallet that was
// signed in at Miorail when the token was issued". It is not an authorisation
// to spend, and it cannot become one — every executable path behind it still
// ends at the user's own Base Account, which signs or does not.
//
// Two properties are load-bearing:
//
//   * SHORT-LIVED, and not negotiably so. The token is stateless, so it cannot
//     be revoked before it expires; the answer to that is that it does not live
//     long. `MIORAIL_MCP_HANDOFF_TTL_MS` may shorten it and may not push it past
//     the ceiling here, because a config value that could make a bearer token
//     long-lived is the same hazard by a slower route.
//   * KEYED BY DERIVATION, never by the session secret directly. A signing key
//     that is also the cookie secret means one leak is two compromises, and a
//     token minted for MCP would verify anywhere else the same secret is used.
// ---------------------------------------------------------------------------

/** The version prefix. A token that does not start with this is refused before
 * any of it is parsed, so a credential from another system is never decoded. */
export const MCP_HANDOFF_PREFIX_V1 = 'miorail-mcp-v1';

export const MCP_HANDOFF_DEFAULT_TTL_MS_V1 = 30 * 60 * 1000;
/** The ceiling. §10 says short-lived, and this is what makes that a property of
 * the code rather than of whoever last edited the environment. */
export const MCP_HANDOFF_MAX_TTL_MS_V1 = 4 * 60 * 60 * 1000;
export const MCP_HANDOFF_MIN_TTL_MS_V1 = 60 * 1000;

export interface McpHandoffClaimsV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453;
  /** Identifies this token in audit logs. The token itself is never logged. */
  tokenId: string;
  issuedAt: string;
  expiresAt: string;
}

export type McpHandoffRefusalV1 =
  | 'handoff_token_missing'
  | 'handoff_token_malformed'
  | 'handoff_token_bad_signature'
  | 'handoff_token_expired'
  | 'handoff_token_unbound';

export const MCP_HANDOFF_REFUSAL_COPY_V1: Record<McpHandoffRefusalV1, string> = {
  handoff_token_missing:
    'This endpoint needs a Miorail handoff token. Sign in to Miorail with your wallet, issue one from Settings, and send it as an Authorization: Bearer header.',
  handoff_token_malformed: 'That is not a Miorail handoff token.',
  handoff_token_bad_signature:
    'That handoff token was not issued by this Miorail server, or the server’s signing secret has changed since.',
  handoff_token_expired:
    'That handoff token has expired. Handoff tokens are deliberately short-lived — issue a new one from Miorail.',
  handoff_token_unbound:
    'That handoff token is not bound to a Base mainnet wallet, so it cannot be used to read or execute anything.',
};

function signingKeyV1(secret: string): Buffer {
  // Domain separation: the MCP key is DERIVED from the session secret rather
  // than being it, so a handoff token cannot be replayed against anything else
  // that signs with the same value.
  return crypto.createHmac('sha256', secret).update('miorail-mcp-handoff/v1').digest();
}

function base64urlV1(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function handoffTtlMsV1(raw: string | undefined = process.env.MIORAIL_MCP_HANDOFF_TTL_MS): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return MCP_HANDOFF_DEFAULT_TTL_MS_V1;
  return Math.min(MCP_HANDOFF_MAX_TTL_MS_V1, Math.max(MCP_HANDOFF_MIN_TTL_MS_V1, parsed));
}

export interface IssuedHandoffV1 {
  token: string;
  tokenId: string;
  issuedAt: string;
  expiresAt: string;
  expiresInMs: number;
}

/**
 * Mints a token for an ALREADY authenticated wallet.
 *
 * The caller passes the session's own tenant and wallet. There is no argument
 * by which a request could name a different one, which is the whole reason this
 * function takes claims rather than a request.
 */
export function issueHandoffTokenV1(input: {
  tenantId: string;
  walletAddress: string;
  secret: string;
  now: Date;
  ttlMs?: number;
  tokenId?: string;
}): IssuedHandoffV1 {
  const wallet = input.walletAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error('handoff_wallet_invalid');
  if (input.tenantId !== `eip155:8453:${wallet}`) throw new Error('handoff_tenant_invalid');

  const ttl = input.ttlMs ?? handoffTtlMsV1();
  const issuedAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + ttl).toISOString();
  const claims: McpHandoffClaimsV1 = {
    tenantId: input.tenantId,
    walletAddress: wallet as `0x${string}`,
    chainId: 8453,
    tokenId: input.tokenId ?? crypto.randomUUID(),
    issuedAt,
    expiresAt,
  };

  const body = base64urlV1(JSON.stringify(claims));
  const signature = crypto
    .createHmac('sha256', signingKeyV1(input.secret))
    .update(`${MCP_HANDOFF_PREFIX_V1}.${body}`)
    .digest('base64url');

  return {
    token: `${MCP_HANDOFF_PREFIX_V1}.${body}.${signature}`,
    tokenId: claims.tokenId,
    issuedAt,
    expiresAt,
    expiresInMs: ttl,
  };
}

export type HandoffVerificationV1 =
  | { ok: true; claims: McpHandoffClaimsV1 }
  | { ok: false; reason: McpHandoffRefusalV1 };

/**
 * Verifies a token and returns the wallet it is bound to.
 *
 * The signature is checked BEFORE the claims are trusted for anything, and the
 * comparison is timing-safe. The expiry check comes after the signature on
 * purpose: an unsigned token has no expiry worth reading.
 */
export function verifyHandoffTokenV1(input: {
  token: string | null | undefined;
  secret: string;
  now: Date;
}): HandoffVerificationV1 {
  const raw = (input.token ?? '').trim();
  if (!raw) return { ok: false, reason: 'handoff_token_missing' };

  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== MCP_HANDOFF_PREFIX_V1) {
    return { ok: false, reason: 'handoff_token_malformed' };
  }
  const [, body, signature] = parts;

  const expected = crypto
    .createHmac('sha256', signingKeyV1(input.secret))
    .update(`${MCP_HANDOFF_PREFIX_V1}.${body}`)
    .digest('base64url');
  const given = Buffer.from(signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  // Length is compared first because `timingSafeEqual` throws on a mismatch,
  // and a thrown error here would be a refusal that skipped the constant-time
  // path.
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return { ok: false, reason: 'handoff_token_bad_signature' };
  }

  let claims: McpHandoffClaimsV1;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as McpHandoffClaimsV1;
  } catch {
    return { ok: false, reason: 'handoff_token_malformed' };
  }

  const wallet = String(claims?.walletAddress ?? '').toLowerCase();
  // Re-asserted rather than assumed. A signed token is proof of origin, not of
  // shape, and every caller downstream reads these two fields as identity.
  if (
    !/^0x[0-9a-f]{40}$/.test(wallet) ||
    claims.chainId !== 8453 ||
    claims.tenantId !== `eip155:8453:${wallet}` ||
    typeof claims.tokenId !== 'string' ||
    !claims.tokenId
  ) {
    return { ok: false, reason: 'handoff_token_unbound' };
  }

  const expiresAt = Date.parse(String(claims.expiresAt));
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'handoff_token_malformed' };
  if (expiresAt <= input.now.getTime()) return { ok: false, reason: 'handoff_token_expired' };

  return { ok: true, claims: { ...claims, walletAddress: wallet as `0x${string}` } };
}

/** Reads a bearer credential out of the request headers, with no fallback to a
 * query parameter: a token in a URL ends up in access logs and referrers. */
export function bearerTokenV1(headerValue: string | string[] | undefined): string | null {
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
