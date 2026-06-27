import { Router } from 'express';

export const portfolioRouter = Router();

// TODO: Implement real Base Sepolia integration
// This endpoint is a placeholder. Returning 501 Not Implemented
// to avoid presenting hardcoded mock balances as live Sepolia data.
portfolioRouter.get('/', (req, res) => {
  res.status(501).json({ error: 'Portfolio integration coming soon' });
});
