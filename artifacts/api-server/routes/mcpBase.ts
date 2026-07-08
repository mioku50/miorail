import { Router, type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { logger } from '@mioagent/utils';
import { BaseMcpToolProbeResponseSchema } from '@mioagent/api-zod';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  baseMcpEnabledFromEnv,
  baseMcpServerUrlFromEnv,
} from '../lib/baseMcpStatus.js';
import {
  createBaseMcpOAuthProviderForUser,
  deleteBaseMcpOAuthState,
  loadBaseMcpOAuthState,
  markBaseMcpNeedsReauth,
  sanitizeReturnTo,
} from '../lib/baseMcpOAuthStore.js';
import { probeBaseMcpTools } from '../lib/baseMcpToolProbe.js';

export const mcpBaseRouter = Router();

export const mcpBaseRouteRuntime = {
  auth,
  logger,
  probeBaseMcpTools,
};

function userIdFromRequest(req: Request): string {
  return (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('Missing SESSION_SECRET configuration');
  return secret;
}

function publicOrigin(req: Request): string {
  const fromEnv = (process.env.PUBLIC_API_BASE_URL || process.env.API_PUBLIC_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol || 'http';
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0]?.trim();
  const host = forwardedHost || req.get('host') || 'localhost:3000';
  return `${proto}://${host}`;
}

function callbackUrl(req: Request): string {
  return `${publicOrigin(req)}/api/mcp/base/callback`;
}

function redirectWithParam(path: string, key: string, value: string): string {
  const safePath = sanitizeReturnTo(path);
  const url = new URL(safePath, 'http://local');
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

function requiredConnectConfig(): { serverUrl: URL | null; missingConfig: string[] } {
  const missingConfig: string[] = [];
  const serverUrl = baseMcpServerUrlFromEnv();

  if (!baseMcpEnabledFromEnv()) missingConfig.push('BASE_MCP_ENABLED');
  if (!serverUrl) missingConfig.push('BASE_MCP_SERVER_URL');
  if (!(process.env.SESSION_SECRET || '').trim()) missingConfig.push('SESSION_SECRET');

  return { serverUrl, missingConfig };
}

function sendMissingConfig(res: Response, missingConfig: string[]) {
  return res.status(400).json({
    success: false,
    error: 'missing_config',
    missing_config: missingConfig,
  });
}

function safeOAuthErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/cancel|access_denied/i.test(message)) return 'oauth_cancelled';
  if (/timeout|abort/i.test(message)) return 'oauth_timeout';
  if (/state/i.test(message)) return 'invalid_state';
  if (/refresh/i.test(message)) return 'refresh_failed';
  if (/unauthori[sz]ed|auth/i.test(message)) return 'authorization_failed';
  return 'oauth_failed';
}

function logOAuthEvent(
  level: 'info' | 'warn',
  event: 'base-mcp-oauth-started' | 'base-mcp-oauth-callback-success' | 'base-mcp-oauth-callback-failed',
  meta: Record<string, unknown>,
) {
  mcpBaseRouteRuntime.logger[level](event, {
    event,
    provider: 'base-mcp',
    ...meta,
  });
}

mcpBaseRouter.get('/connect', async (req, res, next) => {
  try {
    const { serverUrl, missingConfig } = requiredConnectConfig();
    if (missingConfig.length || !serverUrl) return sendMissingConfig(res, missingConfig);

    const userId = userIdFromRequest(req);
    const secret = sessionSecret();
    const state = crypto.randomBytes(32).toString('base64url');
    const returnTo = sanitizeReturnTo(typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined);
    let authorizationUrl: string | null = null;

    const provider = createBaseMcpOAuthProviderForUser({
      userId,
      sessionSecret: secret,
      redirectUrl: callbackUrl(req),
      state,
      returnTo,
      onRedirectToAuthorization: (url) => {
        authorizationUrl = url.toString();
      },
    });

    logOAuthEvent('info', 'base-mcp-oauth-started', {
      userId,
      endpointHost: serverUrl.host,
      returnTo,
    });
    await mcpBaseRouteRuntime.auth(provider, { serverUrl });
    if (authorizationUrl) {
      return res.redirect(authorizationUrl);
    }

    return res.redirect(redirectWithParam(returnTo, 'mcp', 'connected'));
  } catch (error) {
    next(error);
  }
});

