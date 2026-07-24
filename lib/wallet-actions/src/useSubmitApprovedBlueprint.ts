// T57: client-side orchestration of the approved-blueprint submission flow.
// The SERVER approve response is the only source of the wallet payload
// (to/value/data/from/chainId) — this hook never accepts calls from the
// caller and never modifies them. The wallet signs via the connected Base
// Account; the server never signs or broadcasts. Flow:
//   approve (server re-validates the stored blueprint) → fail-closed local
//   preflight → wallet sendCalls (exactly once) → record 'submitted'
//   → poll wallet status via CallsStatusPoller → record 'confirmed'/'failed'.

import { useRef, useState, useCallback, createElement, type ReactNode } from 'react';
import { useAccount, useSendCalls } from 'wagmi';
import { base } from 'wagmi/chains';
import {
  useApproveEarnBlueprint,
  useApproveSwapBlueprint,
  useRecordBlueprintSubmission,
  useRecordEarnBlueprintSubmission,
} from '@mioagent/api-client-react';
import type { EarnBlueprintApproveResponseV1, SwapBlueprintApproveResponseV1 } from '@mioagent/api-spec';
import { builderCodeToDataSuffix } from './attribution';
import { CallsStatusPoller, normalizeCall } from './useWalletConfirmAction';

export type BlueprintSubmitStatus =
  | 'idle'
  | 'approving'
  | 'submitting'
  | 'submitted'
  | 'confirmed'
  | 'submitted_unknown'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'expired';

// The approved wallet payload is goal-agnostic: the swap and earn approve
// responses carry an identical `approved` payload shape (to/value/data/from/
// chainId/atomicRequired), so one type + one wallet submission implementation
// serves both goals.
export type ApprovedWalletPayload = Extract<
  SwapBlueprintApproveResponseV1 | EarnBlueprintApproveResponseV1,
  { outcome: 'approved' }
>['payload'];

/** Pure wallet-rejection detector shared with the legacy confirm flow's
 * inline logic: message match reject/cancel/close/denied, EIP-1193 code 4001,
 * or a viem shortMessage mentioning rejection. */
export function isWalletRejectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    lowered.includes('reject') ||
    lowered.includes('cancel') ||
    lowered.includes('close') ||
    lowered.includes('denied') ||
    (error as { code?: number })?.code === 4001 ||
    ((error as { shortMessage?: string })?.shortMessage?.toLowerCase()?.includes('reject') ?? false)
  );
}

export interface BlueprintPreflightInput {
  payload: Pick<ApprovedWalletPayload, 'from' | 'chainId' | 'atomicRequired'>;
  connectedAddress: string | undefined;
  connectedChainId: number | undefined;
}

/** Fail-closed checks that must ALL pass before the wallet is ever opened.
 * Pure so it is unit-testable without wagmi. */
export function blueprintSubmitPreflight(input: BlueprintPreflightInput): { ok: true } | { ok: false; reason: string } {
  const { payload, connectedAddress, connectedChainId } = input;
  if (!connectedAddress) return { ok: false, reason: 'No connected wallet address' };
  if (payload.from.toLowerCase() !== connectedAddress.toLowerCase()) {
    return { ok: false, reason: 'Approved payload is bound to a different wallet' };
  }
  if (connectedChainId !== 8453) {
    return { ok: false, reason: 'Connected wallet is not on Base mainnet (8453)' };
  }
  if (payload.chainId !== '0x2105') {
    return { ok: false, reason: 'Approved payload is not pinned to Base mainnet' };
  }
  if (payload.atomicRequired !== true) {
    return { ok: false, reason: 'Approved payload does not require an atomic batch' };
  }
  return { ok: true };
}

/** Extracts lowercase 0x64-hex transaction hashes from wallet status receipts. */
export function transactionHashesFromReceipts(
  receipts: Array<{ transactionHash?: string }> | undefined,
): string[] {
  const out: string[] = [];
  for (const receipt of receipts ?? []) {
    const hash = receipt?.transactionHash;
    if (typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
      const lower = hash.toLowerCase();
      if (!out.includes(lower)) out.push(lower);
    }
  }
  return out;
}

/** Converts a hex/decimal/number quantity to an unsigned base-unit integer
 * string (AtomicAmountV1 form), or null when it is missing/unparseable. */
export function walletQuantityToAtomic(value: unknown): string | null {
  if (typeof value === 'bigint') return value >= BigInt(0) ? value.toString() : null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value).toString() : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const bi = BigInt(value.trim());
      return bi >= BigInt(0) ? bi.toString() : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Maps a wagmi `wallet_getCallsStatus` receipt (status/blockNumber/gasUsed as
 * hex `0x1`/`0x0`/quantities, plus extra fields) into the strict
 * TransactionReceiptV1 shape the server persists. Crucially this preserves the
 * REAL onchain status: `0x1` → `success`, `0x0` → `reverted`, anything else →
 * `unknown` — so a genuine confirmation is recorded as `success` and never
 * collapses into the honest-but-ambiguous `unknown` placeholder. Never
 * fabricates a success. */
