import { isProductionActionType } from '@mioagent/api-client-react';

type ActionLike = {
  id?: string;
  kind?: string;
  status?: string;
  executionPayload?: unknown;
  txHash?: string | null;
  batchId?: string | null;
  receipts?: unknown[] | null;
  metadata?: Record<string, any> | null;
  createdAt?: string;
  executedAt?: string | null;
};

export function parseExecutionPayload(rawPayload: unknown): Record<string, any> | null {
  if (!rawPayload) return null;
  if (typeof rawPayload === 'object') return rawPayload as Record<string, any>;
  if (typeof rawPayload !== 'string') return null;
  try {
    return JSON.parse(rawPayload) as Record<string, any>;
  } catch {
    return null;
  }
}

export function shouldShowConfirmCta(action: ActionLike): boolean {
  const meta = action.metadata || {};
  const payload = parseExecutionPayload(action.executionPayload);
  const calls = Array.isArray(payload?.calls) ? payload.calls : [];
  const actionType = meta.actionType || payload?.actionType;
  const isConfirmableAction =
    meta.userConfirmable === true ||
    meta.executionStatus === 'user-confirmable' ||
    actionType === 'revoke_approval' ||
    actionType === 'limited_transfer' ||
    isProductionActionType(actionType);

  return action.status === 'pending' && calls.length > 0 && isConfirmableAction;
}

export function getNormalizedExecutionProof(action: ActionLike): Record<string, any> | null {
  const meta = action.metadata || {};
  const proof = meta.executionProof && typeof meta.executionProof === 'object'
    ? meta.executionProof
    : null;
  if (proof) return proof;

  const confirmation = meta.confirmation && typeof meta.confirmation === 'object'
    ? meta.confirmation
    : null;
  if (!confirmation) return null;

  return {
    type: 'wallet_confirmation_receipt',
    txHash: confirmation.txHash || action.txHash || meta.txHash || meta.transactionHash,
    batchId: confirmation.batchId || action.batchId || meta.batchId || meta.callBatchId,
    receipts: confirmation.receipts || action.receipts || meta.receipts,
    statusCode: confirmation.statusCode,
    confirmedAt: confirmation.confirmedAt,
    allowanceAfter: confirmation.allowanceAfter || meta.allowanceAfter,
    source: 'metadata.confirmation',
  };
}

function getActionType(action: ActionLike): string | undefined {
  const meta = action.metadata || {};
  const payload = parseExecutionPayload(action.executionPayload);
  return meta.actionType || payload?.actionType;
}

function getProofTxHash(action: ActionLike, proof: Record<string, any> | null): string | undefined {
  const meta = action.metadata || {};
  const receipts = Array.isArray(proof?.receipts)
    ? proof?.receipts
    : Array.isArray(action.receipts)
      ? action.receipts
      : Array.isArray(meta.receipts)
        ? meta.receipts
        : [];
  const receiptHash = receipts
    .map((receipt: any) => receipt?.transactionHash || receipt?.txHash || receipt?.hash)
    .find((hash: unknown) => typeof hash === 'string' && hash.length > 0);
  return proof?.txHash || action.txHash || meta.txHash || meta.transactionHash || receiptHash;
}

function getProofBatchId(action: ActionLike, proof: Record<string, any> | null): string | undefined {
  const meta = action.metadata || {};
  return proof?.batchId || action.batchId || meta.batchId || meta.callBatchId;
}

