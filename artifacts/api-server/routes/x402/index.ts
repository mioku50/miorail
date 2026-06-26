import { Router, Request, Response } from 'express';
import { x402Gateway, MockFacilitator } from '@mioagent/x402-gateway';

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
