import {
  NftEvidenceRecordV1Schema,
  NftListingCandidateV1Schema,
  NftProofEventV1Schema,
  NftPurchaseBlueprintV1Schema,
  NftPurchaseIntentV1Schema,
  NftPurchaseProofV1Schema,
  NftRouteCardV1Schema,
  type NftEvidenceRecordV1,
  type NftListingCandidateV1,
  type NftProofEventV1,
  type NftProofFinalStatusV1,
  type NftPurchaseBlueprintV1,
  type NftPurchaseIntentV1,
  type NftPurchaseProofV1,
  type NftRouteCardV1,
} from '@mioagent/route-domain';
import { RouteStorageConflictError, RouteStorageIntegrityError, type SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// T65.1 §1 — durable NFT purchase storage.
//
// A separate repository interface, for the same reason Commerce got one: an
// NFT purchase has no swap-shaped Route Proof and no amount to store. Its
// proof succeeds or fails on an ONCHAIN OWNERSHIP READ, which nothing else in
// this codebase has. The run stays in route_runs (goal = 'nft'); the payloads
// do not.
//
// Two rules govern every write here:
//
//   1. ONE blueprint per Route Card. A second prepare returns the first. Two
//      blueprints for one purchase means two wallet prompts for one NFT.
//   2. A finalized proof is never rewritten with a different answer. The
//      question "did I get the token?" gets one recorded answer, or it stays
//      open.
// ---------------------------------------------------------------------------

export interface NftRouteRunRecordV1 {
  id: string;
  userId: string;
  walletAddress: string;
  chainId: number;
  goal: 'nft';
  status: string;
  intentHash: string;
  idempotencyKey: string;
  intent: NftPurchaseIntentV1;
  createdAt: string;
  updatedAt: string;
}

export interface NftPurchaseBlueprintRecordV1 {
  id: string;
  routeRunId: string;
  routeCardId: string;
  userId: string;
  walletAddress: string;
  blueprint: NftPurchaseBlueprintV1;
  /** What the CLIENT reported after calling the wallet. A batch id is not a
   * transaction hash and neither is proof of anything — both are claims about
   * a submission, kept apart from the chain reads in nft_proofs. */
  submissionBatchId: string | null;
  submittedTransactionHash: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NftProofRecordV1 {
  id: string;
  routeRunId: string;
  blueprintId: string;
  userId: string;
  walletAddress: string;
  proof: NftPurchaseProofV1;
  createdAt: string;
  updatedAt: string;
}

export interface NftHistoryItemV1 {
  proofId: string | null;
  blueprintId: string;
  routeRunId: string;
  contractAddress: string;
  tokenId: string;
  orderHash: string;
  listingPriceWei: string;
  blueprintStatus: NftPurchaseBlueprintV1['status'];
  finalStatus: NftProofFinalStatusV1 | null;
  transactionHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveNftBlueprintInputV1 {
  routeRunId: string;
  routeCardId: string;
  userId: string;
  blueprint: NftPurchaseBlueprintV1;
}

export type ReserveNftBlueprintResultV1 =
  /** This caller minted the blueprint and owns the wallet prompt for it. */
  | { outcome: 'created'; record: NftPurchaseBlueprintRecordV1 }
  /** A blueprint already existed for this Route Card. The caller must reuse
   * it rather than prepare a second purchase of the same token. */
  | { outcome: 'existing'; record: NftPurchaseBlueprintRecordV1 };

export interface RecordNftSubmissionInputV1 {
  blueprintId: string;
  userId: string;
  submissionBatchId: string | null;
  transactionHash: string | null;
  submittedAt: string;
}

export interface UpsertNftProofInputV1 {
  routeRunId: string;
  blueprintId: string;
  userId: string;
  proof: NftPurchaseProofV1;
}

export interface NftStorageRepository {
  createNftRouteRun(intent: NftPurchaseIntentV1, idempotencyKey: string): Promise<NftRouteRunRecordV1>;
  getNftRouteRun(id: string, userId: string): Promise<NftRouteRunRecordV1 | null>;

  insertNftCandidate(runId: string, candidate: NftListingCandidateV1): Promise<void>;
  listNftCandidates(runId: string, userId: string): Promise<NftListingCandidateV1[]>;
  getNftCandidate(runId: string, candidateHash: string, userId: string): Promise<NftListingCandidateV1 | null>;

  /** The candidate link comes from the record's own `candidateHash`, never
   * from a separate argument — evidence cannot be filed against a token it
   * does not describe. */
  insertNftEvidence(runId: string, evidence: NftEvidenceRecordV1): Promise<void>;
  listNftEvidence(runId: string, userId: string): Promise<NftEvidenceRecordV1[]>;

  insertNftRouteCard(runId: string, card: NftRouteCardV1): Promise<void>;
  listNftRouteCards(runId: string, userId: string): Promise<NftRouteCardV1[]>;
  getNftRouteCard(runId: string, routeCardHash: string, userId: string): Promise<NftRouteCardV1 | null>;

  /** One blueprint per Route Card, enforced by a unique index. */
  reserveNftPurchaseBlueprint(input: ReserveNftBlueprintInputV1): Promise<ReserveNftBlueprintResultV1>;
  getNftPurchaseBlueprint(blueprintId: string, userId: string): Promise<NftPurchaseBlueprintRecordV1 | null>;
  /** Advances the lifecycle. The CALLS are never replaced — a blueprint whose
   * calldata changed is a different blueprint. */
  updateNftBlueprintStatus(input: {
    blueprintId: string;
    userId: string;
    status: NftPurchaseBlueprintV1['status'];
  }): Promise<NftPurchaseBlueprintRecordV1>;
  /**
   * Records approval of the calls this blueprint already holds.
   *
   * Takes only the hash the client echoed back — never a payload. If it does
   * not equal the stored `callsHash`, the approval is refused, so an approval
   * can never attach to a batch nobody reviewed.
   */
  approveNftPurchaseBlueprint(input: {
    blueprintId: string;
    userId: string;
    approvedCallsHash: string;
  }): Promise<NftPurchaseBlueprintRecordV1>;
  recordNftSubmission(input: RecordNftSubmissionInputV1): Promise<NftPurchaseBlueprintRecordV1>;

  upsertNftProof(input: UpsertNftProofInputV1): Promise<NftProofRecordV1>;
  getNftProof(proofId: string, userId: string): Promise<NftProofRecordV1 | null>;
  getNftProofByBlueprint(blueprintId: string, userId: string): Promise<NftProofRecordV1 | null>;
  /** Proofs that are still asking. This is what reconciliation walks. */
  listOpenNftProofs(limit: number): Promise<NftProofRecordV1[]>;

  appendNftProofEvent(proofId: string, userId: string, event: NftProofEventV1): Promise<void>;
  listNftProofEvents(proofId: string, userId: string): Promise<NftProofEventV1[]>;

  listNftHistory(userId: string, limit: number): Promise<NftHistoryItemV1[]>;
}

// --- shared validation ------------------------------------------------------

export function parseNftIntentV1(value: NftPurchaseIntentV1): NftPurchaseIntentV1 {
  const parsed = NftPurchaseIntentV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('NFT intent failed contract validation');
  return parsed.data;
}

export function parseNftCandidateV1(value: NftListingCandidateV1): NftListingCandidateV1 {
  const parsed = NftListingCandidateV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('NFT candidate failed contract validation');
  return parsed.data;
}

export function parseNftEvidenceV1(value: NftEvidenceRecordV1): NftEvidenceRecordV1 {
  const parsed = NftEvidenceRecordV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('NFT evidence failed contract validation');
  return parsed.data;
}

export function parseNftRouteCardV1(value: NftRouteCardV1): NftRouteCardV1 {
  const parsed = NftRouteCardV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('NFT route card failed contract validation');
  return parsed.data;
}

export function parseNftBlueprintV1(value: NftPurchaseBlueprintV1): NftPurchaseBlueprintV1 {
  const parsed = NftPurchaseBlueprintV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('NFT purchase blueprint failed contract validation');
  return parsed.data;
}

export function parseNftProofV1(value: NftPurchaseProofV1): NftPurchaseProofV1 {
  const parsed = NftPurchaseProofV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('NFT proof failed contract validation');
  return parsed.data;
}

export function parseNftProofEventV1(value: NftProofEventV1): NftProofEventV1 {
  const parsed = NftProofEventV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('NFT proof event failed contract validation');
  return parsed.data;
}

/** Guards the tenant boundary on every read and write path. */
export function assertNftTenantV1(recordUserId: string, userId: string): void {
  if (recordUserId !== userId) {
    throw new RouteStorageConflictError('NFT record belongs to another tenant');
  }
}

/**
 * The run idempotency key.
 *
 * `requestId` is part of it deliberately. The intent id is derived from the
 * goal's content, so without a per-request component the same sentence asked
 * twice collides with its own stored run — the failure T64.3.1 produced in
 * Commerce, reproduced here on purpose so it cannot happen again.
 */
export function nftIdempotencyKeyV1(input: {
  tenantId: string;
  walletAddress: string;
  contractAddress: string;
  tokenId: string;
  maxSpendWei: string;
  requestId: string;
}): string {
  return [
    input.tenantId,
    input.walletAddress.toLowerCase(),
    input.contractAddress.toLowerCase(),
    input.tokenId,
    input.maxSpendWei,
    input.requestId,
  ].join('|');
}

/**
 * A new `updatedAt` that never runs backwards.
 *
 * The contracts refuse `updatedAt < createdAt`, and a record written by a
 * fixture clock must still be updatable by the wall clock, so the later of the
 * two wins rather than whichever one happens to be now.
 */
export function nftUpdatedAtV1(previous: string, now: Date): string {
  const next = now.toISOString();
  return next >= previous ? next : previous;
}

/** A finalized proof holds the answer. A later write may only repeat it. */
export function assertNftProofRewriteAllowedV1(
  existing: NftPurchaseProofV1,
  next: NftPurchaseProofV1,
): void {
  if (existing.status === 'finalized' && existing.proofHash !== next.proofHash) {
    throw new RouteStorageConflictError('A finalized NFT proof cannot be rewritten with a different answer');
  }
  if (existing.orderHash !== next.orderHash || existing.blueprintHash !== next.blueprintHash) {
    throw new RouteStorageIntegrityError('NFT proof does not belong to this purchase');
  }
}

export type { SqlTemplateExecutor };
