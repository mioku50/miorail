import {
  SUBMISSION_RECOVERY_MARKER_PREFIX_V1,
  SubmissionRecoveryMarkerV1Schema,
  parseSubmissionRecoveryMarkerV1,
  submissionRecoveryMarkerKeyV1,
  type SubmissionRecoveryMarkerV1,
} from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T67C.2 — the browser-side recovery marker.
//
// This exists to close ONE window. Between `wallet_sendCalls` returning a batch
// id and the server storing it, a reload loses the only handle to a batch that
// is already on its way to Base. Writing the marker synchronously — before the
// next network await — makes that window as small as a browser permits.
//
// It does not make it zero, and nothing here claims otherwise. The wallet
// extension and this JavaScript are separate processes; a crash between them
// is not something a web page can make impossible. What it CAN do is never
// lose the handle for an ordinary reload, which is the case that actually
// happens.
//
// The marker holds handles only. No calldata, no approved calls, no receipts,
// no tokens. Everything in it is re-verified server-side, so the worst a
// tampered marker achieves is a 404.
// ---------------------------------------------------------------------------

/** The subset of `Storage` used here, so tests need no DOM. */
export interface MarkerStorageV1 {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export function browserMarkerStorageV1(): MarkerStorageV1 | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage can throw outright in a partitioned or blocked context. Recovery
    // is then simply unavailable — never a reason to fail a submission.
    return null;
  }
}

/**
 * Writes a marker. SYNCHRONOUS on purpose: callers must be able to place it
 * between receiving a batch id and their next `await`.
 *
 * Returns false when it could not be written, so a caller can tell the
 * difference between "saved" and "we are now relying on the server alone".
 */
export function writeRecoveryMarkerV1(
  storage: MarkerStorageV1 | null,
  marker: SubmissionRecoveryMarkerV1,
): boolean {
  if (!storage) return false;
  const parsed = SubmissionRecoveryMarkerV1Schema.safeParse(marker);
  if (!parsed.success) return false;
  try {
    storage.setItem(
      submissionRecoveryMarkerKeyV1(parsed.data.walletAddress, parsed.data.attemptId),
      JSON.stringify(parsed.data),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearRecoveryMarkerV1(
  storage: MarkerStorageV1 | null,
  walletAddress: string,
  attemptId: string,
): void {
  if (!storage) return;
  try {
    storage.removeItem(submissionRecoveryMarkerKeyV1(walletAddress, attemptId));
  } catch {
    /* nothing to do: a marker that cannot be removed is stale, not dangerous */
  }
}

/**
 * Reads every marker belonging to the connected wallet and chain.
 *
 * A marker that fails validation, names another wallet or names another chain
 * is DELETED rather than returned. It is a convenience, and a convenience that
 * cannot be trusted is not worth keeping — nor worth showing a user a card
 * about a transaction that is not theirs.
 */
export function readRecoveryMarkersV1(
  storage: MarkerStorageV1 | null,
  expected: { walletAddress: string; chainId: number },
): SubmissionRecoveryMarkerV1[] {
  if (!storage) return [];
  const markers: SubmissionRecoveryMarkerV1[] = [];
  const stale: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !key.startsWith(SUBMISSION_RECOVERY_MARKER_PREFIX_V1)) continue;
    const raw = storage.getItem(key);
    const marker = parseSubmissionRecoveryMarkerV1(raw, expected);
    if (marker) markers.push(marker);
    else stale.push(key);
  }
  for (const key of stale) {
    try {
      storage.removeItem(key);
    } catch {
      /* see above */
    }
  }
  return markers.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

/** Terminal outcomes, after which a marker is worthless. `confirmed` is
 * deliberately absent: the wallet reporting success does not mean the proof is
 * reconciled, and dropping the handle then would strand a proof that still
 * needs finishing. */
export const MARKER_CLEARING_STATUSES_V1 = ['failed', 'cancelled', 'abandoned'] as const;

export function markerShouldBeClearedV1(input: {
  attemptStatus: string;
  proofFinalStatus: string | null;
}): boolean {
  if ((MARKER_CLEARING_STATUSES_V1 as readonly string[]).includes(input.attemptStatus)) return true;
  // A proof that has reached a terminal reconciliation state has nothing left
  // to recover, whatever the attempt says.
  return (
    input.proofFinalStatus !== null &&
    input.proofFinalStatus !== 'pending' &&
    input.proofFinalStatus !== 'reconciliation_required'
  );
}
