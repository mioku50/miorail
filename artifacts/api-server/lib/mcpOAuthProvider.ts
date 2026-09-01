import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { client as sql } from '@mioagent/db';
import { MCP_OAUTH_GRANT_ID_PREFIX_V1 } from '@mioagent/route-storage';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

const ACCESS_TTL_MS_V1 = 15 * 60 * 1000;
const GRANT_TTL_MS_V1 = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS_V1 = 5 * 60 * 1000;
export const MCP_OAUTH_SCOPES_V1 = ['miorail:connected', 'offline_access'] as const;

type OAuthGrantRowV1 = {
  id: string;
  tenantId: string;
  walletAddress: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  resource: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  useCount: number;
  revokedAt: string | null;
};

function publicOriginV1(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.MIORAIL_PUBLIC_ORIGIN ?? 'https://miorail.xyz').trim();
  const url = new URL(configured);
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('MIORAIL_PUBLIC_ORIGIN must use HTTPS in production');
  }
  return url.origin;
}

export function mcpOAuthResourceUrlV1(env: NodeJS.ProcessEnv = process.env): URL {
  return new URL('/mcp/private', publicOriginV1(env));
}

function secretV1(env: NodeJS.ProcessEnv = process.env): string {
  const value = (env.MCP_OAUTH_ENCRYPTION_SECRET ?? env.SESSION_SECRET ?? '').trim();
  if (value) return value;
  if (env.NODE_ENV === 'production') throw new Error('MCP OAuth encryption secret is required');
  return 'miorail-oauth-development-only';
}

function encryptionKeyV1(): Buffer {
  return crypto.createHash('sha256').update(`miorail-mcp-oauth/v1:${secretV1()}`).digest();
}

function encryptClientV1(client: OAuthClientInformationFull): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKeyV1(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(client), 'utf8'),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext].map((value) => value.toString('base64url')).join('.');
}

function decryptClientV1(value: string): OAuthClientInformationFull {
  const [ivRaw, tagRaw, bodyRaw] = value.split('.');
  if (!ivRaw || !tagRaw || !bodyRaw) throw new Error('oauth_client_metadata_malformed');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKeyV1(),
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(bodyRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8'),
  ) as OAuthClientInformationFull;
}

function hashCredentialV1(value: string): string {
  return crypto.createHash('sha256').update(`miorail-mcp-oauth-credential/v1:${value}`).digest('hex');
}

function credentialV1(kind: 'code' | 'access' | 'refresh'): { value: string; hash: string; id: string } {
  const id = crypto.randomUUID();
  const value = `miorail_oauth_${kind}_${crypto.randomBytes(32).toString('base64url')}`;
  return { value, hash: hashCredentialV1(value), id };
}

