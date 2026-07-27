import {
  AiInferenceProofV1Schema,
  AiRouteCardV1Schema,
  AiRouteIntentV1Schema,
  type AiInferenceProofV1,
  type AiRouteCardV1,
  type AiRouteIntentV1,
} from '@mioagent/route-domain';
import { RouteStorageConflictError, RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// T66C/T66D — durable Private AI storage.
//
// Two records, not six. An AI route has no reconciliation phase: the card
// carries its own candidates, evidence and dimensions, all hash-verified, and
// a proof is final the moment the provider answers.
//
// NOTHING HERE CAN HOLD A PROMPT. Not the card, not the proof, not an
// argument to any function below. The commitment is stored; the nonce that
// would open it is not, and there is no parameter through which a caller
// could pass it in.
//
// Two rules govern every write:
//
//   1. ONE card per run. Comparing again opens a new run rather than
//      replacing the card the user is currently reading.
//   2. ONE proof per card, and a finalized proof is never rewritten with a
//      different answer. This is what makes a double-submitted execution a
//      conflict rather than a second charge to the user.
// ---------------------------------------------------------------------------

export interface AiRouteCardRecordV1 {
  id: string;
  routeRunId: string;
  userId: string;
  walletAddress: string;
  intent: AiRouteIntentV1;
  card: AiRouteCardV1;
  createdAt: string;
  updatedAt: string;
}

export interface AiInferenceProofRecordV1 {
  id: string;
  routeRunId: string;
  routeCardId: string;
  userId: string;
  walletAddress: string;
  proof: AiInferenceProofV1;
  createdAt: string;
  updatedAt: string;
}

export interface InsertAiRouteCardInputV1 {
  id: string;
  routeRunId: string;
  userId: string;
  walletAddress: string;
  intent: AiRouteIntentV1;
  card: AiRouteCardV1;
}

export interface InsertAiProofInputV1 {
  id: string;
  routeRunId: string;
  routeCardId: string;
  userId: string;
  walletAddress: string;
  proof: AiInferenceProofV1;
}

export interface AiRouteRunRecordV1 {
  id: string;
  userId: string;
  walletAddress: string;
  chainId: number;
  goal: 'private_ai';
  status: string;
  intentHash: string;
  idempotencyKey: string;
  intent: AiRouteIntentV1;
  createdAt: string;
  updatedAt: string;
}

/**
 * The idempotency key for one comparison.
 *
 * Built from the COMMITMENT, never from the prompt. Two identical prompts
 * produce different commitments (different nonces) and therefore different
 * runs — which is correct: they are two separate requests the user made, and
 * collapsing them would hand the second one the first one's proof.
 */
export function aiIdempotencyKeyV1(input: {
  tenantId: string;
  walletAddress: string;
  requestId: string;
  promptCommitment: string;
}): string {
  return [
    'ai',
    input.tenantId,
    input.walletAddress.toLowerCase(),
    input.requestId,
    input.promptCommitment,
  ].join(':');
}

export interface AiRouteStorageRepositoryV1 {
  createAiRouteRun(intent: AiRouteIntentV1, idempotencyKey: string): Promise<AiRouteRunRecordV1>;
  getAiRouteRun(id: string, userId: string): Promise<AiRouteRunRecordV1 | null>;
  insertAiRouteCard(input: InsertAiRouteCardInputV1): Promise<void>;
  getAiRouteCard(routeRunId: string, userId: string): Promise<AiRouteCardRecordV1 | null>;
  insertAiProof(input: InsertAiProofInputV1): Promise<AiInferenceProofRecordV1>;
  getAiProofByCard(routeCardId: string, userId: string): Promise<AiInferenceProofRecordV1 | null>;
  listAiProofs(userId: string, limit: number): Promise<AiInferenceProofRecordV1[]>;
}

/**
 * The one place a stored card or proof is re-validated on the way out.
 *
 * A row whose payload no longer parses is an INTEGRITY error, not a null: a
 * card that cannot be verified must never be handed to an execution path that
 * would then run whatever model it names.
 */
export function parseStoredAiCardV1(payload: unknown, id: string): AiRouteCardV1 {
  const parsed = AiRouteCardV1Schema.safeParse(payload);
  if (!parsed.success) {
    throw new RouteStorageIntegrityError(`Stored AI route card ${id} failed contract validation`);
  }
  return parsed.data;
}

export function parseStoredAiIntentV1(payload: unknown, id: string): AiRouteIntentV1 {
  const parsed = AiRouteIntentV1Schema.safeParse(payload);
  if (!parsed.success) {
    throw new RouteStorageIntegrityError(`Stored AI intent ${id} failed contract validation`);
  }
  return parsed.data;
}

export function parseStoredAiProofV1(payload: unknown, id: string): AiInferenceProofV1 {
  const parsed = AiInferenceProofV1Schema.safeParse(payload);
  if (!parsed.success) {
    throw new RouteStorageIntegrityError(`Stored AI proof ${id} failed contract validation`);
  }
  return parsed.data;
}

/**
 * Whether a second proof for the same card may be written.
 *
 * Shared by BOTH the in-memory repository and the Postgres one so the two can
 * never disagree — the divergence between fake and database shipped three
 * separate production bugs in T65.
 *
 * An identical re-submission is idempotent and returns the stored proof. A
 * DIFFERENT answer for the same card is a conflict: the user asked once and
 * paid once, and two recorded outcomes for one charge cannot both be true.
 */
export function aiProofWriteEffectV1(input: {
  existing: AiInferenceProofRecordV1 | null;
  next: AiInferenceProofV1;
}): { kind: 'insert' } | { kind: 'unchanged'; record: AiInferenceProofRecordV1 } {
  const { existing } = input;
  if (existing === null) return { kind: 'insert' };
  if (existing.proof.proofHash === input.next.proofHash) {
    return { kind: 'unchanged', record: existing };
  }
  throw new RouteStorageConflictError('This request already has a recorded answer');
}

/** The card and the proof must describe the same run, the same intent, and the
 * same model. A proof pointing at another card is refused before it is
 * written, not discovered later by a reader. */
export function assertAiProofMatchesCardV1(
  card: AiRouteCardRecordV1,
  proof: AiInferenceProofV1,
): void {
  if (proof.routeCardHash !== card.card.routeCardHash) {
    throw new RouteStorageConflictError('This proof belongs to a different Route Card');
  }
  if (proof.intentHash !== card.intent.intentHash) {
    throw new RouteStorageConflictError('This proof belongs to a different request');
  }
  if (proof.promptCommitment !== card.intent.prompt.commitment) {
    throw new RouteStorageConflictError('This proof commits to a different prompt');
  }
  if (card.card.selected !== null && proof.candidateHash !== card.card.selected.candidateHash) {
    throw new RouteStorageConflictError('This proof names a model the card did not select');
  }
}
