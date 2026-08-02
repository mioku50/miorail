import { z } from 'zod';
import { RouteStorageConflictError } from './types.js';

// ---------------------------------------------------------------------------
// T68D §5 — the Opportunity Clearance.
//
// Evidence that ONE wallet checked ONE token at ONE profile along ONE path,
// and that the round trip executed sequentially against a real chain state.
//
// What it is emphatically NOT: an allowlist entry. Nothing here widens what
// Miorail will route in general. A clearance is consumed by a single
// preparation for the wallet, token, profile and entry route it names, and
// anything else is refused — including the same wallet asking about the same
// token at a different size.
//
// It carries hashes, never bodies. No RPC URL, no API key, no provider
// response: a record whose job is to justify an execution must not become a
// place credentials accumulate.
// ---------------------------------------------------------------------------

export const B20_CLEARANCE_TTL_MS_V1 = 10 * 60 * 1000;

const HASH_V1 = /^0x[0-9a-f]{64}$/;
const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;

export const B20OpportunityClearanceV1Schema = z
  .object({
    schemaVersion: z.literal('b20-opportunity-clearance/v1'),
    id: z.string().min(1).max(200),
    tenantId: z.string().min(1).max(200),
    /** The authenticated wallet. A clearance is worthless to any other. */
    walletAddress: z.string().regex(ADDRESS_V1),
    chainId: z.literal(8453),
    tokenAddress: z.string().regex(ADDRESS_V1),
    quoteAsset: z.string().regex(ADDRESS_V1),

    /** The exact profile evaluated, so a different size cannot reuse this. */
    positionAtomic: z.string().regex(/^[1-9][0-9]{0,17}$/),
    maxRoundTripBps: z.number().int().min(1).max(10_000),
    maxExitSlippageBps: z.number().int().min(1).max(10_000),
    profileIdentity: z.string().min(1).max(200),

    /** What the controls said, and when. A later reading that differs
     * invalidates this. */
    controlSnapshotHash: z.string().regex(HASH_V1),
    controlBlockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),

    /** The exact legs. Prepare re-derives from these and refuses anything else. */
    entryRouteHash: z.string().regex(HASH_V1),
    exitRouteHash: z.string().regex(HASH_V1),
    entrySourceKey: z.string().min(1).max(300),
    exitSourceKey: z.string().min(1).max(300),

    simulationRequestHash: z.string().regex(HASH_V1),
    simulationEvidenceHash: z.string().regex(HASH_V1),
    simulationBlockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
    /** Which provider observed it. Execution must come from the same one. */
    entryProvider: z.string().min(1).max(60),

    /** Only a certified round trip is ever stored, but the field is explicit so
     * a reader never has to infer it from the row's existence. */
    viability: z.literal('qualified'),
    coverage: z.enum(['complete', 'partial']),
    viableRouteConfirmed: z.literal(true),
    bestRouteConfirmed: z.boolean(),

    /** What the simulation actually observed, for the Route Proof later. */
    simulatedReturnedAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/),
    simulatedAcquiredAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/),
    simulatedRoundTripBps: z.number().int().min(0).max(100_000),

    createdAt: z.string().min(1).max(60),
    expiresAt: z.string().min(1).max(60),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A certified round trip that already exceeds the user's tolerance is not
    // a clearance. The schema refuses it rather than trusting every writer.
    if (value.simulatedRoundTripBps > value.maxRoundTripBps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['simulatedRoundTripBps'],
        message: 'A clearance cannot record a round trip above the profile tolerance',
      });
    }
    if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'A clearance must expire after it was created',
      });
    }
  });
export type B20OpportunityClearanceV1 = z.infer<typeof B20OpportunityClearanceV1Schema>;

/** Why a clearance may not be used for a preparation. Every one is a refusal to
 * execute, never a warning. */
export type ClearanceRefusalV1 =
  | 'clearance_missing'
  | 'clearance_expired'
  | 'clearance_wallet_mismatch'
  | 'clearance_token_mismatch'
  | 'clearance_profile_mismatch'
  | 'clearance_route_mismatch'
  | 'clearance_controls_changed'
  | 'clearance_provider_mismatch'
  | 'clearance_chain_mismatch';