function isoV1(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function stringArrayV1(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value === 'string') {
    try {
      return stringArrayV1(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function tenantFromRequestV1(req: Request): { tenantId: string; walletAddress: `0x${string}` } | null {
  const user = req.session?.user;
  if (!user || user.chainId !== 8453 || !/^0x[0-9a-f]{40}$/.test(user.address)) return null;
  if (user.id !== `eip155:8453:${user.address}`) return null;
  return { tenantId: user.id, walletAddress: user.address };
}

function escapeHtmlV1(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function requestedScopesV1(scopes: string[] | undefined): string[] {
  const requested = scopes && scopes.length > 0 ? [...new Set(scopes)] : ['miorail:connected'];
  if (requested.some((scope) => !MCP_OAUTH_SCOPES_V1.includes(scope as never))) {
    throw new InvalidScopeError('Miorail supports only its connected MCP scope and refresh access.');
  }
  if (!requested.includes('miorail:connected')) {
    throw new InvalidScopeError('The miorail:connected scope is required.');
  }
  return requested;
}

function exactResourceV1(resource: URL | undefined): string {
  const expected = mcpOAuthResourceUrlV1().href;
  if (resource && resource.href !== expected) {
    throw new InvalidTargetError('The requested resource is not the Miorail private MCP endpoint.');
  }
  return expected;
}

const clientsStoreV1: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const rows = await sql`
      SELECT encrypted_metadata FROM mcp_oauth_clients WHERE client_id = ${clientId} LIMIT 1`;
    const encrypted = rows[0]?.encrypted_metadata;
    return typeof encrypted === 'string' ? decryptClientV1(encrypted) : undefined;
  },
  async registerClient(clientInfo) {
    // The SDK creates these fields before invoking this callback. Its public
    // store type nevertheless omits them, so retain the runtime values when
    // present and generate defensively for direct store callers.
    const supplied = clientInfo as typeof clientInfo & {
      client_id?: string;
      client_id_issued_at?: number;
    };
    const registered: OAuthClientInformationFull = {
      ...clientInfo,
      client_id: supplied.client_id ?? crypto.randomUUID(),
      client_id_issued_at: supplied.client_id_issued_at ?? Math.floor(Date.now() / 1000),
    };
    await sql`
      INSERT INTO mcp_oauth_clients (client_id, encrypted_metadata, created_at, updated_at)
      VALUES (${registered.client_id}, ${encryptClientV1(registered)}, now(), now())`;
    return registered;
  },
};

async function codeRowV1(clientId: string, code: string): Promise<Record<string, unknown>> {
  const rows = await sql`
    SELECT * FROM mcp_oauth_authorization_codes
    WHERE code_hash = ${hashCredentialV1(code)}
      AND client_id = ${clientId}
      AND consumed_at IS NULL
      AND expires_at > now()
    LIMIT 1`;
  if (!rows[0]) throw new InvalidGrantError('Authorization code is invalid, expired or already used.');
  return rows[0];
}

export const mcpOAuthProviderV1: OAuthServerProvider = {
  clientsStore: clientsStoreV1,

  async authorize(clientInfo, params: AuthorizationParams, res: Response): Promise<void> {
    const req = res.req as Request;
    const identity = tenantFromRequestV1(req);
    if (!identity) {
      res.status(401).type('html').send(
        '<!doctype html><html><body><h1>Sign in to Miorail first</h1><p>This authorization requires your existing wallet-authenticated Miorail session.</p><p><a href="/settings">Open Miorail Settings</a>, sign in, then retry the connection from your MCP client.</p></body></html>',
      );
      return;
    }
    const scopes = requestedScopesV1(params.scopes);
    const resource = exactResourceV1(params.resource);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = typeof body.decision === 'string' ? body.decision : null;
    const csrf = typeof body.consent_token === 'string' ? body.consent_token : null;
    const clientName = (clientInfo.client_name || clientInfo.client_id).slice(0, 120);

    if (req.method === 'POST' && decision === 'deny') {
      throw new AccessDeniedError('The user declined this Miorail connection.');
    }
    const sessionConsentToken = req.session.mcpOAuthConsentToken;
    const validConsentToken = Boolean(
      csrf &&
      sessionConsentToken &&
      Buffer.byteLength(csrf) === Buffer.byteLength(sessionConsentToken) &&
      crypto.timingSafeEqual(Buffer.from(csrf), Buffer.from(sessionConsentToken)),
    );
    if (
      req.method === 'POST' &&
      decision === 'allow' &&
      validConsentToken
    ) {
      delete req.session.mcpOAuthConsentToken;
      const code = credentialV1('code');
      const now = new Date();
      await sql`
        INSERT INTO mcp_oauth_authorization_codes (
          code_hash, client_id, tenant_id, wallet_address, redirect_uri,
          code_challenge, scopes, resource, expires_at, created_at
        ) VALUES (
          ${code.hash}, ${clientInfo.client_id}, ${identity.tenantId}, ${identity.walletAddress},
          ${params.redirectUri}, ${params.codeChallenge}, ${JSON.stringify(scopes)}::jsonb,
          ${resource}, ${new Date(now.getTime() + CODE_TTL_MS_V1)}, ${now}
        )`;
      const redirect = new URL(params.redirectUri);
      redirect.searchParams.set('code', code.value);
      if (params.state) redirect.searchParams.set('state', params.state);
      res.redirect(302, redirect.href);
      return;
    }

    const consentToken = crypto.randomBytes(24).toString('base64url');
    req.session.mcpOAuthConsentToken = consentToken;
    const hidden = [
      ['client_id', clientInfo.client_id],
      ['redirect_uri', params.redirectUri],
      ['response_type', 'code'],
      ['code_challenge', params.codeChallenge],
      ['code_challenge_method', 'S256'],
      ['scope', scopes.join(' ')],
      ['resource', resource],
      ['state', params.state ?? ''],
      ['consent_token', consentToken],
    ].map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtmlV1(value)}">`).join('');
    res.type('html').send(`<!doctype html><html><body><main><h1>Authorize ${escapeHtmlV1(clientName)}</h1><p>This connects the client to wallet ${escapeHtmlV1(identity.walletAddress)} on Base.</p><ul><li>Read your reviewed Miorail plans and measurements</li><li>Prepare unsigned calls for you to review and approve</li><li>Never sign or send a transaction</li></ul><p>Access tokens expire after 15 minutes. The durable grant expires after 30 days and can be revoked in Settings.</p><form method="post" action="/authorize">${hidden}<button name="decision" value="allow" type="submit">Authorize</button><button name="decision" value="deny" type="submit">Cancel</button></form></main></body></html>`);
  },

  async challengeForAuthorizationCode(clientInfo, authorizationCode) {
    const row = await codeRowV1(clientInfo.client_id, authorizationCode);
    return String(row.code_challenge);
  },

  async exchangeAuthorizationCode(clientInfo, authorizationCode, _codeVerifier, redirectUri, resource) {
    const row = await codeRowV1(clientInfo.client_id, authorizationCode);
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri does not match the authorization request.');
    const expectedResource = String(row.resource);
    if ((resource?.href ?? expectedResource) !== expectedResource) throw new InvalidGrantError('resource does not match the authorization request.');
    const access = credentialV1('access');
    const refresh = credentialV1('refresh');
    const grantId = `${MCP_OAUTH_GRANT_ID_PREFIX_V1}${crypto.randomUUID()}`;
    const now = new Date();
    const grantExpires = new Date(now.getTime() + GRANT_TTL_MS_V1);
    const accessExpires = new Date(now.getTime() + ACCESS_TTL_MS_V1);
    const scopes = stringArrayV1(row.scopes);
    const clientName = (clientInfo.client_name || clientInfo.client_id).slice(0, 120);
    const result = await sql`
      WITH consumed AS (
        UPDATE mcp_oauth_authorization_codes SET consumed_at = ${now}
        WHERE code_hash = ${hashCredentialV1(authorizationCode)}
          AND client_id = ${clientInfo.client_id}
          AND consumed_at IS NULL AND expires_at > ${now}
        RETURNING *
      ), grant_row AS (
        INSERT INTO mcp_oauth_grants (
          id, tenant_id, wallet_address, client_id, client_name, scopes, resource,
          created_at, expires_at, use_count
        ) SELECT ${grantId}, tenant_id, wallet_address, client_id, ${clientName}, scopes,
                 resource, ${now}, ${grantExpires}, 0 FROM consumed
        RETURNING id, client_id
      ), access_row AS (
        INSERT INTO mcp_oauth_tokens (token_hash, token_id, grant_id, client_id, kind, created_at, expires_at)
        SELECT ${access.hash}, ${access.id}, id, client_id, 'access', ${now}, ${accessExpires} FROM grant_row
        RETURNING grant_id
      ), refresh_row AS (
        INSERT INTO mcp_oauth_tokens (token_hash, token_id, grant_id, client_id, kind, created_at, expires_at)
        SELECT ${refresh.hash}, ${refresh.id}, id, client_id, 'refresh', ${now}, ${grantExpires} FROM grant_row
        RETURNING grant_id
      ) SELECT (SELECT count(*) FROM access_row)::int AS access_count,
               (SELECT count(*) FROM refresh_row)::int AS refresh_count`;
    if (Number(result[0]?.access_count ?? 0) !== 1 || Number(result[0]?.refresh_count ?? 0) !== 1) {
      throw new InvalidGrantError('Authorization code is invalid, expired or already used.');
    }
    return {
      access_token: access.value,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS_V1 / 1000),
      refresh_token: refresh.value,
      scope: scopes.join(' '),
    } satisfies OAuthTokens;
  },

  async exchangeRefreshToken(clientInfo, refreshToken, requestedScopes, resource) {
    const hash = hashCredentialV1(refreshToken);
    const rows = await sql`
      SELECT t.grant_id, g.scopes, g.resource, g.expires_at
      FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id = t.grant_id
      WHERE t.token_hash = ${hash} AND t.client_id = ${clientInfo.client_id}
        AND t.kind = 'refresh' AND t.revoked_at IS NULL AND t.expires_at > now()
        AND g.revoked_at IS NULL AND g.expires_at > now()
      LIMIT 1`;
    const current = rows[0];
    if (!current) throw new InvalidGrantError('Refresh token is invalid, expired or revoked.');
    const granted = stringArrayV1(current.scopes);
    const scopes = requestedScopes && requestedScopes.length > 0 ? [...new Set(requestedScopes)] : granted;
    if (scopes.some((scope) => !granted.includes(scope))) throw new InvalidScopeError('Requested scope exceeds the durable grant.');
    if ((resource?.href ?? String(current.resource)) !== String(current.resource)) throw new InvalidTargetError('resource does not match the durable grant.');
    const access = credentialV1('access');
    const refresh = credentialV1('refresh');
    const now = new Date();
    const accessExpires = new Date(now.getTime() + ACCESS_TTL_MS_V1);
    const grantExpires = new Date(String(current.expires_at));
    const result = await sql`
      WITH old_refresh AS (
        UPDATE mcp_oauth_tokens SET revoked_at = ${now}, last_used_at = ${now}
        WHERE token_hash = ${hash} AND client_id = ${clientInfo.client_id}
          AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > ${now}
          AND EXISTS (
            SELECT 1 FROM mcp_oauth_grants valid_grant
            WHERE valid_grant.id = mcp_oauth_tokens.grant_id
              AND valid_grant.revoked_at IS NULL
              AND valid_grant.expires_at > ${now}
          )
        RETURNING grant_id, client_id
      ), access_row AS (
        INSERT INTO mcp_oauth_tokens (token_hash, token_id, grant_id, client_id, kind, created_at, expires_at)
        SELECT ${access.hash}, ${access.id}, grant_id, client_id, 'access', ${now}, ${accessExpires} FROM old_refresh
        RETURNING grant_id
      ), refresh_row AS (
        INSERT INTO mcp_oauth_tokens (token_hash, token_id, grant_id, client_id, kind, created_at, expires_at)
        SELECT ${refresh.hash}, ${refresh.id}, grant_id, client_id, 'refresh', ${now}, ${grantExpires} FROM old_refresh
        RETURNING grant_id
      ) SELECT (SELECT count(*) FROM access_row)::int AS access_count,
               (SELECT count(*) FROM refresh_row)::int AS refresh_count`;
    if (Number(result[0]?.access_count ?? 0) !== 1 || Number(result[0]?.refresh_count ?? 0) !== 1) {
      throw new InvalidGrantError('Refresh token was already used.');
    }
    return {
      access_token: access.value,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS_V1 / 1000),
      refresh_token: refresh.value,
      scope: scopes.join(' '),
    } satisfies OAuthTokens;
  },

  async verifyAccessToken(token): Promise<AuthInfo> {
    const rows = await sql`
      SELECT t.token_id, t.client_id, t.expires_at AS token_expires_at,
             g.id AS grant_id, g.tenant_id, g.wallet_address, g.scopes, g.resource
      FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id = t.grant_id
      WHERE t.token_hash = ${hashCredentialV1(token)} AND t.kind = 'access'
        AND t.revoked_at IS NULL AND t.expires_at > now()
        AND g.revoked_at IS NULL AND g.expires_at > now()
      LIMIT 1`;
    const row = rows[0];
    if (!row) throw new InvalidTokenError('Access token is invalid, expired or revoked.');
    await sql`
      WITH touched AS (
        UPDATE mcp_oauth_tokens SET last_used_at = now() WHERE token_hash = ${hashCredentialV1(token)}
        RETURNING grant_id
      ) UPDATE mcp_oauth_grants SET last_used_at = now(), use_count = use_count + 1
        WHERE id IN (SELECT grant_id FROM touched)`;
    return {
      token: String(row.token_id),
      clientId: String(row.client_id),
      scopes: stringArrayV1(row.scopes),
      expiresAt: Math.floor(new Date(String(row.token_expires_at)).getTime() / 1000),
      resource: new URL(String(row.resource)),
      extra: {
        grantId: String(row.grant_id),
        tenantId: String(row.tenant_id),
        walletAddress: String(row.wallet_address),
        chainId: 8453,
      },
    };
  },

  async revokeToken(clientInfo, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = hashCredentialV1(request.token);
    await sql`
      WITH target AS (
        SELECT grant_id FROM mcp_oauth_tokens
        WHERE token_hash = ${hash} AND client_id = ${clientInfo.client_id}
      ), ended AS (
        UPDATE mcp_oauth_grants SET revoked_at = COALESCE(revoked_at, now())
        WHERE id IN (SELECT grant_id FROM target) RETURNING id
      ) UPDATE mcp_oauth_tokens SET revoked_at = COALESCE(revoked_at, now())
        WHERE grant_id IN (SELECT id FROM ended)`;
  },
};

