import type { X402PaymentRequired } from '@mioagent/x402-parser';
import type { X402Facilitator } from './index.js';

/** Deterministic facilitator kept outside the production package entrypoint. */
export class MockFacilitator implements X402Facilitator {
  private usedReceipts = new Set<string>();

  async verifyReceipt(receipt: string, requiredAmount: string): Promise<boolean> {
    if (!receipt || this.usedReceipts.has(receipt)) return false;
    if (!receipt.includes('valid-receipt') || !receipt.includes(`amount:${requiredAmount}`)) return false;
    this.usedReceipts.add(receipt);
    return true;
  }
}

export function testPaymentRequired(): X402PaymentRequired {
  return {
    accepts: [{
      amount: '1000000',
      payTo: '0x1234567890123456789012345678901234567890',
      asset: '0x036cbd53842c5426634e7929541ec2318f3dCF7e',
      network: '84532',
    }],
  };
}
