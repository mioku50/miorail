import type { Request, Response } from 'express';

import { tenantUserFromRequest } from '../middleware/tenantAuth';

/** A wallet proven by a real sign-in. The development single user — the zero
 * address, under test or DEV_SINGLE_USER — is not one: nothing personal is
 * ever joined to, or read for, a wallet nobody signed for. Answers 401 itself
 * and returns null when there is none. */
export function sessionWalletV1(req: Request, res: Response): string | null {
  const user = tenantUserFromRequest(req);
  const wallet = typeof user?.address === 'string' ? user.address.toLowerCase() : '';
  if (!/^0x[0-9a-f]{40}$/.test(wallet) || user?.id !== `eip155:8453:${wallet}` || /^0x0{40}$/.test(wallet)) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return null;
  }
  return wallet;
}
