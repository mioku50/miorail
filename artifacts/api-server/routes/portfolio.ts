import { Router } from 'express';
import { createToolAggregatorForUser } from '@mioagent/tools';
import { PortfolioResponseSchema } from '@mioagent/api-zod';

export const portfolioRouter = Router();

portfolioRouter.get('/', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const address = (req.query.address as string) || (req as { session?: { user?: { address?: string } } }).session?.user?.address;

    if (!address) {
      return res.json(PortfolioResponseSchema.parse({
        tokens: [],
        updatedAt: new Date().toISOString()
      }));
    }

    let aggregator;
    try {
      const sessionSecret = process.env.SESSION_SECRET;
      if (!sessionSecret) {
        return res.status(500).json({ error: 'Missing SESSION_SECRET configuration' });
      }
      aggregator = await createToolAggregatorForUser(userId, sessionSecret);
    } catch {
      return res.json(PortfolioResponseSchema.parse({
        tokens: [],
        updatedAt: new Date().toISOString()
      }));
    }

    const chainEnv = process.env.CHAIN_ENV || 'sepolia';
    let balanceFormatted = '0.00';
    let balance = '0';

    const rpcUrl = chainEnv === 'sepolia' ? process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org' : process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';

    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getBalance',
          params: [address, 'latest']
        })
      });
      const data = await res.json();
      if (!data.error && data.result) {
        balance = BigInt(data.result).toString();
        balanceFormatted = (Number(balance) / 1e18).toFixed(4);
      }
    } catch {
      // Ignore errors and fallback to 0
    }

    res.json(PortfolioResponseSchema.parse({
      totalUsdValue: '0.00',
      tokens: [
        {
          symbol: 'ETH',
          address: 'native',
          balance,
          balanceFormatted,
          usdValue: '0.00'
        }
      ],
      updatedAt: new Date().toISOString(),
      providerStatus: 'Token balances provider not configured'
    }));

  } catch (error) {
    next(error);
  }
});
