import type { HashV1 } from '@mioagent/route-domain';
import type { RouteStorageRepository } from '@mioagent/route-storage';
import { recordBlueprintSubmissionV1, routeProofIdV1 } from '@mioagent/transaction-composer';

// This is the Base Account SDK's public, read-only wallet RPC. The caller
// supplies no URL. A wallet response supplies lookup hints, never proof.
const WALLET_STATUS_RPC_V1 = 'https://rpc.wallet.coinbase.com';
const MAX_RESPONSE_BYTES_V1 = 128 * 1024;

export async function readBaseWalletBatchHashesV1(
  batchId: string,
  fetcher: typeof fetch = fetch,
): Promise<HashV1[] | null> {
  try {
    const response = await fetcher(WALLET_STATUS_RPC_V1, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'wallet_getCallsStatus', params: [batchId] }),
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_RESPONSE_BYTES_V1) { await reader.cancel(); return null; }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = reply?.result;
    if (reply?.error || reply?.id !== 1 || result?.id !== batchId || result?.chainId !== '0x2105'
      || !Number.isInteger(result?.status) || result.status < 200
      || !Array.isArray(result.receipts) || result.receipts.length === 0 || result.receipts.length > 16) return null;
    // Refuse the whole answer rather than silently dropping a malformed leg.
    if (result.receipts.some((receipt: { transactionHash?: unknown } | null) =>
      typeof receipt?.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash))) return null;
    return [...new Set<HashV1>(result.receipts.map((receipt: { transactionHash: string }) =>
      receipt.transactionHash.toLowerCase() as HashV1))];
  } catch { return null; }
}

interface StockExecutionReadInputV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  routeRunId: string;
  blueprintId: string;
  refresh: boolean;
}

interface StockExecutionReadDependenciesV1 {
  repository: RouteStorageRepository;
  readBatchHashes: (batchId: string) => Promise<HashV1[] | null>;
  reconcile: (input: { tenantId: string; walletAddress: `0x${string}`; routeRunId: string;
    routeProofId: string; now: Date }) => Promise<unknown>;
  now: () => Date;
}

/** Complete the already-submitted stock action, without preparing or sending
 * anything. Only a stored, owned batch is resolved. Only the existing chain
 * reconciler can finalize the proof, including for an approval-only receipt.
 * Expired quotes do not prevent verifying a transaction already sent. */
export async function refreshStockExecutionV1(
  deps: StockExecutionReadDependenciesV1,
  input: StockExecutionReadInputV1,
): Promise<{ batchId: string | null } | null> {
  const { repository } = deps;
  const proofId = routeProofIdV1(input.blueprintId);
  const proof = await repository.getProofProjection(proofId, input.tenantId);
  if (!proof || proof.chainId !== 8453 || proof.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) return null;
  const run = await repository.getRouteRun(input.routeRunId, input.tenantId);
  if (!run || run.chainId !== 8453 || run.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) return null;
  const stored = (await repository.listBlueprints(input.routeRunId, input.tenantId))
    .find((entry) => entry.blueprint.id === input.blueprintId);
  if (!stored || stored.blueprint.status !== 'approved' || stored.blueprint.blueprintHash !== proof.blueprintHash
    || stored.blueprint.approvedCallsHash !== proof.approvedCallsHash) return null;
  const events = await repository.listProofEvents(proofId, input.tenantId);
  if (events.some((event, index) => event.eventIndex !== index
    || event.previousEventHash !== (index === 0 ? null : events[index - 1]!.eventHash))) {
    throw new Error('Stock execution history requires verification');
  }
  const batches = [...new Set(events.filter((event) => event.eventType === 'submitted')
    .map((event) => event.payload.batchId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 2000))];
  // Conflicting submission history requires a person, never a guess.
  const batchId = batches.length === 1 ? batches[0]! : null;
  if (!input.refresh || !batchId || proof.finalStatus !== 'pending') return { batchId };

  if (proof.transactionHashes.length === 0) {
    const hashes = await deps.readBatchHashes(batchId);
    if (!hashes?.length) return { batchId };
    // Do not overwrite a result finalized while the wallet RPC was in flight.
    const current = await repository.getProofProjection(proofId, input.tenantId);
    if (!current || current.finalStatus !== 'pending') return { batchId };
    if (current.transactionHashes.length === 0) {
      await recordBlueprintSubmissionV1({ repository }, {
        tenantId: input.tenantId, walletAddress: input.walletAddress,
        routeRunId: input.routeRunId, blueprintId: input.blueprintId,
        approvedCallsHash: proof.approvedCallsHash, batchId,
        // The wallet reported settlement; hashes get UNKNOWN placeholders.
        // No wallet-provided status, log, amount or gas becomes chain evidence.
        status: 'confirmed', transactionHashes: hashes, now: deps.now(),
      });
    }
  }
  await deps.reconcile({ tenantId: input.tenantId, walletAddress: input.walletAddress,
    routeRunId: input.routeRunId, routeProofId: proofId, now: deps.now() });
  return { batchId };
}

// One API process must not append the same proof event from simultaneous reads.
// This only coalesces active reads; it caches no wallet data or final answer.
const activeReadsV1 = new Map<string, Promise<unknown>>();
export async function withStockExecutionReadV1<T>(key: string, read: () => Promise<T>): Promise<T> {
  const pending = activeReadsV1.get(key);
  if (pending) return pending as Promise<T>;
  const promise = Promise.resolve().then(read);
  activeReadsV1.set(key, promise);
  try { return await promise; }
  finally { if (activeReadsV1.get(key) === promise) activeReadsV1.delete(key); }
}
