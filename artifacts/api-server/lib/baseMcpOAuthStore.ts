import { db, users, baseMcpOauthStates, baseMcpOauthTokens } from '@mioagent/db';
import { createHmac, decrypt, deriveKey, encrypt } from '@mioagent/crypto';
import { BaseMcpOAuthProvider } from '@mioagent/mcp';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { and, eq } from 'drizzle-orm';

const PROVIDER = 'base-mcp';
const OAUTH_SALT = 'base-mcp-oauth-v1';
const STATE_TTL_MS = 10 * 60 * 1000;

export interface StoredBaseMcpAuthStatus {
  connected: boolean;
  needsReauth: boolean;
  userScoped: true;
  expired?: boolean;
  expiresAt?: string;
  connectedAt?: string;
}

export interface PendingOAuthState {
  state: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: Date;
}

export const baseMcpOAuthStoreRuntime = {
  db,
};

function tokenRowId(userId: string): string {
  return `${userId}:${PROVIDER}`;
}

function keyFromSecret(sessionSecret: string): Buffer {
  return deriveKey(sessionSecret, OAUTH_SALT);
}

function encryptJson(value: unknown, sessionSecret: string): string {
  return encrypt(JSON.stringify(value), keyFromSecret(sessionSecret));
}

function decryptJson<T>(value: string | null | undefined, sessionSecret: string): T | undefined {
  if (!value) return undefined;
  return JSON.parse(decrypt(value, keyFromSecret(sessionSecret))) as T;
}

function stateHash(state: string, sessionSecret: string): string {
  return createHmac(state, sessionSecret);
}

async function ensureUser(userId: string): Promise<void> {
  await baseMcpOAuthStoreRuntime.db
    .insert(users)
    .values({ id: userId, updatedAt: new Date() })
    .onConflictDoNothing();
}

export function sanitizeReturnTo(input?: string | null): string {
  const fallback = '/base-mcp';
  if (!input) return fallback;
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('://')) return fallback;
  return input;
}

export async function saveBaseMcpOAuthState(input: {
  userId: string;
  sessionSecret: string;
  state: string;
  codeVerifier: string;
  returnTo?: string | null;
  expiresAt?: Date;
}): Promise<void> {
  await ensureUser(input.userId);
  await baseMcpOAuthStoreRuntime.db
    .insert(baseMcpOauthStates)
    .values({
      stateHash: stateHash(input.state, input.sessionSecret),
      userId: input.userId,
      encryptedCodeVerifier: encrypt(input.codeVerifier, keyFromSecret(input.sessionSecret)),
      returnTo: sanitizeReturnTo(input.returnTo),
      expiresAt: input.expiresAt || new Date(Date.now() + STATE_TTL_MS),
    })
    .onConflictDoUpdate({
      target: baseMcpOauthStates.stateHash,
      set: {
        encryptedCodeVerifier: encrypt(input.codeVerifier, keyFromSecret(input.sessionSecret)),
        returnTo: sanitizeReturnTo(input.returnTo),
        expiresAt: input.expiresAt || new Date(Date.now() + STATE_TTL_MS),
      },
    });
}

export async function loadBaseMcpOAuthState(input: {
  userId: string;
  sessionSecret: string;
  state: string;
}): Promise<PendingOAuthState | null> {
  const rows = await baseMcpOAuthStoreRuntime.db
    .select()
    .from(baseMcpOauthStates)
    .where(and(
      eq(baseMcpOauthStates.stateHash, stateHash(input.state, input.sessionSecret)),
      eq(baseMcpOauthStates.userId, input.userId),
    ));
  const row = rows[0];
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return {
    state: input.state,
    codeVerifier: decrypt(row.encryptedCodeVerifier, keyFromSecret(input.sessionSecret)),
    returnTo: sanitizeReturnTo(row.returnTo),
    expiresAt: row.expiresAt,
  };
}

