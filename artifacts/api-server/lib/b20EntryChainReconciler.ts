import { decodeEventLog, erc20Abi, type Hex } from 'viem';
import type { HashV1, TransactionReceiptV1 } from '@mioagent/route-domain';
import {
  RouteStorageConflictError,
  type B20EntryRouteProofRepositoryV1,
  type B20EntrySubmissionAttemptV1,
  type B20EntrySubmissionRepositoryV1,
  type B20PreparedEntryPlanV1,
} from '@mioagent/route-storage';
import {
  verifyTransactionReceiptsV1,
  type BaseReceiptReader,
  type VerifiedReceiptLogV1,
} from '@mioagent/route-proof';
import { reconcileAttemptV1, type WalletStatusReadingV1 } from './b20EntrySubmitRunner.js';
import { syncB20EntryRouteProofV1 } from './b20EntryRouteProof.js';

const TRANSFER_TOPIC_V1 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

interface TransferV1 {
  token: string;
  from: string;
  to: string;
  value: bigint;
}

function decodeTransfersV1(logs: readonly VerifiedReceiptLogV1[]): TransferV1[] {
  const transfers: TransferV1[] = [];
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC_V1) continue;
    try {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        eventName: 'Transfer',
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
      });
      transfers.push({
        token: log.address.toLowerCase(),
        from: decoded.args.from.toLowerCase(),
        to: decoded.args.to.toLowerCase(),
        value: decoded.args.value,
      });
    } catch {
      // Malformed and unrelated logs are not evidence. Skipping one can only
      // make reconciliation fail closed; it can never fabricate a movement.
    }
  }
  return transfers;
}

/** Reconstructs net ERC-20 movements relative to the authenticated wallet.
 * B20 outputs are arbitrary ERC-20s, so the generic trusted-asset swap
 * projector cannot be reused here. The inputs are still server-read receipts,
 * never provider JSON or calldata supplied by the browser. */
export function b20AssetChangesFromReceiptLogsV1(input: {
  walletAddress: string;
  logs: readonly VerifiedReceiptLogV1[];
}): WalletStatusReadingV1['assetChanges'] {
  const wallet = input.walletAddress.toLowerCase();
  const totals = new Map<string, { incoming: bigint; outgoing: bigint }>();
  for (const transfer of decodeTransfersV1(input.logs)) {
    const total = totals.get(transfer.token) ?? { incoming: 0n, outgoing: 0n };
    if (transfer.from === wallet) total.outgoing += transfer.value;
    if (transfer.to === wallet) total.incoming += transfer.value;
    totals.set(transfer.token, total);
  }
  const changes: NonNullable<WalletStatusReadingV1['assetChanges']> = [];
  for (const [token, total] of totals) {
    if (total.outgoing > total.incoming) {
      changes.push({ token, direction: 'out', amountAtomic: (total.outgoing - total.incoming).toString() });
      continue;
    }
    if (total.incoming > total.outgoing) {
      changes.push({
        token,
        direction: 'in',
        amountAtomic: (total.incoming - total.outgoing).toString(),
        counterparty: wallet,
      });
    }
  }
  return changes;
}

function normalizedHashesV1(hashes: readonly string[]): HashV1[] {
  return [...new Set(hashes.map((hash) => hash.toLowerCase()))]
    .filter((hash): hash is HashV1 => /^0x[0-9a-f]{64}$/.test(hash))
    .slice(0, 16);
}