export async function listMcpOAuthGrantsV1(tenantId: string): Promise<OAuthGrantRowV1[]> {
  const rows = await sql`
    SELECT id, tenant_id, wallet_address, client_id, client_name, scopes, resource,
           created_at, expires_at, last_used_at, use_count, revoked_at
    FROM mcp_oauth_grants WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC LIMIT 200`;
  return rows.map((row) => ({
    id: String(row.id), tenantId: String(row.tenant_id), walletAddress: String(row.wallet_address),
    clientId: String(row.client_id), clientName: String(row.client_name), scopes: stringArrayV1(row.scopes),
    resource: String(row.resource), createdAt: isoV1(row.created_at), expiresAt: isoV1(row.expires_at),
    lastUsedAt: row.last_used_at ? isoV1(row.last_used_at) : null,
    useCount: Number(row.use_count ?? 0), revokedAt: row.revoked_at ? isoV1(row.revoked_at) : null,
  }));
}

export async function revokeMcpOAuthGrantForTenantV1(input: { tenantId: string; grantId: string }): Promise<boolean> {
  const rows = await sql`
    WITH ended AS (
      UPDATE mcp_oauth_grants SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = ${input.grantId} AND tenant_id = ${input.tenantId}
      RETURNING id
    ), tokens AS (
      UPDATE mcp_oauth_tokens SET revoked_at = COALESCE(revoked_at, now())
      WHERE grant_id IN (SELECT id FROM ended) RETURNING grant_id
    ) SELECT count(*)::int AS count FROM ended`;
  return Number(rows[0]?.count ?? 0) === 1;
}
