import { Request, Response, NextFunction } from 'express';
import { X402Gateway } from './gateway.js';
import { X402PaymentRequired } from '@mioagent/x402-parser';

export interface X402GatewayOptions {
  paymentRequired: X402PaymentRequired;
}

export function x402GatewayMiddleware(options: X402GatewayOptions) {
  const gateway = new X402Gateway({ paymentRequired: options.paymentRequired });

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const paymentHeader = req.headers['x-402-payment'] as string | undefined;

    if (!paymentHeader) {
      const requirements = gateway.getPaymentRequirements();
      res.setHeader('Payment-Required', JSON.stringify(requirements));
      res.status(402).json({ error: 'Payment Required', paymentRequired: requirements });
      return;
    }

    try {
      const { isValid, error } = await gateway.verifyPayment(paymentHeader);

      if (!isValid) {
         res.status(400).json({ error: error || 'Invalid X-402-Payment header' });
         return;
      }

      // Payment verified and receipt consumed
      next();
    } catch (err) {
      res.status(500).json({ error: 'Internal server error verifying payment' });
    }
  };
}
