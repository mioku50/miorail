import { Router, Request, Response } from 'express';
import {
  createX402MiddlewareFromEnv,
  x402ConfigFromEnv,
  type X402SettlementRecord,
} from '@mioagent/x402-gateway';
import { db, auditLogs, x402Receipts } from '@mioagent/db';
import { eq, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  X402LedgerResponseSchema,
  X402PricingResponseSchema,
} from '@mioagent/api-zod';

export const x402Router = Router();

function receiptId(record: X402SettlementRecord): string {
  if (record.txHash) return `x402:${record.network}:${record.txHash}`;
  return `x402:${randomUUID()}`;
}

async function persistSettlement(record: X402SettlementRecord): Promise<void> {
  const id = receiptId(record);
  const receipt = {
    ...record,
    id,
    userId: record.userId || 'default-user',
  };
  try {
    await db.insert(x402Receipts).values({
      id,
      receipt,
      updatedAt: new Date(),
    });
  } catch (error) {
    // Duplicate tx hashes should not turn a successful paid response into a
    // user-visible failure. The facilitator remains source of truth.
    console.warn('[x402] failed to persist settlement record', {
      code: error instanceof Error ? error.name : 'unknown_error',
    });
  }
}

const gateway = createX402MiddlewareFromEnv({
  routePath: '/mock-paid-endpoint',
  serviceName: 'Miorail',
  onSettlement: persistSettlement,
});

x402Router.get('/mock-paid-endpoint', gateway, (req: Request, res: Response) => {
  res.status(200).json({ data: 'This is premium mock data protected by x402 payment.' });
});

function receiptRecord(row: { id: string; receipt: unknown; createdAt: Date }): X402SettlementRecord & {
  id: string;
  createdAt: Date;
  userId?: string;
} {
  const receipt = row.receipt && typeof row.receipt === 'object' ? row.receipt as Record<string, unknown> : {};
  return {
    id: String(receipt.id || row.id),
    userId: typeof receipt.userId === 'string' ? receipt.userId : undefined,
    actionId: typeof receipt.actionId === 'string' ? receipt.actionId : undefined,
    actionType: typeof receipt.actionType === 'string' ? receipt.actionType : undefined,
    cost: typeof receipt.cost === 'string' ? receipt.cost : null,
    txHash: typeof receipt.txHash === 'string' ? receipt.txHash : null,
    network: typeof receipt.network === 'string' ? receipt.network : '',
    asset: typeof receipt.asset === 'string' ? receipt.asset : '',
    amount: typeof receipt.amount === 'string' ? receipt.amount : '0',
    payTo: typeof receipt.payTo === 'string' ? receipt.payTo : '',
    payer: typeof receipt.payer === 'string' ? receipt.payer : undefined,
    status: receipt.status === 'pending' || receipt.status === 'failed' ? receipt.status : 'settled',
    attribution: receipt.attribution && typeof receipt.attribution === 'object' ? receipt.attribution as any : {},
    checkedAt: typeof receipt.checkedAt === 'string' ? receipt.checkedAt : row.createdAt.toISOString(),
    source: receipt.source === 'mock' ? 'mock' : 'x402-facilitator',
    errorReason: typeof receipt.errorReason === 'string' ? receipt.errorReason : undefined,
    errorMessage: typeof receipt.errorMessage === 'string' ? receipt.errorMessage : undefined,
    createdAt: row.createdAt,
  };
}

function atomicUsdcToDecimal(amount: string): string {
  try {
    const value = BigInt(amount || '0');
    const units = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return fraction ? `${units}.${fraction}` : units.toString();
  } catch {
    return '0';
  }
}

x402Router.get('/ledger', async (req: Request, res: Response, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const rows = await db.select()
      .from(x402Receipts)
      .orderBy(desc(x402Receipts.createdAt))
      .limit(100);
    const records = rows
      .map(receiptRecord)
      .filter((record) => !record.userId || record.userId === userId);
    const auditContext = await db.select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, userId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(100);
    const auditByActionId = new Map(auditContext.map((log) => [log.actionId, log]));

    let totalSpent = 0;
    let inferenceSpent = 0;
    let toolsSpent = 0;
    let inferenceCount = 0;
    let toolsCount = 0;

    const entries = records.map(record => {
      const audit = record.actionId ? auditByActionId.get(record.actionId) : undefined;
      const actionType = record.actionType || audit?.actionType || 'x402_resource';
      const cost = record.cost || atomicUsdcToDecimal(record.amount);
      const costVal = parseFloat(cost || '0');
      const isInference = actionType === 'inference_call' || actionType === 'portfolio_scan' || actionType === 'security_screening';
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
        id: record.id,
        actionId: record.actionId || audit?.actionId || record.id,
        actionType,
        cost,
        txHash: record.txHash,
        network: record.network,
        asset: record.asset,
        amount: record.amount,
        payTo: record.payTo,
        status: record.status,
        attribution: record.attribution,
        createdAt: record.createdAt.toISOString(),
        settlement: record.status,
        details: {
          source: record.source,
          payer: record.payer,
          checkedAt: record.checkedAt,
          errorReason: record.errorReason,
          audit: audit?.details || null,
        },
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
        settlement: entries.length > 0 ? 'real' : 'none',
        x402: x402ConfigFromEnv().status,
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