export async function deleteBaseMcpOAuthState(input: {
  userId: string;
  sessionSecret: string;
  state: string;
}): Promise<void> {
  await baseMcpOAuthStoreRuntime.db
    .delete(baseMcpOauthStates)
    .where(and(
      eq(baseMcpOauthStates.stateHash, stateHash(input.state, input.sessionSecret)),
      eq(baseMcpOauthStates.userId, input.userId),
    ));
}

export async function saveBaseMcpClientInformation(input: {
  userId: string;
  sessionSecret: string;
  clientInformation: OAuthClientInformationMixed;
}): Promise<void> {
  await ensureUser(input.userId);
  const encryptedClientInfo = encryptJson(input.clientInformation, input.sessionSecret);
  await baseMcpOAuthStoreRuntime.db
    .insert(baseMcpOauthTokens)
    .values({
      id: tokenRowId(input.userId),
      userId: input.userId,
      provider: PROVIDER,
      encryptedClientInfo,
      status: 'pending',
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: baseMcpOauthTokens.id,
      set: { encryptedClientInfo, updatedAt: new Date() },
    });
}

export async function loadBaseMcpClientInformation(input: {
  userId: string;
  sessionSecret: string;
}): Promise<OAuthClientInformationMixed | undefined> {
  const rows = await baseMcpOAuthStoreRuntime.db
    .select()
    .from(baseMcpOauthTokens)
    .where(eq(baseMcpOauthTokens.id, tokenRowId(input.userId)));
  return decryptJson<OAuthClientInformationMixed>(rows[0]?.encryptedClientInfo, input.sessionSecret);
}

export async function saveBaseMcpDiscoveryState(input: {
  userId: string;
  sessionSecret: string;
  discoveryState: OAuthDiscoveryState;
}): Promise<void> {
  await ensureUser(input.userId);
  const encryptedDiscoveryState = encryptJson(input.discoveryState, input.sessionSecret);
  await baseMcpOAuthStoreRuntime.db
    .insert(baseMcpOauthTokens)
    .values({
      id: tokenRowId(input.userId),
      userId: input.userId,
      provider: PROVIDER,
      encryptedDiscoveryState,
      status: 'pending',
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: baseMcpOauthTokens.id,
      set: { encryptedDiscoveryState, updatedAt: new Date() },
    });
}

export async function loadBaseMcpDiscoveryState(input: {
  userId: string;
  sessionSecret: string;
}): Promise<OAuthDiscoveryState | undefined> {
  const rows = await baseMcpOAuthStoreRuntime.db
    .select()
    .from(baseMcpOauthTokens)
    .where(eq(baseMcpOauthTokens.id, tokenRowId(input.userId)));
  return decryptJson<OAuthDiscoveryState>(rows[0]?.encryptedDiscoveryState, input.sessionSecret);
}

export async function saveBaseMcpTokens(input: {
  userId: string;
  sessionSecret: string;
  tokens: OAuthTokens;
}): Promise<void> {
  await ensureUser(input.userId);
  const now = new Date();
  const tokenExpiresAt = input.tokens.expires_in
    ? new Date(now.getTime() + input.tokens.expires_in * 1000)
    : null;
  const encryptedTokens = encryptJson(input.tokens, input.sessionSecret);
  await baseMcpOAuthStoreRuntime.db
    .insert(baseMcpOauthTokens)
    .values({
      id: tokenRowId(input.userId),
      userId: input.userId,
      provider: PROVIDER,
      encryptedTokens,
      tokenExpiresAt,
      status: 'connected',
      lastError: null,
      connectedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: baseMcpOauthTokens.id,
      set: {
        encryptedTokens,
        tokenExpiresAt,
        status: 'connected',
        lastError: null,
        connectedAt: now,
        updatedAt: now,
      },
    });
}

export async function loadBaseMcpTokens(input: {
  userId: string;
  sessionSecret: string;
}): Promise<OAuthTokens | undefined> {
  const rows = await baseMcpOAuthStoreRuntime.db
    .select()
    .from(baseMcpOauthTokens)
    .where(eq(baseMcpOauthTokens.id, tokenRowId(input.userId)));
  return decryptJson<OAuthTokens>(rows[0]?.encryptedTokens, input.sessionSecret);
}

