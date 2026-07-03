import { Router } from 'express';
import { ApprovalsResponseSchema } from '@mioagent/api-zod';
import { fetchInternalApprovals } from '../lib/portfolioAnalysis.js';

export const approvalsRouter = Router();

approvalsRouter.get('/', async (req, res, next) => {
  try {
    const address = (req.query.address as string) || (req as { session?: { user?: { address?: string } } }).session?.user?.address;

    if (!address) {
      return res.status(400).json({ error: 'Wallet address not configured' });
    }

    const chainEnv = process.env.CHAIN_ENV || 'sepolia';
    const approvalsData = await fetchInternalApprovals(address, chainEnv);

    res.json(ApprovalsResponseSchema.parse(approvalsData));
  } catch (error) {
    next(error);
  }
});