export function shortHash(value?: string | null, head = 10, tail = 6): string | null {
  if (!value) return null;
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function getRevokeExecutionNotice(action: ActionLike): {
  title: string;
  stateOnlyLabel?: string;
  txHash?: string;
  txHashUrl?: string;
  batchId?: string;
  shortBatchId?: string | null;
} | null {
  if (action.status !== 'executed' || getActionType(action) !== 'revoke_approval') return null;
  const meta = action.metadata || {};
  const proof = getNormalizedExecutionProof(action);
  const allowanceAfter = String(proof?.allowanceAfter ?? meta.allowanceAfter ?? '');
  if (allowanceAfter !== '0') return null;

  const txHash = getProofTxHash(action, proof);
  const batchId = getProofBatchId(action, proof);
  return {
    title: 'Revocation effective — allowance is now 0',
    ...(txHash ? { txHash, txHashUrl: `https://basescan.org/tx/${txHash}` } : {}),
    ...(batchId ? { batchId, shortBatchId: shortHash(batchId, 12, 8) } : {}),
    ...(!txHash ? { stateOnlyLabel: 'State proof only — transaction hash was not captured' } : {}),
  };
}

export function getStateVerifiedAllowanceZeroNotice(action: ActionLike): {
  title: string;
  label: string;
} | null {
  const proof = getNormalizedExecutionProof(action);
  if (!proof || proof.type !== 'state_verified_allowance_zero') return null;
  const notice = getRevokeExecutionNotice(action);
  if (!notice?.stateOnlyLabel) return null;

  return {
    title: notice.title,
    label: notice.stateOnlyLabel,
  };
}

function actionTime(action: ActionLike): number {
  return Date.parse(action.executedAt || action.createdAt || '') || 0;
}

function revokeZeroKey(action: ActionLike): string | null {
  if (getActionType(action) !== 'revoke_approval') return null;
  const meta = action.metadata || {};
  const proof = getNormalizedExecutionProof(action);
  const allowanceAfter = String(proof?.allowanceAfter ?? meta.allowanceAfter ?? '');
  if (allowanceAfter !== '0') return null;

  const wallet = meta.walletAddress || meta.wallet || proof?.wallet;
  const token = meta.tokenAddress || meta.token || proof?.token;
  const spender = meta.spender || meta.spenderAddress || proof?.spender;
  if (!wallet || !token || !spender) return null;
  return `${String(wallet).toLowerCase()}:${String(token).toLowerCase()}:${String(spender).toLowerCase()}`;
}

function actionPreference(action: ActionLike): number {
  const priority =
    action.status === 'executed' && getRevokeExecutionNotice(action) ? 4
    : action.status === 'executed' ? 3
    : shouldShowConfirmCta(action) ? 2
    : action.status === 'pending' || action.status === 'pending_confirmation' || action.status === 'submitted_unknown' ? 1
    : 0;
  return priority * 10_000_000_000_000 + actionTime(action);
}

export function preferLatestMeaningfulRevokeState(actions: ActionLike[]): ActionLike[] {
  const chosenByKey = new Map<string, ActionLike>();
  const output: ActionLike[] = [];
  for (const action of actions) {
    const key = revokeZeroKey(action);
    if (!key) {
      output.push(action);
      continue;
    }
    const current = chosenByKey.get(key);
    if (!current || actionPreference(action) > actionPreference(current)) {
      chosenByKey.set(key, action);
    }
  }

  const chosenIds = new Set(Array.from(chosenByKey.values()).map((action) => action.id));
  for (const action of actions) {
    const key = revokeZeroKey(action);
    if (!key) continue;
    if (chosenIds.has(action.id)) output.push(action);
  }

  return output.sort((a, b) => actionTime(b) - actionTime(a));
}

export function filterInboxActions(actions: ActionLike[], filter: string): ActionLike[] {
  const scoped = filter === 'history' ? [...actions] : preferLatestMeaningfulRevokeState(actions);
  return scoped.filter((action) => {
    if (filter === 'all') return action.status !== 'dismissed';
    if (filter === 'pending') {
      return action.status === 'pending' || action.status === 'pending_confirmation' || action.status === 'submitted_unknown';
    }
    if (filter === 'confirmable') return shouldShowConfirmCta(action);
    if (filter === 'executed') return action.status === 'executed';
    if (filter === 'recommendations') return action.kind === 'recommendation' && action.status !== 'dismissed';
    if (filter === 'history') return action.status === 'dismissed' || action.status === 'executed' || action.status === 'failed' || action.status === 'cancelled';
    return action.status === 'pending';
  });
}