mcpBaseRouter.get('/callback', async (req, res, next) => {
  const userId = userIdFromRequest(req);
  let pending: Awaited<ReturnType<typeof loadBaseMcpOAuthState>> = null;
  let serverUrl: URL | null = null;
  try {
    const config = requiredConnectConfig();
    serverUrl = config.serverUrl;
    if (config.missingConfig.length || !serverUrl) return sendMissingConfig(res, config.missingConfig);

    const secret = sessionSecret();
    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (errorParam) {
      if (state) pending = await loadBaseMcpOAuthState({ userId, sessionSecret: secret, state });
      if (pending) await deleteBaseMcpOAuthState({ userId, sessionSecret: secret, state });
      await markBaseMcpNeedsReauth({ userId, error: 'oauth_cancelled' });
      logOAuthEvent('warn', 'base-mcp-oauth-callback-failed', {
        userId,
        endpointHost: serverUrl.host,
        errorCode: 'oauth_cancelled',
      });
      return res.redirect(redirectWithParam(pending?.returnTo || '/base-mcp', 'mcp', 'cancelled'));
    }

    if (!code || !state) {
      logOAuthEvent('warn', 'base-mcp-oauth-callback-failed', {
        userId,
        endpointHost: serverUrl.host,
        errorCode: 'missing_code_or_state',
      });
      return res.status(400).json({ success: false, error: 'Missing OAuth code or state' });
    }

    pending = await loadBaseMcpOAuthState({ userId, sessionSecret: secret, state });
    if (!pending) {
      logOAuthEvent('warn', 'base-mcp-oauth-callback-failed', {
        userId,
        endpointHost: serverUrl.host,
        errorCode: 'invalid_or_expired_state',
      });
      return res.status(400).json({ success: false, error: 'Invalid or expired OAuth state' });
    }

    const provider = createBaseMcpOAuthProviderForUser({
      userId,
      sessionSecret: secret,
      redirectUrl: callbackUrl(req),
      state,
      returnTo: pending.returnTo,
    });

    await mcpBaseRouteRuntime.auth(provider, {
      serverUrl,
      authorizationCode: code,
    });
    await deleteBaseMcpOAuthState({ userId, sessionSecret: secret, state });

    logOAuthEvent('info', 'base-mcp-oauth-callback-success', {
      userId,
      endpointHost: serverUrl.host,
    });
    return res.redirect(redirectWithParam(pending.returnTo, 'mcp', 'connected'));
  } catch (error) {
    const errorCode = safeOAuthErrorCode(error);
    await markBaseMcpNeedsReauth({
      userId,
      error: errorCode,
    }).catch(() => undefined);
    if (pending) {
      const state = pending.state;
      const secret = process.env.SESSION_SECRET;
      if (secret) {
        await deleteBaseMcpOAuthState({ userId, sessionSecret: secret, state }).catch(() => undefined);
      }
      logOAuthEvent('warn', 'base-mcp-oauth-callback-failed', {
        userId,
        endpointHost: serverUrl?.host,
        errorCode,
      });
      return res.redirect(redirectWithParam(pending.returnTo, 'mcp', 'error'));
    }
    logOAuthEvent('warn', 'base-mcp-oauth-callback-failed', {
      userId,
      endpointHost: serverUrl?.host,
      errorCode,
    });
    next(error);
  }
});

async function handleToolsProbe(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = userIdFromRequest(req);
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      return res.json(BaseMcpToolProbeResponseSchema.parse({
        status: 'degraded',
        endpointHost: baseMcpServerUrlFromEnv()?.host,
        toolsCount: 0,
        tools: [],
        checkedAt: new Date().toISOString(),
        errorCode: 'missing_config',
      }));
    }

    const result = await mcpBaseRouteRuntime.probeBaseMcpTools({
      userId,
      sessionSecret: secret,
      redirectUrl: callbackUrl(req),
    });
    return res.json(BaseMcpToolProbeResponseSchema.parse(result));
  } catch (error) {
    next(error);
  }
}

mcpBaseRouter.get('/tools', handleToolsProbe);
mcpBaseRouter.get('/probe', handleToolsProbe);
