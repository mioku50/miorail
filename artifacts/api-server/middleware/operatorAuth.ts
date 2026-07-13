import type { NextFunction, Request, Response } from 'express';
import { tenantUserFromRequest } from './tenantAuth.js';

export function createRequireOperatorAuth(env: NodeJS.ProcessEnv = process.env) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (env.NODE_ENV === 'test') {
      next();
      return;
    }
    const admins = (env.OPERATOR_ADMIN_WALLETS || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const user = tenantUserFromRequest(req);
    if (env.ENABLE_OPERATOR_DIAGNOSTICS !== 'true' || !user || !admins.includes(user.address)) {
      res.status(403).json({ error: 'operator_access_required', code: 'operator_access_required' });
      return;
    }
    next();
  };
}

export const requireOperatorAuth = createRequireOperatorAuth();
