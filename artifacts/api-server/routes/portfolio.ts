import { Router } from 'express';
import { PortfolioResponseSchema } from '@mioagent/api-zod';
import { fetchInternalPortfolio } from '../lib/portfolioAnalysis.js';

export const portfolioRouter = Router();

portfolioRouter.get('/', async (req, res, next) => {
  try {
    const address = (req.query.address as string) || (req as { session?: { user?: { address?: string } } }).session?.user?.address;

    if (!address) {
      return res.status(400).json({ error: 'Wallet address not configured' });
    }

    const chainEnv = process.env.CHAIN_ENV || 'sepolia';
    const portfolio = await fetchInternalPortfolio(address, chainEnv);

    res.json(PortfolioResponseSchema.parse(portfolio));
  } catch (error) {
    next(error);
  }
});
