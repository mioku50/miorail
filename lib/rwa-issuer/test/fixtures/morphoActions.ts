import { createHash, generateKeyPairSync, sign } from 'node:crypto';

export const ACTIONS_NOW = new Date('2026-10-27T15:00:00Z');
export const ACTIONS_WALLET = '0x1111111111111111111111111111111111111111';
export const ACTIONS_MARKET = `0x${'a'.repeat(64)}`;
export const ACTIONS_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const ACTIONS_COLLATERAL = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
export function preparedActionV1(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    action_id: 'test_action', action: 'blue.borrow', status: 'prepared', chain_id: 8453,
    account: ACTIONS_WALLET, expires_at: ACTIONS_NOW.getTime() / 1000 + 300,
    market: { id: ACTIONS_MARKET, loan_asset: { address: ACTIONS_USDC }, collateral_asset: { address: ACTIONS_COLLATERAL } },
    amount: { unit: 'assets', value: '10000000' }, resolved_amount: { unit: 'assets', value: '10000000' },
    calls: [{ id: 'call_0', kind: 'blue_borrow', to: ACTIONS_USDC, data: '0x12345678', value: '0' }],
    simulation: { status: 'success', block: { number: '53000000', timestamp: ACTIONS_NOW.getTime() / 1000 }, wallet_changes: [], position_changes: {},
      effects: { gross_assets: '10000000', net_assets: '10000000', referral_fee_assets: '0', ltv_bps: 1000, max_ltv_bps: 8550 } },
    ...over,
  };
}

/** Real ES256 verification over a fixture HTTP exchange, not a verifier stub. */
export function signedActionsFixtureV1(data: Record<string, any>, options: {
  claims?: Record<string, unknown>;
  alterClaims?: (claims: Record<string, any>) => Record<string, unknown>;
  header?: Record<string, unknown>;
  responseHeaders?: Record<string, string>;
  alterResponse?: (text: string) => string;
  proof?: string | null;
  alterProof?: (proof: string) => string;
  now?: () => Date;
} = {}) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'ES256' };
  const sent: { url: string; init: RequestInit; body: any }[] = [];
  const hash = (body: Uint8Array) => createHash('sha256').update(body).digest('base64url');
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const location = String(url);
    if (location.endsWith('/.well-known/morpho-actions-jwks.json')) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
    const request = typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body as Uint8Array);
    sent.push({ url: location, init, body: JSON.parse(request.toString()) });
    const responseBody = JSON.stringify({ data });
    const now = (options.now?.() ?? ACTIONS_NOW).getTime() / 1000;
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'morpho-action-proof+jwt', kid: 'test-key', ...options.header })).toString('base64url');
    const claimBody = {
      iss: 'morpho-actions-attestor', aud: 'morpho-actions-client', sub: 'action-response', iat: now, exp: now + 60,
      request_id: 'request-test', action_id: data.action_id, action: data.action,
      decision: data.status === 'signature_required' ? 'signature_required' : data.status === 'prepared' && data.simulation?.status === 'success' ? 'approved' : 'rejected',
      request: { method: 'POST', target: new URL(location).pathname, content_type: 'application/json', body_sha256: hash(request) },
      response: { status: 200, content_type: 'application/json', body_sha256: hash(Buffer.from(responseBody)) },
      ...options.claims,
    };
    const claims = Buffer.from(JSON.stringify(options.alterClaims?.(claimBody) ?? claimBody)).toString('base64url');
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const headers = new Headers({ 'content-type': 'application/json', 'X-Request-Id': 'request-test', ...options.responseHeaders });
    if (options.proof !== null) {
      const proof = options.proof ?? `${header}.${claims}.${signature}`;
      headers.set('Morpho-Action-Proof', options.alterProof?.(proof) ?? proof);
    }
    return new Response(options.alterResponse?.(responseBody) ?? responseBody, { headers });
  }) as typeof fetch;
  return { fetchImpl, sent, data, publicJwk: jwk };
}
