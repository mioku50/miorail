import { BITREFILL_V2_PATH_PREFIX_V1, BITREFILL_X402_PATH_PREFIX_V1 } from './pinned-config.js';

// ---------------------------------------------------------------------------
// T64.1 — two credentials, two headers, two API surfaces, and no way to cross
// them.
//
//   BITREFILL_API_KEY      → Authorization: Bearer …   → Personal API  /v2/*
//   BITREFILL_ACCESS_TOKEN → X-Access-Token: …         → x402 SIWX     /x402/*
//
// A Personal API key sent as `X-Access-Token` is not a smaller mistake than an
// unauthenticated call: it ships a long-lived account credential to a gate that
// never asked for it, on a route that cannot use it. So the rule is mechanical
// rather than conventional — `commerceAuthHeadersV1` REFUSES to produce headers
// for a credential/surface pair that does not belong together, and every
// request in this package goes through it.
// ---------------------------------------------------------------------------

export type CommerceApiSurfaceV1 = 'personal_api' | 'x402';

/** Which surface a pinned path belongs to. Anything unrecognised is null and
 * therefore un-authenticatable, which fails closed by construction. */
export function commerceSurfaceForPathV1(path: string): CommerceApiSurfaceV1 | null {
  if (path.startsWith(BITREFILL_V2_PATH_PREFIX_V1)) return 'personal_api';
  if (path.startsWith(BITREFILL_X402_PATH_PREFIX_V1)) return 'x402';
  return null;
}

export type CommerceCredentialV1 =
  /** Personal API key from the Bitrefill Developers page. Account-scoped and
   * long-lived: it authenticates `/v2/*` and nothing else. */
  | { kind: 'personal_api'; apiKey: string }
  /** Short-lived SIWX session token (~2h) minted by `/x402/connect`. It waives
   * micro-fees on `/x402/*` and has no meaning on the Personal API. */
  | { kind: 'x402_session'; accessToken: string }
  | { kind: 'anonymous' };

export class CommerceCredentialSurfaceError extends Error {
  readonly credentialKind: CommerceCredentialV1['kind'];
  readonly surface: CommerceApiSurfaceV1 | null;

  constructor(credentialKind: CommerceCredentialV1['kind'], surface: CommerceApiSurfaceV1 | null) {
    // Deliberately says WHICH pair was refused and never the credential value.
    super(`Commerce credential ${credentialKind} cannot authenticate the ${surface ?? 'unknown'} surface`);
    this.name = 'CommerceCredentialSurfaceError';
    this.credentialKind = credentialKind;
    this.surface = surface;
  }
}

/**
 * The auth headers for one pinned path.
 *
 * Throws `CommerceCredentialSurfaceError` rather than degrading to an
 * unauthenticated request: silently dropping a credential would turn a
 * misconfiguration into a confusing 402 instead of a loud, fixable error.
 * Anonymous is the one case that legitimately yields no header.
 */
export function commerceAuthHeadersV1(
  credential: CommerceCredentialV1,
  path: string,
): Record<string, string> {
  const surface = commerceSurfaceForPathV1(path);
  if (credential.kind === 'anonymous') return {};
  if (surface === null) throw new CommerceCredentialSurfaceError(credential.kind, surface);

  if (credential.kind === 'personal_api') {
    if (surface !== 'personal_api') throw new CommerceCredentialSurfaceError(credential.kind, surface);
    return { authorization: `Bearer ${credential.apiKey}` };
  }
  if (surface !== 'x402') throw new CommerceCredentialSurfaceError(credential.kind, surface);
  return { 'X-Access-Token': credential.accessToken };
}

/**
 * Chooses the credential from configuration.
 *
 * The Personal API key wins when both are present: it is the account-backed
 * surface with a real catalogue, whereas the session token only waives x402
 * micro-fees. They are never merged, and neither is ever used on the other's
 * routes.
 */
export function resolveCommerceCredentialV1(config: {
  apiKey?: string;
  accessToken?: string;
}): CommerceCredentialV1 {
  const apiKey = config.apiKey?.trim();
  if (apiKey) return { kind: 'personal_api', apiKey };
  const accessToken = config.accessToken?.trim();
  if (accessToken) return { kind: 'x402_session', accessToken };
  return { kind: 'anonymous' };
}

/** The API surface a credential can actually reach. */
export function commerceSurfaceForCredentialV1(credential: CommerceCredentialV1): CommerceApiSurfaceV1 {
  return credential.kind === 'personal_api' ? 'personal_api' : 'x402';
}