export function normalizeWalletReceipts(
  receipts: ReadonlyArray<Record<string, unknown>> | undefined,
): Array<{ transactionHash: string; status: 'success' | 'reverted' | 'unknown'; blockNumber: string | null; gasUsed: string | null }> {
  const out: Array<{ transactionHash: string; status: 'success' | 'reverted' | 'unknown'; blockNumber: string | null; gasUsed: string | null }> = [];
  for (const receipt of receipts ?? []) {
    const hash = receipt?.transactionHash;
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) continue;
    const rawStatus = receipt?.status;
    const status: 'success' | 'reverted' | 'unknown' =
      rawStatus === '0x1' || rawStatus === 1 || rawStatus === '0x01' || rawStatus === 'success'
        ? 'success'
        : rawStatus === '0x0' || rawStatus === 0 || rawStatus === '0x00' || rawStatus === 'reverted'
          ? 'reverted'
          : 'unknown';
    out.push({
      transactionHash: hash.toLowerCase(),
      status,
      blockNumber: walletQuantityToAtomic(receipt?.blockNumber),
      gasUsed: walletQuantityToAtomic(receipt?.gasUsed),
    });
  }
  return out;
}

export interface UseSubmitApprovedBlueprintArgs {
  routeRunId: string;
  blueprintId: string;
  blueprintHash: string;
  /** Public ERC-8021 builder code; converted to an optional dataSuffix capability. */
  builderCode?: string;
  /** Which server routes to approve/record against. Defaults to 'swap' so every
   * existing swap caller is byte-for-byte unchanged; 'earn' targets the /earn
   * approve + submission routes. The wallet_sendCalls path is identical for both
   * — there is exactly ONE wallet submission implementation. */
  goal?: 'swap' | 'earn';
}

export interface UseSubmitApprovedBlueprintResult {
  /** Approve on the server, then open the connected Base Account wallet. */
  submit: () => Promise<void>;
  status: BlueprintSubmitStatus;
  error: string | null;
  batchId: string | null;
  txHashes: string[];
  /** T58: Route Proof id captured from the LAST successful submission record
   * — the handle a surface needs to start bounded reconciliation. Null until
   * a record succeeds. This hook itself NEVER reconciles (wallet-actions =
   * wallet only; reconciliation lives in api-client-react). */
  proofId: string | null;
  /** T58: the proof finalStatus the server reported on that same record. */
  recordedFinalStatus: string | null;
  /** Mount this to poll wallet batch status once a batchId exists. */
  poller: ReactNode;
}

