import { useMemo, type ReactNode } from 'react';
import { useRecoverableSubmissionAttempts } from '@mioagent/api-client-react';

import { SubmissionRecoveryCard } from './SubmissionRecoveryCard';
import {
  browserMarkerStorageV1,
  readRecoveryMarkersV1,
  type MarkerStorageV1,
} from './recoveryMarker';

// ---------------------------------------------------------------------------
// T67C.2 — the recovery rail.
//
// One component, mounted by both surfaces. The orchestration — asking the
// server what is unfinished, reconciling that against what this browser
// remembers, deciding what to show — lives here once. Copying it into the web
// console and the miniapp would mean two answers to "did we already send
// this?", which is exactly the question that must have one.
//
// The SERVER's list is the authority on what exists. Local markers only add
// the handle for the case the whole feature was built for: the batch went out,
// the server never heard, and this browser is the only place the batch id
// survived. A marker for an attempt the server does not list is not shown —
// it points at nothing this tenant owns.
// ---------------------------------------------------------------------------

export interface SubmissionRecoveryRailProps {
  /** The connected wallet. Nothing renders without one: a recovery card is
   * about a specific account's transaction. */
  walletAddress: string | null | undefined;
  chainId: number | null | undefined;
  enabled?: boolean;
  onResolved?: (result: { proofId: string | null; finalStatus: string | null }) => void;
  markerStorage?: MarkerStorageV1 | null;
}

export function SubmissionRecoveryRail({
  walletAddress,
  chainId,
  enabled = true,
  onResolved,
  markerStorage,
}: SubmissionRecoveryRailProps): ReactNode {
  const active = Boolean(enabled && walletAddress && chainId === 8453);
  const storage = markerStorage === undefined ? browserMarkerStorageV1() : markerStorage;
  const query = useRecoverableSubmissionAttempts({ enabled: active });

  const markers = useMemo(
    () =>
      active && walletAddress
        ? readRecoveryMarkersV1(storage, { walletAddress, chainId: 8453 })
        : [],
    [active, walletAddress, storage],
  );

  const attempts = useMemo(() => {
    const rows = query.data?.attempts ?? [];
    // A batch id this browser saw but the server has not recorded still belongs
    // on the card — that IS the lost-record case. It is only ever attached to
    // an attempt the server already returned, so it cannot conjure one.
    return rows.map((attempt) => {
      if (attempt.batchId) return attempt;
      const marker = markers.find((entry) => entry.attemptId === attempt.id && entry.batchId);
      return marker ? { ...attempt, batchId: marker.batchId } : attempt;
    });
  }, [query.data, markers]);

  if (!active || attempts.length === 0) return null;

  return (
    <>
      {attempts.map((attempt) => (
        <SubmissionRecoveryCard
          key={attempt.id}
          attempt={attempt}
          onResolved={onResolved}
          onDismissed={() => void query.refetch()}
          markerStorage={storage}
        />
      ))}
    </>
  );
}
