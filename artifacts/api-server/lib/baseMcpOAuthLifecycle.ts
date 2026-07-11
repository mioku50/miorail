import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  createBaseMcpOAuthProviderForUser,
  getBaseMcpAuthStatus,
  loadBaseMcpTokens,
  markBaseMcpNeedsReauth,
} from './baseMcpOAuthStore.js';

export type BaseMcpRefreshErrorCode =
  | 'expired_token'
  | 'refresh_failed'
  | 'credentials_invalid';

export type BaseMcpRefreshResult =
  | { status: 'fresh' }
  | { status: 'refreshed' }
  | { status: 'needs_reauth'; errorCode: BaseMcpRefreshErrorCode };

const refreshLocks = new Map<string, Promise<BaseMcpRefreshResult>>();

export const baseMcpOAuthLifecycleRuntime = {
  now: () => Date.now(),
  auth,
  getAuthStatus: getBaseMcpAuthStatus,
  loadTokens: loadBaseMcpTokens,
  markNeedsReauth: markBaseMcpNeedsReauth,
  createProvider: createBaseMcpOAuthProviderForUser,
};

function refreshWindowMs(): number {
  const parsed = Number(process.env.BASE_MCP_REFRESH_SKEW_MS || 5 * 60 * 1000);
  if (!Number.isFinite(parsed) || parsed < 0) return 5 * 60 * 1000;
  return Math.min(parsed, 30 * 60 * 1000);
}

function classifyRefreshError(error: unknown): BaseMcpRefreshErrorCode {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error || '');
  if (/authenticate data|decrypt|decipher|credential/i.test(message)) return 'credentials_invalid';
  return 'refresh_failed';
}

function hasRefreshToken(tokens: OAuthTokens | undefined): boolean {
  return typeof tokens?.refresh_token === 'string' && tokens.refresh_token.trim().length > 0;
}

async function refreshUnlocked(input: {
  userId: string;
  sessionSecret: string;
  redirectUrl: string;
  serverUrl: URL;
}): Promise<BaseMcpRefreshResult> {
  const status = await baseMcpOAuthLifecycleRuntime.getAuthStatus(input.userId);
  if (!status.connected) {
    return {
      status: 'needs_reauth',
      errorCode: status.expired ? 'expired_token' : 'credentials_invalid',
    };
  }

  const expiresAt = status.expiresAt ? Date.parse(status.expiresAt) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(expiresAt) || expiresAt > baseMcpOAuthLifecycleRuntime.now() + refreshWindowMs()) {
    return { status: 'fresh' };
  }

  let tokens: OAuthTokens | undefined;
  try {
    tokens = await baseMcpOAuthLifecycleRuntime.loadTokens({
      userId: input.userId,
      sessionSecret: input.sessionSecret,
    });
  } catch (error) {
    const errorCode = classifyRefreshError(error);
    await baseMcpOAuthLifecycleRuntime.markNeedsReauth({ userId: input.userId, error: errorCode });
    return { status: 'needs_reauth', errorCode };
  }

  if (!hasRefreshToken(tokens)) {
    await baseMcpOAuthLifecycleRuntime.markNeedsReauth({ userId: input.userId, error: 'expired_token' });
    return { status: 'needs_reauth', errorCode: 'expired_token' };
  }

  try {
    const provider = baseMcpOAuthLifecycleRuntime.createProvider({
      userId: input.userId,
      sessionSecret: input.sessionSecret,
      redirectUrl: input.redirectUrl,
    });
    const result = await baseMcpOAuthLifecycleRuntime.auth(provider, { serverUrl: input.serverUrl });
    if (result !== 'AUTHORIZED') throw new Error('refresh_did_not_authorize');
    return { status: 'refreshed' };
  } catch (error) {
    const errorCode = classifyRefreshError(error);
    await baseMcpOAuthLifecycleRuntime.markNeedsReauth({ userId: input.userId, error: errorCode });
    return { status: 'needs_reauth', errorCode };
  }
}

export function refreshBaseMcpOAuthIfNeeded(input: {
  userId: string;
  sessionSecret: string;
  redirectUrl: string;
  serverUrl: URL;
}): Promise<BaseMcpRefreshResult> {
  const existing = refreshLocks.get(input.userId);
  if (existing) return existing;

  const pending = refreshUnlocked(input).finally(() => {
    if (refreshLocks.get(input.userId) === pending) refreshLocks.delete(input.userId);
  });
  refreshLocks.set(input.userId, pending);
  return pending;
}

export function clearBaseMcpRefreshLocksForTests(): void {
  refreshLocks.clear();
}
