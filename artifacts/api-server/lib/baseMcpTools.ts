import type { Request } from 'express';
import { createToolAggregatorForUser } from '@mioagent/tools';
import {
  baseMcpEnabledFromEnv,
  baseMcpServerUrlFromEnv,
} from './baseMcpStatus.js';
import { createBaseMcpOAuthProviderForUser } from './baseMcpOAuthStore.js';

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

export async function createApiToolAggregatorForUser(req: Request, userId: string, sessionSecret: string) {
  const enabled = baseMcpEnabledFromEnv();
  const serverUrl = baseMcpServerUrlFromEnv();
  const oauthProvider = enabled && serverUrl
    ? createBaseMcpOAuthProviderForUser({
        userId,
        sessionSecret,
        redirectUrl: callbackUrl(req),
      })
    : undefined;

  return createToolAggregatorForUser(userId, sessionSecret, {
    baseMcpEnabled: enabled,
    baseMcpServerUrl: serverUrl?.toString(),
    baseMcpOAuthProvider: oauthProvider,
  });
}
