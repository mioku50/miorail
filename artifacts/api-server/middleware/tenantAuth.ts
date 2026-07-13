import type { NextFunction, Request, Response } from 'express';

export const BASE_CHAIN_ID = 8453 as const;
export const DEV_SINGLE_USER_ID = 'default-user';

export type TenantUser = {
  id: string;
  address: `0x${string}`;
  chainId: typeof BASE_CHAIN_ID;
};

declare module 'express-session' {
  interface SessionData {
    user?: TenantUser;
    walletAuthChallenge?: {
      address: `0x${string}`;
      nonce: string;
      domain: string;
      uri: string;
      message: string;
      expiresAt: string;
    };
  }
}

function envFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function isDevSingleUserEnabled(): boolean {
  return process.env.NODE_ENV === 'test' || envFlag(process.env.DEV_SINGLE_USER);
}

function configuredDevTenant(): { id: string; address: `0x${string}` } | null {
  if (process.env.NODE_ENV !== 'test' || process.env.MIOAGENT_TEST_SUITE !== 'db') return null;
  const id = process.env.MIOAGENT_TEST_TENANT_ID?.trim();
  const address = process.env.MIOAGENT_TEST_WALLET?.trim().toLowerCase();
  if (!id || !process.env.MIOAGENT_TEST_RUN_ID || !id.includes(process.env.MIOAGENT_TEST_RUN_ID)) return null;
  if (!/^0x[0-9a-f]{40}$/.test(address || '')) return null;
  return { id, address: address as `0x${string}` };
}

function validSessionUser(user: TenantUser | undefined): user is TenantUser {
  if (!user || user.chainId !== BASE_CHAIN_ID || !/^0x[0-9a-f]{40}$/.test(user.address)) return false;
  return user.id === `eip155:${BASE_CHAIN_ID}:${user.address}`;
}

export function tenantUserFromRequest(req: Request): TenantUser | null {
  if (validSessionUser(req.session?.user)) return req.session.user;
  if (!isDevSingleUserEnabled()) return null;

  const testTenant = configuredDevTenant();
  if (testTenant) return { ...testTenant, chainId: BASE_CHAIN_ID };

  const configuredAddress = process.env.DEV_SINGLE_USER_WALLET?.toLowerCase();
  const address = /^0x[0-9a-f]{40}$/.test(configuredAddress || '')
    ? configuredAddress as `0x${string}`
    : '0x0000000000000000000000000000000000000000';
  return { id: DEV_SINGLE_USER_ID, address, chainId: BASE_CHAIN_ID };
}

export function tenantUserId(req: Request): string {
  const user = tenantUserFromRequest(req);
  if (!user) throw new Error('authenticated_tenant_required');
  return user.id;
}

export function tenantWalletAddress(req: Request): `0x${string}` {
  const user = tenantUserFromRequest(req);
  if (!user) throw new Error('authenticated_tenant_required');
  if (user.id === DEV_SINGLE_USER_ID || user.id === process.env.MIOAGENT_TEST_TENANT_ID) {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const query = req.query as Record<string, unknown>;
    const candidate = suppliedString(body.walletAddress)
      || suppliedString(query.walletAddress)
      || suppliedString(query.address);
    if (candidate && /^0x[0-9a-fA-F]{40}$/.test(candidate)) return candidate.toLowerCase() as `0x${string}`;
  }
  return user.address;
}

export function requireTenant(req: Request, res: Response, next: NextFunction): void {
  if (!tenantUserFromRequest(req)) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  next();
}

function suppliedString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return null;
}

/** Reject tenant identifiers supplied by the client and bind wallet parameters to the signed session. */
export function enforceTenantBinding(req: Request, res: Response, next: NextFunction): void {
  const user = tenantUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }

  // Test/dev single-user compatibility is explicit and never active in production by default.
  if (user.id === DEV_SINGLE_USER_ID || user.id === process.env.MIOAGENT_TEST_TENANT_ID) {
    next();
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const query = req.query as Record<string, unknown>;
  if (suppliedString(body.userId) || suppliedString(query.userId)) {
    res.status(403).json({ error: 'client_user_id_forbidden', code: 'client_user_id_forbidden' });
    return;
  }

  const walletCandidates = [
    suppliedString(body.walletAddress),
    suppliedString(query.walletAddress),
    suppliedString(query.address),
    suppliedString(body.owner),
    suppliedString(query.owner),
    suppliedString(body.subscriptionPayer),
  ].filter((value): value is string => Boolean(value));
  if (walletCandidates.some((address) => address.toLowerCase() !== user.address)) {
    res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
    return;
  }
  next();
}
