import { Router } from 'express';
import { PortfolioResponseSchema } from '@mioagent/api-zod';
import { analyzePortfolioForRisk, fetchInternalPortfolio } from '../lib/portfolioAnalysis.js';
import { tenantWalletAddress } from '../middleware/tenantAuth';

export const portfolioRouter = Router();

function queryFlag(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(queryFlag);
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'y'].includes(value.trim().toLowerCase());
}

portfolioRouter.get('/', async (req, res, next) => {
  try {
    const address = tenantWalletAddress(req);
    if (address === '0x0000000000000000000000000000000000000000') {
      return res.status(400).json({ error: 'Wallet address not configured' });
    }

    const chainEnv = (req.query.chainEnv as string) || process.env.CHAIN_ENV || 'sepolia';
    const includeApprovals = queryFlag(req.query.includeApprovals);
    const portfolio = await fetchInternalPortfolio(address, chainEnv, { includeApprovals });
    const analysis = analyzePortfolioForRisk(portfolio, address, chainEnv);

    res.json(PortfolioResponseSchema.parse({
      ...portfolio,
      analysis: {
        ...analysis,
        providerContext: {
          ...(portfolio.providerContext || {}),
          ...(analysis.providerContext || {}),
        },
        totalTokens: analysis.totalTokens ?? portfolio.tokens.length,
        approvalSummary: portfolio.approvalSummary,
        approvals: includeApprovals ? (portfolio.approvals || []) : undefined,
        approvalFindings: includeApprovals ? (portfolio.approvalFindings || analysis.approvalFindings || []) : undefined,
      },
    }));
  } catch (error) {
    next(error);
  }
});
