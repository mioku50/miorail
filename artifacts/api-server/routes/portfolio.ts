import { Router } from 'express';
import { createToolAggregatorForUser } from '@mioagent/tools';
import { PortfolioResponseSchema } from '@mioagent/api-zod';

export const portfolioRouter = Router();

portfolioRouter.get('/', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const address = (req as { session?: { user?: { address?: string } } }).session?.user?.address;

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

    const isSepolia = process.env.CHAIN_ENV === 'sepolia';
    const toolName = isSepolia ? 'sepolia_get_balance' : 'get_balance';
    
    const tool = aggregator.findTool(toolName);
    let balanceFormatted = '0.00';
    let balance = '0';

    if (tool) {
      const toolResult = await aggregator.callTool(toolName, { address });
      if (toolResult && toolResult.content) {
        try {
          const parsed = JSON.parse(toolResult.content);
          if (parsed.balanceWei) {
             balance = parsed.balanceWei;
             balanceFormatted = (Number(balance) / 1e18).toFixed(4);
          }
        } catch {
          // ignore
        }
      }
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
      updatedAt: new Date().toISOString()
    }));

  } catch (error) {
    next(error);
  }
});
