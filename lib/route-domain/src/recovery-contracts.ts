import { z } from 'zod';

import {
  AddressV1Schema,
  BaseChainIdV1Schema,
  EntityIdV1Schema,
  HashV1Schema,
  TenantIdV1Schema,
  TimestampV1Schema,
} from './primitives.js';

// ---------------------------------------------------------------------------
// T67C.2 — submission recovery.
//
// A user can send an atomic batch through their Base Account and then lose the
// page: a reload, a closed app, a dropped connection between the wallet
// returning and the server hearing about it. The batch is out on Base either
// way. What is missing is the HANDLE needed to go and ask what became of it.
//
// These two contracts carry that handle and nothing else. Read what is absent:
// there is no calldata field, no approved-calls array, no receipt, no amount.
// An attempt therefore cannot be mistaken for evidence and cannot be used to
// re-send anything — recovery reads a batch id, asks the wallet, and records
// the answer through the submission path that already exists.
//
// The financial record stays where it is: RouteProof, the NFT proof and their
// append-only event chains. An attempt never declares an execution successful.
// ---------------------------------------------------------------------------

/** Which route family a batch belongs to. One recovery mechanism serves all
 * three; the goal only selects which existing submission route records the
 * outcome. */
export const SubmissionGoalV1Schema = z.enum(['swap', 'earn', 'nft']);
export type SubmissionGoalV1 = z.infer<typeof SubmissionGoalV1Schema>;

/**
 * Where an attempt stands. Each of these is a different sentence about what is
 * known, and the differences matter:
 *
 *   * `submitted_unknown` is not a failure. The batch went out and the server
 *     record did not stick, so the honest statement is "we do not know", and
 *     the attempt stays recoverable.
 *   * `confirmed` means the WALLET reported success. The proof may still be
 *     reconciling, so this is not yet a completed execution.
 *   * `abandoned` is a UI decision — the user dismissed the card. It says
 *     nothing about the batch and changes no proof.
 */
export const SubmissionAttemptStatusV1Schema = z.enum([
  'wallet_pending',
  'batch_observed',
  'submitted',
  'submitted_unknown',
  'confirmed',
  'failed',
  'cancelled',
  'abandoned',
]);
export type SubmissionAttemptStatusV1 = z.infer<typeof SubmissionAttemptStatusV1Schema>;

/** Statuses that still need something from the user or from reconciliation.
 * Everything else is terminal and never resurfaces as a recovery card. */
export const RECOVERABLE_ATTEMPT_STATUSES_V1: readonly SubmissionAttemptStatusV1[] = [
  'wallet_pending',
  'batch_observed',
  'submitted',
  'submitted_unknown',
  'confirmed',
];

/** Statuses that presuppose the wallet handed back a batch id. Asserted by the
 * schema below AND by a CHECK constraint in migration 0022 — the state and its
 * handle cannot come apart. */
export const BATCH_BOUND_ATTEMPT_STATUSES_V1: readonly SubmissionAttemptStatusV1[] = [
  'batch_observed',
  'submitted',
  'submitted_unknown',
  'confirmed',
];

const SubmissionAttemptV1ObjectSchema = z
  .object({
    schemaVersion: z.literal('submission-attempt/v1'),
    id: EntityIdV1Schema,
    tenantId: TenantIdV1Schema,
    walletAddress: AddressV1Schema,
    chainId: BaseChainIdV1Schema,
    goal: SubmissionGoalV1Schema,
    routeRunId: EntityIdV1Schema,
    blueprintId: EntityIdV1Schema,
    /** Null until a submission record has named the proof this attempt feeds. */
    proofId: EntityIdV1Schema.nullable(),
    approvedCallsHash: HashV1Schema,
    /** The wallet batch handle. Null means genuinely unrecoverable: there is
     * nothing to ask `wallet_getCallsStatus` about, and the UI says so rather
     * than offering a retry. */
    batchId: z.string().min(1).max(200).nullable(),
    status: SubmissionAttemptStatusV1Schema,
    errorCode: z.string().min(1).max(120).nullable(),
    createdAt: TimestampV1Schema,
    updatedAt: TimestampV1Schema,
    completedAt: TimestampV1Schema.nullable(),
  })
  .strict();

export type SubmissionAttemptV1 = z.infer<typeof SubmissionAttemptV1ObjectSchema>;