export async function markBaseMcpNeedsReauth(input: {
  userId: string;
  error?: string;
}): Promise<void> {
  await ensureUser(input.userId);
  await baseMcpOAuthStoreRuntime.db
    .insert(baseMcpOauthTokens)
    .values({
      id: tokenRowId(input.userId),
      userId: input.userId,
      provider: PROVIDER,
      status: 'needs_reauth',
      lastError: input.error || 'reauthorization_required',
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: baseMcpOauthTokens.id,
      set: {
        status: 'needs_reauth',
        lastError: input.error || 'reauthorization_required',
        updatedAt: new Date(),
      },
    });
}

export async function clearBaseMcpCredentialScope(input: {
  userId: string;
  scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery';
}): Promise<void> {
  if (input.scope === 'verifier') return;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.scope === 'all' || input.scope === 'tokens') {
    set.encryptedTokens = null;
    set.tokenExpiresAt = null;
    set.status = 'needs_reauth';
    set.lastError = 'token_invalidated';
  }
  if (input.scope === 'all' || input.scope === 'client') {
    set.encryptedClientInfo = null;
  }
  if (input.scope === 'all' || input.scope === 'discovery') {
    set.encryptedDiscoveryState = null;
  }
  await baseMcpOAuthStoreRuntime.db
    .update(baseMcpOauthTokens)
    .set(set)
    .where(eq(baseMcpOauthTokens.id, tokenRowId(input.userId)));
}

export async function getBaseMcpAuthStatus(userId: string): Promise<StoredBaseMcpAuthStatus> {
  const rows = await baseMcpOAuthStoreRuntime.db
    .select()
    .from(baseMcpOauthTokens)
    .where(eq(baseMcpOauthTokens.id, tokenRowId(userId)));
  const row = rows[0];
  const expired = row?.tokenExpiresAt ? row.tokenExpiresAt.getTime() <= Date.now() : false;
  return {
    connected: row?.status === 'connected',
    needsReauth: row?.status === 'needs_reauth',
    userScoped: true,
    ...(row?.tokenExpiresAt ? { expired } : {}),
    expiresAt: row?.tokenExpiresAt ? row.tokenExpiresAt.toISOString() : undefined,
    connectedAt: row?.connectedAt ? row.connectedAt.toISOString() : undefined,
  };
}

export function createBaseMcpOAuthProviderForUser(input: {
  userId: string;
  sessionSecret: string;
  redirectUrl: string;
  state?: string;
  returnTo?: string | null;
  onRedirectToAuthorization?: (authorizationUrl: URL) => void | Promise<void>;
}): BaseMcpOAuthProvider {
  return new BaseMcpOAuthProvider({
    redirectUrl: input.redirectUrl,
    clientName: 'Miorail',
    state: input.state,
    onRedirectToAuthorization: input.onRedirectToAuthorization,
    loadClientInformation: () => loadBaseMcpClientInformation(input),
    saveClientInformation: (clientInformation) => saveBaseMcpClientInformation({ ...input, clientInformation }),
    loadTokens: () => loadBaseMcpTokens(input),
    saveTokens: (tokens) => saveBaseMcpTokens({ ...input, tokens }),
    loadCodeVerifier: async () => {
      const state = input.state;
      if (!state) return undefined;
      return (await loadBaseMcpOAuthState({ userId: input.userId, sessionSecret: input.sessionSecret, state }))?.codeVerifier;
    },
    saveCodeVerifier: async (codeVerifier) => {
      const state = input.state;
      if (!state) throw new Error('OAuth state is required before saving a code verifier');
      await saveBaseMcpOAuthState({
        ...input,
        state,
        codeVerifier,
        returnTo: input.returnTo,
      });
    },
    loadDiscoveryState: () => loadBaseMcpDiscoveryState(input),
    saveDiscoveryState: (discoveryState) => saveBaseMcpDiscoveryState({ ...input, discoveryState }),
    invalidateCredentials: (scope) => clearBaseMcpCredentialScope({ userId: input.userId, scope }),
  });
}