export function useSubmitApprovedBlueprint({
  routeRunId,
  blueprintId,
  blueprintHash,
  builderCode,
  goal = 'swap',
}: UseSubmitApprovedBlueprintArgs): UseSubmitApprovedBlueprintResult {
  // Both goals' hooks are instantiated unconditionally (rules of hooks); the
  // goal selects which pair actually drives the flow. The swap and earn
  // approve/record responses are structurally identical, so everything below
  // this line is goal-agnostic.
  const approveSwap = useApproveSwapBlueprint();
  const approveEarn = useApproveEarnBlueprint();
  const recordSwap = useRecordBlueprintSubmission();
  const recordEarn = useRecordEarnBlueprintSubmission();
  const approveMutateAsync = goal === 'earn' ? approveEarn.mutateAsync : approveSwap.mutateAsync;
  const recordMutateAsync = goal === 'earn' ? recordEarn.mutateAsync : recordSwap.mutateAsync;
  const sendCalls = useSendCalls();
  const { address, chainId } = useAccount();

  const [status, setStatus] = useState<BlueprintSubmitStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [txHashes, setTxHashes] = useState<string[]>([]);
  const [proofId, setProofId] = useState<string | null>(null);
  const [recordedFinalStatus, setRecordedFinalStatus] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const finalizedRef = useRef(false);
  const approvedRef = useRef<ApprovedWalletPayload | null>(null);

  // T58: no longer throws the record response away — proofId/finalStatus from
  // the last successful record are captured so a surface can hand the proof
  // to the bounded reconciliation hook. Failures still degrade honestly to
  // `false` (never a fabricated proof id).
  const recordSafely = useCallback(
    async (input: Parameters<typeof recordMutateAsync>[0]): Promise<boolean> => {
      try {
        const response = await recordMutateAsync(input);
        setProofId(response.proofId);
        setRecordedFinalStatus(response.finalStatus);
        return true;
      } catch {
        return false;
      }
    },
    [recordMutateAsync],
  );

  const handleStatusChange = useCallback(
    (cs: { status?: string; statusCode?: number; receipts?: Array<{ transactionHash?: string }> }) => {
      const payload = approvedRef.current;
      if (!batchId || !payload || finalizedRef.current) return;
      if (!cs || (cs.status !== 'success' && cs.status !== 'failure')) return;
      finalizedRef.current = true;

      const rawReceipts = cs.receipts as unknown as ReadonlyArray<Record<string, unknown>> | undefined;
      const hashes = transactionHashesFromReceipts(cs.receipts);
      // Normalize wagmi receipts into the strict TransactionReceiptV1 shape so
      // the server records the REAL onchain status (success/reverted), not an
      // `unknown` placeholder — otherwise a genuine confirmation would never
      // read as `confirmed` server-side.
      const normalizedReceipts = normalizeWalletReceipts(rawReceipts);
      if (cs.status === 'success') {
        setTxHashes(hashes);
        setStatus('confirmed');
        void recordSafely({
          walletAddress: payload.from,
          routeRunId,
          blueprintId,
          approvedCallsHash: payload.approvedCallsHash,
          status: 'confirmed',
          batchId,
          transactionHashes: hashes,
          receipts: normalizedReceipts,
        });
      } else {
        setStatus('failed');
        setError('Wallet reported the batch as failed');
        void recordSafely({
          walletAddress: payload.from,
          routeRunId,
          blueprintId,
          approvedCallsHash: payload.approvedCallsHash,
          status: 'failed',
          batchId,
          transactionHashes: hashes,
          receipts: normalizedReceipts,
          error: 'Wallet reported the batch as failed',
        });
      }
    },
    [batchId, blueprintId, recordSafely, routeRunId],
  );

  const poller: ReactNode =
    batchId && batchId.trim().length > 0
      ? createElement(CallsStatusPoller, { batchId, onStatusChange: handleStatusChange })
      : null;

  const submit = async () => {
    // Single-flight: a second click while a submission is active is a no-op —
    // there are NO automatic re-sends of a wallet batch.
    if (inFlightRef.current) return;
    if (!address) {
      setStatus('failed');
      setError('Connect your Base Account wallet first');
      return;
    }
    inFlightRef.current = true;
    finalizedRef.current = false;
    setError(null);
    setBatchId(null);
    setTxHashes([]);
    setProofId(null);
    setRecordedFinalStatus(null);
    setStatus('approving');

    try {
      const approval = await approveMutateAsync({
        walletAddress: address.toLowerCase() as `0x${string}`,
        routeRunId,
        blueprintId,
        blueprintHash,
      });
      if (approval.outcome === 'expired') {
        setStatus('expired');
        setError(approval.reason);
        return;
      }
      if (approval.outcome === 'blocked') {
        setStatus('blocked');
        setError(approval.reason);
        return;
      }

      const payload = approval.payload;
      const preflight = blueprintSubmitPreflight({
        payload,
        connectedAddress: address,
        connectedChainId: chainId,
      });
      if (!preflight.ok) {
        setStatus('failed');
        setError(preflight.reason);
        return;
      }
      approvedRef.current = payload;

      const suffix = builderCodeToDataSuffix(builderCode);
      setStatus('submitting');
      let result: { id: string };
      try {
        result = await sendCalls.mutateAsync({
          calls: payload.calls.map(normalizeCall) as unknown as Parameters<typeof sendCalls.mutateAsync>[0]['calls'],
          chainId: base.id,
          forceAtomic: true,
          capabilities: suffix ? { dataSuffix: { value: suffix, optional: true } } : undefined,
        });
      } catch (cause) {
        if (isWalletRejectionError(cause)) {
          setStatus('cancelled');
          setError('Cancelled in wallet');
          await recordSafely({
            walletAddress: payload.from,
            routeRunId,
            blueprintId,
            approvedCallsHash: payload.approvedCallsHash,
            status: 'cancelled',
            error: 'User rejected the request in the wallet',
          });
        } else {
          const message = cause instanceof Error ? cause.message : 'Wallet submission failed';
          setStatus('failed');
          setError(message);
          await recordSafely({
            walletAddress: payload.from,
            routeRunId,
            blueprintId,
            approvedCallsHash: payload.approvedCallsHash,
            status: 'failed',
            error: message,
          });
        }
        return;
      }

      setBatchId(result.id);
      const recorded = await recordSafely({
        walletAddress: payload.from,
        routeRunId,
        blueprintId,
        approvedCallsHash: payload.approvedCallsHash,
        status: 'submitted',
        batchId: result.id,
      });
      if (recorded) {
        setStatus('submitted');
      } else {
        // The batch went out but the server record is not confirmed — never
        // pretend certainty either way.
        setStatus('submitted_unknown');
        await recordSafely({
          walletAddress: payload.from,
          routeRunId,
          blueprintId,
          approvedCallsHash: payload.approvedCallsHash,
          status: 'submitted_unknown',
          batchId: result.id,
          error: 'submitted record could not be persisted',
        });
      }
    } catch (cause) {
      setStatus('failed');
      setError(cause instanceof Error ? cause.message : 'Blueprint approval failed');
    } finally {
      inFlightRef.current = false;
    }
  };

  return { submit, status, error, batchId, txHashes, proofId, recordedFinalStatus, poller };
}
