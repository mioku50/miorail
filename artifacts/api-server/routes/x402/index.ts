import { Router, Request, Response } from 'express';
import { x402Gateway, MockFacilitator } from '@mioagent/x402-gateway';

export const x402Router = Router();

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

const facilitator = new MockFacilitator();
const gateway = x402Gateway({ paymentRequired, facilitator });

x402Router.get('/mock-paid-endpoint', gateway, (req: Request, res: Response) => {
  res.status(200).json({ data: 'This is premium mock data protected by x402 payment.' });
});
