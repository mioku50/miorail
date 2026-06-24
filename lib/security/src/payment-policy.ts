import type { X402PaymentOption, X402PaymentRequired } from '@workspace/x402-parser';

export interface PaymentReceipt {
  amount: string;
  payTo: string;
  asset: string;
  network: string;
  txHash: string;
}

export class PaymentPolicy {
  constructor(
    private readonly acceptedAssets: string[],
    private readonly acceptedNetworks: string[]
  ) {}

  isValidPayment(receipt: PaymentReceipt, requirement: X402PaymentRequired): boolean {
    if (!this.acceptedAssets.includes(receipt.asset.toLowerCase())) {
      return false;
    }

    if (!this.acceptedNetworks.includes(receipt.network)) {
      return false;
    }

    // Find a matching option
    const matchingOption = requirement.accepts.find((opt) => {
      return opt.asset.toLowerCase() === receipt.asset.toLowerCase() &&
             opt.network === receipt.network &&
             opt.payTo.toLowerCase() === receipt.payTo.toLowerCase();
    });

    if (!matchingOption) {
      return false;
    }

    // Basic amount check (assuming string amounts can be converted to BigInt for exact or larger match)
    try {
      const paidAmount = BigInt(receipt.amount);
      const requiredAmount = BigInt(matchingOption.amount);
      if (paidAmount < requiredAmount) {
        return false;
      }
    } catch {
      return false; // If amount parsing fails, reject
    }

    return true;
  }
}

export class ApprovalGuard {
  constructor(private readonly policy: PaymentPolicy) {}

  verifyOrThrow(receipt: PaymentReceipt | null | undefined, requirement: X402PaymentRequired): void {
    if (!receipt) {
      throw new Error('Payment required: No receipt provided');
    }

    if (!this.policy.isValidPayment(receipt, requirement)) {
      throw new Error('Payment required: Invalid or insufficient payment receipt');
    }
  }
}
