import { Router } from 'express';
import { readAaveV4PositionV1, AaveV4PositionV1Schema } from '@mioagent/rwa-issuer/aaveV4';
import { sessionWalletV1 } from '../lib/sessionWallet.js';
import { logger } from '@mioagent/utils';

export const aavePositionRuntimeV1 = { read: readAaveV4PositionV1 };
export const aavePositionRouter = Router();

// The session proves the wallet. There is no caller-selected account or chain,
// no transaction builder and no automatic read as part of wallet balances.
aavePositionRouter.get('/position', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  if (Object.keys(req.query).length > 0) {
    res.status(400).json({ code: 'aave_v4_position_input_invalid' });
    return;
  }
  try {
    const result = AaveV4PositionV1Schema.parse(await aavePositionRuntimeV1.read(wallet));
    if (result.walletAddress !== wallet) throw new Error('aave_v4_position_wallet_mismatch');
    res.json(result);
  } catch {
    // Upstream errors can contain URLs or echoed request fields. Publish only
    // our fixed code, and never turn a failed read into an empty position.
    logger.warn('Aave position read failed', { code: 'aave_v4_position_unread' });
    res.status(503).json({ code: 'aave_v4_position_unread' });
  }
});
