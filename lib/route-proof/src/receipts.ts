import type { HashV1, TransactionReceiptV1 } from '@mioagent/route-domain';

// T58: receipt verification. `BaseReceiptReader` is an injected seam — the
// api-server wraps a real viem publicClient behind it (env-configured RPC
// URL, never request data); tests use hand-written mock readers. A `null`
// return means the receipt is not (yet) available onchain — that NEVER
// becomes a fabricated `success`; it maps to the honest `unknown` status.

export interface VerifiedReceiptLogV1 {
  address: string;
  topics: readonly string[];
  data: string;
}

/** Ground-truth receipt data read directly from the chain. `status` is only
 * ever `success` | `reverted` — an unavailable receipt is `null`, never a
 * third in-between status here (that mapping happens one layer up). */
export interface VerifiedReceiptSourceV1 {
  transactionHash: HashV1;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPriceWei: bigint | null;
  logs: readonly VerifiedReceiptLogV1[];
}

export interface BaseReceiptReader {
  getTransactionReceipt(hash: HashV1): Promise<VerifiedReceiptSourceV1 | null>;
}

export class RouteProofReceiptIntegrityError extends Error {
  readonly code = 'route_proof_receipt_integrity';
}

export interface ReceiptConflictV1 {
  previousStatus: TransactionReceiptV1['status'];
  nextStatus: TransactionReceiptV1['status'];
}

export interface ReceiptVerificationOutcomeV1 {
  transactionHash: HashV1;
  /** Strict TransactionReceiptV1 shape, ready to persist on the proof. */
  receipt: TransactionReceiptV1;
  /** Present only when the chain returned a real (non-null) receipt. */
  source: VerifiedReceiptSourceV1 | null;
  /** Set when a PREVIOUSLY verified (non-`unknown`) receipt for this hash
   * disagrees with the freshly verified status — fail closed. */
  conflict: ReceiptConflictV1 | null;
}

/** Verifies every transaction hash on the proof against the injected reader,
 * one request per hash, no internal retries/polling (per-request bounded).
 * Conflicts against a previously VERIFIED receipt (not a wallet-hint
 * `unknown` placeholder) are flagged, never silently overwritten. */
export async function verifyTransactionReceiptsV1(input: {
  transactionHashes: readonly HashV1[];
  existingReceipts: readonly TransactionReceiptV1[];
  reader: BaseReceiptReader;
}): Promise<ReceiptVerificationOutcomeV1[]> {
  const { transactionHashes, existingReceipts, reader } = input;
  const existingByHash = new Map(existingReceipts.map((receipt) => [receipt.transactionHash, receipt]));
  const results: ReceiptVerificationOutcomeV1[] = [];

  for (const transactionHash of transactionHashes) {
    const source = await reader.getTransactionReceipt(transactionHash);
    if (!source) {
      results.push({
        transactionHash,
        receipt: { transactionHash, status: 'unknown', blockNumber: null, gasUsed: null },
        source: null,
        conflict: null,
      });
      continue;
    }
    if (source.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) {
      throw new RouteProofReceiptIntegrityError(
        `Receipt reader returned a mismatched transaction hash for ${transactionHash}`,
      );
    }
    const receipt: TransactionReceiptV1 = {
      transactionHash,
      status: source.status,
      blockNumber: source.blockNumber.toString(),
      gasUsed: source.gasUsed.toString(),
    };
    const existing = existingByHash.get(transactionHash);
    const conflict: ReceiptConflictV1 | null =
      existing && existing.status !== 'unknown' && existing.status !== receipt.status
        ? { previousStatus: existing.status, nextStatus: receipt.status }
        : null;
    results.push({ transactionHash, receipt, source, conflict });
  }

  return results;
}
