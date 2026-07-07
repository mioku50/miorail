import { Router, type Request } from 'express';
import crypto from 'node:crypto';
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

export const mcpBaseRouter = Router();

export const mcpBaseRouteRuntime = {
  auth,
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

function configuredServerUrl(): URL | null {
  if (!baseMcpEnabledFromEnv()) return null;
  return baseMcpServerUrlFromEnv();
}

mcpBaseRouter.get('/connect', async (req, res, next) => {
  try {
    const serverUrl = configuredServerUrl();
    if (!serverUrl) {
      return res.status(400).json({ success: false, error: 'Base MCP is disabled or missing BASE_MCP_SERVER_URL' });
    }

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
  try {
    const serverUrl = configuredServerUrl();
    if (!serverUrl) {
      return res.status(400).json({ success: false, error: 'Base MCP is disabled or missing BASE_MCP_SERVER_URL' });
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state) {
      return res.status(400).json({ success: false, error: 'Missing OAuth code or state' });
    }

    const secret = sessionSecret();
    const pending = await loadBaseMcpOAuthState({ userId, sessionSecret: secret, state });
    if (!pending) {
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

    return res.redirect(redirectWithParam(pending.returnTo, 'mcp', 'connected'));
  } catch (error) {
    await markBaseMcpNeedsReauth({
      userId,
      error: error instanceof Error ? error.message : 'oauth_callback_failed',
    }).catch(() => undefined);
    next(error);
  }
});
