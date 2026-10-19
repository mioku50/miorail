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

/** What a transaction asked for, as the chain records it. */
export interface BaseTransactionSourceV1 {
  from: string;
  to: string | null;
  value: bigint;
  input: string;
}

export interface BaseChainReaderV1 extends BaseReceiptReader {
  /** Null when the transaction cannot be read, never a guess. */
  getTransaction(hash: HashV1): Promise<BaseTransactionSourceV1 | null>;
}

export function createViemBaseReceiptReader(): BaseChainReaderV1 {
  const publicClient = createPublicClient({ chain: base, transport: http(baseRpcUrl()) });
  return {
    async getTransaction(hash: HashV1): Promise<BaseTransactionSourceV1 | null> {
      try {
        const transaction = await publicClient.getTransaction({ hash: hash as Hash });
        return {
          from: transaction.from.toLowerCase(),
          to: transaction.to ? transaction.to.toLowerCase() : null,
          value: transaction.value,
          input: transaction.input.toLowerCase(),
        };
      } catch {
        return null;
      }
    },
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
        from: receipt.from.toLowerCase(),
      };
    },
  };
}
