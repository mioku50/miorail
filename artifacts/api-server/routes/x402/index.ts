import { Router, Request, Response } from 'express';

export const x402Router = Router();

x402Router.get('/mock-paid-endpoint', (req: Request, res: Response) => {
  const paymentHeader = req.headers['x-402-payment'];

  if (!paymentHeader) {
    const paymentRequired = {
      accepts: [
        {
          amount: '1000000', // 1 USDC
          payTo: '0x1234567890123456789012345678901234567890',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
          network: '8453', // Base Mainnet
        }
      ]
    };

    res.setHeader('Payment-Required', JSON.stringify(paymentRequired));
    res.status(402).json({ error: 'Payment Required', paymentRequired });
    return;
  }

  // Very simple mock validation
  try {
    const payment = JSON.parse(Buffer.from(paymentHeader as string, 'base64').toString());

    if (!payment.receipt) {
        throw new Error('Invalid payment receipt');
    }

    res.status(200).json({ data: 'This is premium mock data protected by x402 payment.' });
  } catch {
    res.status(400).json({ error: 'Invalid X-402-Payment header' });
  }
});
