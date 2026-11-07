import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { partnerFetch } from '@mioagent/security/httpAllowlist';

export const MORPHO_ACTION_ORIGIN_V1 = 'https://api.morpho.org';
export const MORPHO_ACTION_JWKS_V1 = `${MORPHO_ACTION_ORIGIN_V1}/.well-known/morpho-actions-jwks.json`;
/**
 * The names Morpho's attestor signs its proofs as. It was "morpho-actions-attestor"; by
 * 2026-11-07 it was the Actions origin itself, and every Still loan and repayment on Morpho was
 * refused as unauthenticated until this list had it. The signature, checked against Morpho's own
 * key set, is what authenticates an answer; the issuer only has to be one of Morpho's names.
 */
export const MORPHO_ACTION_ISSUERS_V1: readonly string[] = [`${MORPHO_ACTION_ORIGIN_V1}/v0/actions`, 'morpho-actions-attestor'];
/** Which part of a proof did not hold, for the log and the refusal's detail: never the token. */
export type MorphoActionProofFailureV1 =
  | 'path' | 'missing' | 'malformed' | 'header' | 'key' | 'signature' | 'time' | 'issuer' | 'audience' | 'binding' | 'exchange' | 'decision';

type RecordV1 = Record<string, unknown>;
const object = (value: unknown): value is RecordV1 => typeof value === 'object' && value !== null && !Array.isArray(value);
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64url');
const cache = new WeakMap<typeof fetch, { at: number; keys: RecordV1[] }>();

/** Only Morpho's fixed production key set is trusted. Never follow a jku/x5u
 * supplied by a token. A removed key is retained for at most sixty seconds. */
async function publicKey(kid: string, deps: { fetchImpl?: typeof fetch; now: Date; timeoutMs?: number }): Promise<JsonWebKey | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const at = deps.now.getTime();
  let hit = cache.get(fetchImpl);
  const age = hit ? at - hit.at : Infinity;
  if (!hit || age < 0 || age >= 60_000 || !hit.keys.some((key) => key.kid === kid)) {
    const response = await partnerFetch(MORPHO_ACTION_JWKS_V1, { redirect: 'error', headers: { accept: 'application/json' } },
      { fetchImpl, timeoutMs: deps.timeoutMs ?? 8_000 });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 64_000) return null;
    const body: unknown = JSON.parse(text);
    if (!object(body) || !Array.isArray(body.keys) || body.keys.length > 50 || !body.keys.every(object)) return null;
    hit = { at, keys: body.keys };
    cache.set(fetchImpl, hit);
  }
  const matches = hit.keys.filter((key) => key.kid === kid);
  if (matches.length !== 1) return null;
  const key = matches[0]!;
  if (key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== 'ES256' ||
      (key.use !== undefined && key.use !== 'sig') || key.d !== undefined ||
      (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify'))) ||
      typeof key.x !== 'string' || typeof key.y !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || !/^[A-Za-z0-9_-]{43}$/.test(key.y)) return null;
  return key as JsonWebKey;
}

/** Morpho's documented Actions proof binds the EXACT decoded HTTP bytes,
 * headers, path and status. Re-serializing an MCP data object is not this
 * exchange and cannot establish that binding. No proof is ever a simulation. */
export async function verifyMorphoActionProofV1(input: {
  response: Response;
  responseBytes: Uint8Array;
  requestBytes: Uint8Array;
  path: string;
  data: RecordV1;
  now: Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ ok: true; expiresAtMs: number } | { ok: false; failed: MorphoActionProofFailureV1 }> {
  const no = (failed: MorphoActionProofFailureV1) => ({ ok: false as const, failed });
  try {
    if (!input.path.startsWith('/v0/actions/') || input.path.includes('?') || input.path.includes('#')) return no('path');
    const token = input.response.headers.get('Morpho-Action-Proof');
    if (!token || token.length > 32_000) return no('missing');
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return no('malformed');
    const header: unknown = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!object(header) || !object(claims)) return no('malformed');
    if (header.alg !== 'ES256' || header.typ !== 'morpho-action-proof+jwt' ||
        typeof header.kid !== 'string' || header.kid.length < 1 || header.kid.length > 200 ||
        header.crit !== undefined || header.b64 !== undefined) return no('header');
    const key = await publicKey(header.kid, input);
    if (!key) return no('key');
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (signature.length !== 64 || !verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, signature)) return no('signature');
    const now = input.now.getTime() / 1000;
    const { exp, iat } = claims;
    if (!Number.isSafeInteger(exp) || !Number.isSafeInteger(iat) || (exp as number) <= now ||
        (iat as number) > now + 5 || now - (iat as number) > 60 || (exp as number) <= (iat as number)) return no('time');
    if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || (claims.nbf as number) > now + 5)) return no('time');
    if (typeof claims.iss !== 'string' || !MORPHO_ACTION_ISSUERS_V1.includes(claims.iss)) return no('issuer');
    if (claims.aud !== 'morpho-actions-client' || claims.sub !== 'action-response') return no('audience');
    const requestId = input.response.headers.get('X-Request-Id');
    if (!requestId || claims.request_id !== requestId || typeof input.data.action_id !== 'string' || !input.data.action_id ||
        claims.action_id !== input.data.action_id || claims.action !== input.data.action) return no('binding');
    const request = claims.request, response = claims.response;
    if (!object(request) || !object(response) || request.method !== 'POST' || request.target !== input.path ||
        request.content_type !== 'application/json' || request.body_sha256 !== hash(input.requestBytes) ||
        response.status !== input.response.status || response.content_type !== input.response.headers.get('Content-Type') ||
        response.body_sha256 !== hash(input.responseBytes)) return no('exchange');
    const expectedDecision = input.data.status === 'signature_required' ? 'signature_required'
      : input.data.status === 'prepared' && object(input.data.simulation) && input.data.simulation.status === 'success' ? 'approved'
        : input.data.status === 'simulation_failed' ? 'rejected' : null;
    if (!expectedDecision || claims.decision !== expectedDecision) return no('decision');
    return { ok: true, expiresAtMs: Math.min((exp as number) * 1000, ((iat as number) + 60) * 1000) };
  } catch {
    return no('malformed');
  }
}
