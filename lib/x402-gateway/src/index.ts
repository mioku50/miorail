import { Request, Response, NextFunction } from 'express';
import { X402PaymentRequired } from '@mioagent/x402-parser';

export interface X402GatewayConfig {
  paymentRequired: X402PaymentRequired;
  facilitator: X402Facilitator;
}

export interface X402Facilitator {
  verifyReceipt(receipt: string, requiredAmount: string): Promise<boolean>;
}

export class MockFacilitator implements X402Facilitator {
  private usedReceipts = new Set<string>();

  async verifyReceipt(receipt: string, requiredAmount: string): Promise<boolean> {
    if (!receipt) return false;

    // Anti-replay
    if (this.usedReceipts.has(receipt)) {
      return false;
    }

    // Simplistic mock validation based on receipt string contents
    if (receipt.includes('valid-receipt') && receipt.includes(`amount:${requiredAmount}`)) {
      this.usedReceipts.add(receipt);
      return true;
    }

    return false;
  }
}

export function x402Gateway(config: X402GatewayConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const paymentHeader = req.headers['x-402-payment'];

    if (!paymentHeader) {
      res.setHeader('Payment-Required', JSON.stringify(config.paymentRequired));
      res.status(402).json({ error: 'Payment Required', paymentRequired: config.paymentRequired });
      return;
    }

    try {
      const payment = JSON.parse(Buffer.from(paymentHeader as string, 'base64').toString());

      if (!payment.receipt) {
         res.status(400).json({ error: 'Invalid X-402-Payment header: missing receipt' });
         return;
      }

      const requiredAmount = config.paymentRequired.accepts[0].amount;

      const isValid = await config.facilitator.verifyReceipt(payment.receipt, requiredAmount);

      if (!isValid) {
        res.status(402).json({ error: 'Payment Required: Invalid or used receipt', paymentRequired: config.paymentRequired });
        return;
      }

      next();
    } catch {
      res.status(400).json({ error: 'Invalid X-402-Payment header' });
    }
  };
}