function sameHashesV1(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

async function manualReviewV1(input: {
  submissions: B20EntrySubmissionRepositoryV1;
  proofs: B20EntryRouteProofRepositoryV1;
  plan: B20PreparedEntryPlanV1;
  attempt: B20EntrySubmissionAttemptV1;
  transactionHashes: HashV1[];
  receipts: TransactionReceiptV1[];
  errorCode: string;
  now: Date;
}): Promise<B20EntrySubmissionAttemptV1> {
  const updated = await input.submissions.updateAttempt({
    attemptId: input.attempt.id,
    tenantId: input.attempt.tenantId,
    status: 'terminal',
    terminalOutcome: 'reconciliation_required',
    transactionHashes: input.transactionHashes,
    receipts: input.receipts,
    errorCode: input.errorCode,
    now: input.now,
  });
  if (!updated) throw new RouteStorageConflictError('B20 reconciliation lost its submission attempt');
  await syncB20EntryRouteProofV1({
    repository: input.proofs,
    plan: input.plan,
    attempt: updated,
    now: input.now,
  });
  return updated;
}

/** One bounded, read-only reconciliation pass against Base. Transaction hashes
 * from wallet_getCallsStatus are lookup hints only. Receipt status, logs, gas
 * and block facts come from the env-configured server reader before the
 * canonical RouteProofV1 can leave pending. */
export async function reconcileB20EntryFromBaseV1(input: {
  reader: BaseReceiptReader;
  submissions: B20EntrySubmissionRepositoryV1;
  proofs: B20EntryRouteProofRepositoryV1;
  plan: B20PreparedEntryPlanV1;
  attempt: B20EntrySubmissionAttemptV1;
  transactionHashes: readonly string[];
  now: Date;
}): Promise<B20EntrySubmissionAttemptV1> {
  if (!input.attempt.batchId || input.attempt.status === 'awaiting_wallet_approval') {
    throw new RouteStorageConflictError('B20 reconciliation requires a submitted wallet batch');
  }
  if (input.attempt.status === 'terminal') {
    await syncB20EntryRouteProofV1({
      repository: input.proofs,
      plan: input.plan,
      attempt: input.attempt,
      now: input.now,
    });
    return input.attempt;
  }

  const supplied = normalizedHashesV1(input.transactionHashes);
  const stored = normalizedHashesV1(input.attempt.transactionHashes);
  if (stored.length > 0 && supplied.length > 0 && !sameHashesV1(stored, supplied)) {
    throw new RouteStorageConflictError('B20 transaction hashes cannot be replaced after reconciliation starts');
  }
  const transactionHashes = stored.length > 0 ? stored : supplied;
  if (transactionHashes.length === 0) return input.attempt;

  const verifications = await verifyTransactionReceiptsV1({
    transactionHashes,
    existingReceipts: input.attempt.receipts,
    reader: input.reader,
  });
  const receipts = verifications.map((verification) => verification.receipt);
  if (verifications.some((verification) => verification.conflict)) {
    return manualReviewV1({ ...input, transactionHashes, receipts, errorCode: 'receipt_status_conflict' });
  }

  const unavailable = verifications.some((verification) => !verification.source);
  if (unavailable) {
    return reconcileAttemptV1({
      submissions: input.submissions,
      proofs: input.proofs,
      plan: input.plan,
      attempt: input.attempt,
      reading: {
        status: 'unavailable',
        assetChanges: null,
        transactionHashes,
        blockNumber: null,
        receipts,
      },
      attempts: 0,
      now: input.now,
    });
  }
  const success = verifications.filter((verification) => verification.receipt.status === 'success');
  const reverted = verifications.filter((verification) => verification.receipt.status === 'reverted');
  if (success.length > 0 && reverted.length > 0) {
    return manualReviewV1({ ...input, transactionHashes, receipts, errorCode: 'non_atomic_batch_result' });
  }
  const blockNumber = verifications
    .map((verification) => verification.source!.blockNumber)
    .reduce((highest, current) => current > highest ? current : highest, 0n)
    .toString();
  const logs = success.flatMap((verification) => verification.source!.logs);
  const reading: WalletStatusReadingV1 = reverted.length > 0
    ? { status: 'reverted', assetChanges: null, transactionHashes, blockNumber, receipts }
    : {
        status: 'confirmed',
        assetChanges: b20AssetChangesFromReceiptLogsV1({ walletAddress: input.plan.walletAddress, logs }),
        transactionHashes,
        blockNumber,
        receipts,
      };
  return reconcileAttemptV1({
    submissions: input.submissions,
    proofs: input.proofs,
    plan: input.plan,
    attempt: input.attempt,
    reading,
    attempts: 0,
    now: input.now,
  });
}
