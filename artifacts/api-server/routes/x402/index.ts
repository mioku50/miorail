import { Router, Request, Response } from 'express';
import { x402Gateway, MockFacilitator } from '@mioagent/x402-gateway';
import { db, auditLogs } from '@mioagent/db';
import { eq, desc } from 'drizzle-orm';
import {
  X402LedgerResponseSchema,
  X402PricingResponseSchema,
} from '@mioagent/api-zod';

export const x402Router = Router();

const paymentRequired = {
  accepts: [
    {
      amount: '1000000', // 1 USDC
      payTo: '0x1234567890123456789012345678901234567890',
      asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', // USDC on Base Sepolia
      network: '84532', // Base Sepolia
    }
  ]
};

const facilitator = new MockFacilitator();
const gateway = x402Gateway({ paymentRequired, facilitator });

x402Router.get('/mock-paid-endpoint', gateway, (req: Request, res: Response) => {
  res.status(200).json({ data: 'This is premium mock data protected by x402 payment.' });
});

x402Router.get('/ledger', async (req: Request, res: Response, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const logs = await db.select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, userId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(100);

    let totalSpent = 0;
    let inferenceSpent = 0;
    let toolsSpent = 0;
    let inferenceCount = 0;
    let toolsCount = 0;

    const entries = logs.map(l => {
      const costVal = parseFloat(l.cost || '0');
      const isInference = l.actionType === 'inference_call' || l.actionType === 'portfolio_scan' || l.actionType === 'security_screening';
      if (!isNaN(costVal)) {
        totalSpent += costVal;
        if (isInference) {
          inferenceSpent += costVal;
          inferenceCount++;
        } else {
          toolsSpent += costVal;
          toolsCount++;
        }
      }
      return {
        id: l.id,
        actionId: l.actionId,
        actionType: l.actionType,
        cost: l.cost || null,
        txHash: l.txHash || null,
        createdAt: l.createdAt.toISOString(),
        settlement: 'estimated/audit-log',
        details: (l.details as Record<string, unknown>) || null,
      };
    });

    const response = {
      entries,
      summary: {
        totalSpentUsdc: totalSpent.toFixed(4),
        inferenceSpentUsdc: inferenceSpent.toFixed(4),
        toolsSpentUsdc: toolsSpent.toFixed(4),
        inferenceCallsCount: inferenceCount,
        toolsCallsCount: toolsCount,
        settlement: 'estimated/audit-log',
      },
    };

    res.json(X402LedgerResponseSchema.parse(response));
  } catch (error) {
    next(error);
  }
});

x402Router.get('/pricing', async (_req: Request, res: Response) => {
  const pricing = [
    { actionType: 'portfolio_scan', label: 'Portfolio Risk Scan', priceUsdc: '0.0010', description: 'Moralis token balance indexing and price feed valuation' },
    { actionType: 'security_screening', label: 'Token Security Screening', priceUsdc: '0.0020', description: 'GoPlus contract security checks and honeypot analysis' },
    { actionType: 'swap_execution', label: 'Swap Simulation & Routing', priceUsdc: '0.0050', description: 'EIP-5792 batch execution preparation and route optimization' },
    { actionType: 'inference_call', label: 'Autonomous AI Inference', priceUsdc: '0.0010', description: 'Agent LLM reasoning and intent classification' },
  ];
  res.json(X402PricingResponseSchema.parse({ pricing }));
});
