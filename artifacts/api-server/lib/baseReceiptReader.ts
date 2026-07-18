import { createPublicClient, http, type Hash } from 'viem';
import { base } from 'viem/chains';
import type { BaseReceiptReader, VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import type { HashV1 } from '@mioagent/route-domain';

// T58: the ONLY server-side chain-read seam for Route Proof reconciliation.
// The RPC URL comes exclusively from the server environment — NEVER from
// request data — and the reader is injected into the reconciler so tests
// always use mock readers (no live RPC in tests). Read-only: the server
// never signs or broadcasts through this client.

function baseRpcUrl(): string {
  return (
    process.env.BASE_MAINNET_RPC_URL ||
    process.env.BASE_RPC_URL ||
    'https://mainnet.base.org'
  );
}

export function createViemBaseReceiptReader(): BaseReceiptReader {
  const publicClient = createPublicClient({ chain: base, transport: http(baseRpcUrl()) });
  return {
    async getTransactionReceipt(hash: HashV1): Promise<VerifiedReceiptSourceV1 | null> {
      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: hash as Hash });
      } catch {
        // Not found / transport failure — honestly unavailable, never a
        // fabricated status. The reconciler maps null to `unknown`.
        return null;
      }
      if (receipt.status !== 'success' && receipt.status !== 'reverted') return null;
      return {
        transactionHash: (receipt.transactionHash as string).toLowerCase() as HashV1,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        effectiveGasPriceWei: receipt.effectiveGasPrice ?? null,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics as readonly string[],
          data: log.data,
        })),
      };
    },
  };
}
