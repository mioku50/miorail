import { X402PaymentRequired } from '@mioagent/x402-parser';
import { db } from '@mioagent/db';
import { x402Receipts } from '@mioagent/db/schema';
import { eq } from 'drizzle-orm';

export interface X402Receipt {
  id: string;
  amount: string;
  payTo: string;
  asset: string;
  network: string;
  [key: string]: unknown;
}

export interface PaymentGatewayOptions {
  paymentRequired: X402PaymentRequired;
}

export class X402Gateway {
  private paymentRequired: X402PaymentRequired;

  constructor(options: PaymentGatewayOptions) {
    this.paymentRequired = options.paymentRequired;
  }

  getPaymentRequirements(): X402PaymentRequired {
    return this.paymentRequired;
  }

  async verifyPayment(paymentHeader: string | undefined): Promise<{ isValid: boolean; error?: string }> {
    if (!paymentHeader) {
      return { isValid: false, error: 'Payment header missing' };
    }

    try {
      const decodedStr = Buffer.from(paymentHeader, 'base64').toString('utf-8');
      const paymentData = JSON.parse(decodedStr);

      const receipt = paymentData.receipt as X402Receipt | undefined;

      if (!receipt || !receipt.id) {
        return { isValid: false, error: 'Invalid payment receipt' };
      }

      // Check against requirements
      const isValidAmount = this.paymentRequired.accepts.some(option =>
        option.amount === receipt.amount &&
        option.payTo === receipt.payTo &&
        option.asset === receipt.asset &&
        option.network === receipt.network
      );

      if (!isValidAmount) {
         return { isValid: false, error: 'Payment does not match requirements' };
      }

      // Check anti-replay
      const existing = await db.select().from(x402Receipts).where(eq(x402Receipts.id, receipt.id)).limit(1);

      if (existing.length > 0) {
        return { isValid: false, error: 'Payment receipt has already been used' };
      }

      // Store receipt to prevent replay
      await db.insert(x402Receipts).values({
        id: receipt.id,
        receipt: receipt as Record<string, unknown>
      });

      return { isValid: true };
    } catch (err) {
      return { isValid: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