export interface ClearanceUseInputV1 {
  clearance: B20OpportunityClearanceV1 | null;
  now: Date;
  tenantId: string;
  walletAddress: string;
  chainId: number;
  tokenAddress: string;
  profileIdentity: string;
  /** The route prepare intends to use, re-derived at prepare time. */
  entryRouteHash: string;
  /** The control snapshot read fresh at prepare time. */
  controlSnapshotHash: string;
  provider: string;
}

/**
 * Whether a clearance authorises THIS preparation.
 *
 * Ordered so the most specific mismatch is named. A user who changed their
 * position size should be told that, not handed a generic refusal that sends
 * them looking for a chain problem.
 *
 * Shared by both repositories and by the route, because a fake that is more
 * permissive than the gate is a fake that hides the only bug that matters here.
 */
export function clearanceRefusalV1(input: ClearanceUseInputV1): ClearanceRefusalV1 | null {
  const clearance = input.clearance;
  if (!clearance) return 'clearance_missing';
  if (clearance.tenantId !== input.tenantId) return 'clearance_wallet_mismatch';
  if (clearance.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
    return 'clearance_wallet_mismatch';
  }
  if (clearance.chainId !== input.chainId) return 'clearance_chain_mismatch';
  if (clearance.tokenAddress.toLowerCase() !== input.tokenAddress.toLowerCase()) {
    return 'clearance_token_mismatch';
  }
  if (clearance.profileIdentity !== input.profileIdentity) return 'clearance_profile_mismatch';
  // Expiry is checked AFTER identity so a stale clearance for the wrong token
  // is reported as the wrong token, which is the more useful sentence.
  if (Date.parse(clearance.expiresAt) <= input.now.getTime()) return 'clearance_expired';
  if (clearance.entryRouteHash !== input.entryRouteHash) return 'clearance_route_mismatch';
  // The controls are re-read at prepare time. A token that changed since the
  // simulation was certified is a different token for this purpose.
  if (clearance.controlSnapshotHash !== input.controlSnapshotHash) return 'clearance_controls_changed';
  if (clearance.entryProvider !== input.provider) return 'clearance_provider_mismatch';
  return null;
}

export const CLEARANCE_REFUSAL_COPY_V1: Record<ClearanceRefusalV1, string> = {
  clearance_missing:
    'This token has not been cleared for entry. Run the full simulation for your profile first.',
  clearance_expired:
    'That clearance has expired. Pools move, so a clearance is short-lived by design — run the simulation again.',
  clearance_wallet_mismatch: 'That clearance belongs to a different wallet.',
  clearance_token_mismatch: 'That clearance is for a different token.',
  clearance_profile_mismatch:
    'That clearance was issued for a different position or tolerance. Changing either needs a new simulation.',
  clearance_route_mismatch:
    'The route changed since this was cleared. A different route has not been checked, so it is not prepared.',
  clearance_controls_changed:
    'This token’s controls changed since it was cleared. Nothing is prepared against a control state that has moved.',
  clearance_provider_mismatch: 'That clearance was issued for a different execution provider.',
  clearance_chain_mismatch: 'That clearance is for a different chain.',
};

export interface B20ClearanceRepositoryV1 {
  /** Immutable. A second write for the same id is a conflict, never an
   * overwrite: a clearance justifies an execution and must not change under
   * one. */
  insertClearance(clearance: B20OpportunityClearanceV1): Promise<B20OpportunityClearanceV1>;
  getClearance(id: string, tenantId: string): Promise<B20OpportunityClearanceV1 | null>;
  /** The newest live clearance for a wallet + token + profile, if any. */
  latestClearance(input: {
    tenantId: string;
    walletAddress: string;
    tokenAddress: string;
    profileIdentity: string;
    now: Date;
  }): Promise<B20OpportunityClearanceV1 | null>;
}

export function clearanceConflictV1(reason: string): RouteStorageConflictError {
  return new RouteStorageConflictError(reason);
}

export function assertClearanceV1(
  value: unknown,
  where: 'write' | 'read',
): B20OpportunityClearanceV1 {
  const parsed = B20OpportunityClearanceV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new RouteStorageConflictError(`B20 opportunity clearance failed validation on ${where}`);
  }
  return parsed.data;
}