export const SubmissionAttemptV1Schema = SubmissionAttemptV1ObjectSchema.superRefine((value, ctx) => {
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['updatedAt'],
      message: 'updatedAt must not be earlier than createdAt',
    });
  }
  if (value.chainId !== 8453) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['chainId'],
      message: 'Submission recovery is Base mainnet only',
    });
  }
  if (BATCH_BOUND_ATTEMPT_STATUSES_V1.includes(value.status) && value.batchId === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['batchId'],
      message: `A ${value.status} attempt must carry the batch id it is about`,
    });
  }
  // A terminal attempt is finished being worked on; an open one is not.
  const terminal = !RECOVERABLE_ATTEMPT_STATUSES_V1.includes(value.status);
  if (terminal && value.completedAt === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['completedAt'],
      message: 'A terminal attempt must record when it finished',
    });
  }
});

export function isRecoverableAttemptStatusV1(status: SubmissionAttemptStatusV1): boolean {
  return RECOVERABLE_ATTEMPT_STATUSES_V1.includes(status);
}

// ---------------------------------------------------------------------------
// The browser-side marker
// ---------------------------------------------------------------------------

/**
 * What may live in browser storage.
 *
 * Handles only. No calldata, no approved calls, no receipts, no tokens, no
 * keys — everything here is a pointer the server re-verifies from its own
 * records before it is worth anything. A tampered marker can therefore point
 * at nothing useful: the worst it achieves is a 404.
 *
 * It exists to close one specific gap. Between `wallet_sendCalls` returning a
 * batch id and the server storing it there is a window in which a reload loses
 * the only handle to a batch that is already on its way. Writing the marker
 * synchronously, before the next network await, makes that window as small as
 * a browser allows. It does not make it zero, and nothing here pretends it
 * does — the wallet extension and this JavaScript are separate processes.
 */
const SubmissionRecoveryMarkerV1ObjectSchema = z
  .object({
    schemaVersion: z.literal('submission-recovery-marker/v1'),
    attemptId: EntityIdV1Schema,
    /** Null until the wallet answers. A marker in this state records only that
     * a wallet was opened. */
    batchId: z.string().min(1).max(200).nullable(),
    goal: SubmissionGoalV1Schema,
    routeRunId: EntityIdV1Schema,
    blueprintId: EntityIdV1Schema,
    proofId: EntityIdV1Schema.nullable(),
    walletAddress: AddressV1Schema,
    chainId: BaseChainIdV1Schema,
    createdAt: TimestampV1Schema,
  })
  .strict();

export type SubmissionRecoveryMarkerV1 = z.infer<typeof SubmissionRecoveryMarkerV1ObjectSchema>;

export const SubmissionRecoveryMarkerV1Schema = SubmissionRecoveryMarkerV1ObjectSchema.superRefine(
  (value, ctx) => {
    if (value.chainId !== 8453) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chainId'],
        message: 'Submission recovery is Base mainnet only',
      });
    }
  },
);

/** Versioned, wallet-scoped storage key. The wallet address is in the key so a
 * marker written by one account is never even read by another. */
export function submissionRecoveryMarkerKeyV1(walletAddress: string, attemptId: string): string {
  return `miorail.submission-recovery.v1:${walletAddress.toLowerCase()}:${attemptId}`;
}

export const SUBMISSION_RECOVERY_MARKER_PREFIX_V1 = 'miorail.submission-recovery.v1:';

/**
 * Parses a stored marker, refusing anything that does not belong to the
 * connected wallet and chain.
 *
 * Returns null for every failure — malformed JSON, a failed schema, a foreign
 * wallet, another chain. The caller deletes it. A marker is a convenience, and
 * a convenience that cannot be trusted is simply dropped.
 */
export function parseSubmissionRecoveryMarkerV1(
  raw: unknown,
  expected: { walletAddress: string; chainId: number },
): SubmissionRecoveryMarkerV1 | null {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = SubmissionRecoveryMarkerV1Schema.safeParse(candidate);
  if (!parsed.success) return null;
  if (parsed.data.walletAddress.toLowerCase() !== expected.walletAddress.toLowerCase()) return null;
  if (parsed.data.chainId !== expected.chainId) return null;
  return parsed.data;
}
