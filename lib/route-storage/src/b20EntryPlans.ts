import { z } from 'zod';
import { stableHashV1 } from '@mioagent/route-domain';
import { RouteStorageConflictError } from './types.js';
import {
  B20_ENTRY_EXECUTION_UNAVAILABLE_V1,
  entryExecutionAvailableV1,
  type B20EntryExecutionCapabilitiesV1,
} from './b20EntryProjection.js';

// ---------------------------------------------------------------------------
// T68F-A §3/§4 — the prepared B20 Entry Plan as a stored execution subject.
//
// Until now a prepared plan was a response object: the server built it, the
// kernel passed it, the simulator agreed with it, and then it existed only in
// the bytes travelling to a browser. Nothing could refer to it afterwards, so
// nothing could submit it, reconcile it or prove it.
//
// This is that plan as an entity. Three properties are the whole point:
//
//   * IMMUTABLE. The calls stored here are exactly the calls that passed
//     revalidation, the kernel and the prepare-time simulation. They are never
//     rebuilt on read and never accepted from a client. A plan whose bytes
//     could change between review and signature would make every check above
//     it decorative.
//
//   * IDEMPOTENT on tenant + wallet + clearance + requestId. A retried
//     preparation returns the SAME plan and the same blueprint hash rather
//     than quoting the pool again and offering different numbers to a user who
//     only refreshed.
//
//   * NOT EXECUTABLE YET. `lifecycle` starts at `prepared` and there is no
//     write path to any other state in this task. The lifecycle is declared in
//     full so the boundary can already refuse an invalid transition — but
//     nothing here submits, and the schema refuses a `submitted` plan that
//     cannot name the submission it claims.
//
// It is a SEPARATE execution family from the generic swap path, and separate
// storage. Representing it inside `execution_blueprints` would have meant
// nullable columns on a table three other families depend on, and a
// `route_intent` for an asset `isTrustedRouteAsset` refuses by design.
// ---------------------------------------------------------------------------

/** The discriminator. A plan in this family is bound to one wallet, one
 * clearance, one B20 token, one profile, one Aerodrome route and one
 * blueprint — and to nothing else. */
export const B20_ENTRY_EXECUTION_FAMILY_V1 = 'b20_opportunity_entry' as const;
export type B20EntryExecutionFamilyV1 = typeof B20_ENTRY_EXECUTION_FAMILY_V1;

/** Canonical Base USDC. Pinned here rather than imported so the storage layer's
 * refusal does not depend on a quoting package staying honest. */
export const B20_ENTRY_QUOTE_ASSET_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

/** The pinned Aerodrome Router. The only contract this family's swap may call. */
export const B20_ENTRY_ROUTER_V1 = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43';

const HASH_V1 = /^0x[0-9a-f]{64}$/;
const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
const UINT_V1 = /^(0|[1-9][0-9]*)$/;

/**
 * The declared lifecycle.
 *
 * All four states exist now so the boundary can refuse an invalid transition
 * from the first commit. Only `prepared` is reachable in this task: there is no
 * repository method that moves a plan, and `insertPreparedPlan` refuses
 * anything else.
 */
export const B20_ENTRY_LIFECYCLE_V1 = [
  'prepared',
  'awaiting_wallet_approval',
  'submitted',
  'terminal',
] as const;
export type B20EntryLifecycleV1 = (typeof B20_ENTRY_LIFECYCLE_V1)[number];

/** One unsigned call. Exactly what the kernel checked and the simulator ran. */
export const B20EntryPlanCallV1Schema = z
  .object({
    index: z.number().int().min(0).max(1),
    callType: z.enum(['approval', 'swap']),
    to: z.string().regex(ADDRESS_V1),
    data: z.string().regex(/^0x[0-9a-f]*$/).max(20_000),
    /** Always '0'. The input to this family is USDC; a non-zero value would be
     * ETH leaving the wallet for something nobody priced. */
    valueWei: z.literal('0'),
    amountAtomic: z.string().regex(UINT_V1),
    recipient: z.string().regex(ADDRESS_V1).nullable(),
    spender: z.string().regex(ADDRESS_V1).nullable(),
  })
  .strict();
export type B20EntryPlanCallV1 = z.infer<typeof B20EntryPlanCallV1Schema>;

export const B20PreparedEntryPlanV1Schema = z
  .object({
    schemaVersion: z.literal('b20-prepared-entry-plan/v1'),
    executionFamily: z.literal(B20_ENTRY_EXECUTION_FAMILY_V1),
    id: z.string().min(1).max(200),

    // --- immutable identity ---------------------------------------------
    tenantId: z.string().min(1).max(200),
    /** The authenticated wallet. A plan is worthless to any other, and the
     * read path filters rather than trusting a caller to check. */
    walletAddress: z.string().regex(ADDRESS_V1),
    chainId: z.literal(8453),
    clearanceId: z.string().min(1).max(200),
    /** The whole clearance document, hashed. A clearance that changed under a
     * plan would be caught here rather than assumed impossible. */
    clearanceHash: z.string().regex(HASH_V1),
    profileIdentity: z.string().min(1).max(200),
    tokenAddress: z.string().regex(ADDRESS_V1),
    tokenName: z.string().max(120).nullable(),
    tokenSymbol: z.string().max(60).nullable(),
    /** Exact decimals() reading used by the prepared plan. Null on legacy
     * rows prepared before the reading was persisted. */
    tokenDecimals: z.number().int().min(0).max(36).nullable().default(null),
    quoteAsset: z.literal(B20_ENTRY_QUOTE_ASSET_V1),
    positionAtomic: z.string().regex(/^[1-9][0-9]{0,17}$/),

    // --- the route, named by the server and only by the server -----------
    entryProviderId: z.string().min(1).max(60),
    entrySourceKey: z.string().min(1).max(300),
    entryRouteHash: z.string().regex(HASH_V1),

    // --- evidence bindings ------------------------------------------------
    blueprintHash: z.string().regex(HASH_V1),
    /** Over the executable bytes alone, so a reader can verify the stored calls
     * are the ones the hash above was computed with. */
    callsHash: z.string().regex(HASH_V1),
    freshQuoteHash: z.string().regex(HASH_V1),
    /** Two control readings, because they are two different claims: what the
     * token looked like when the opportunity was CERTIFIED, and what it looked
     * like at preparation. One field would hide a change between them. */
    certificationControlSnapshotHash: z.string().regex(HASH_V1),
    prepareControlSnapshotHash: z.string().regex(HASH_V1),
    /** Likewise two simulations. The clearance proved a round trip was viable;
     * the prepare-time one proved these exact bytes do not revert. */
    certificationSimulationEvidenceHash: z.string().regex(HASH_V1),
    prepareSimulationEvidenceHash: z.string().regex(HASH_V1),
    /** Total gas observed while simulating these exact calls. Null only on
     * legacy rows; a canonical Route Proof is never fabricated from null. */
    prepareSimulationGasUsed: z.string().regex(UINT_V1).nullable().default(null),

    expectedOutputAtomic: z.string().regex(/^[1-9][0-9]*$/),
    minimumOutputAtomic: z.string().regex(/^[1-9][0-9]*$/),
    deadlineSeconds: z.string().regex(/^[1-9][0-9]*$/),

    coverage: z.enum(['complete', 'partial']),
    /** A plan is only ever built on a confirmed exit. The literal says so
     * rather than leaving a reader to infer it from the row existing. */
    viableRouteConfirmed: z.literal(true),
    bestRouteConfirmed: z.boolean(),
    /** What the certification measured, carried forward for Review. */
    certificationRoundTripBps: z.number().int().min(0).max(100_000),

    certificationBlockNumber: z.string().regex(UINT_V1),
    prepareControlBlockNumber: z.string().regex(UINT_V1).nullable(),
    prepareSimulationBlockNumber: z.string().regex(UINT_V1),

    clearanceCreatedAt: z.string().min(1).max(60),
    clearanceExpiresAt: z.string().min(1).max(60),

    // --- the unsigned calls ------------------------------------------------
    calls: z.array(B20EntryPlanCallV1Schema).min(1).max(2),

    // --- lifecycle ---------------------------------------------------------
    lifecycle: z.enum(B20_ENTRY_LIFECYCLE_V1),
    /** Null until a submission exists. The schema refuses a `submitted` plan
     * that cannot name one, and refuses one on any other state. */
    submissionId: z.string().min(1).max(200).nullable(),

    requestId: z.string().min(1).max(200),
    createdAt: z.string().min(1).max(60),
    expiresAt: z.string().min(1).max(60),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };

    if (BigInt(value.minimumOutputAtomic) > BigInt(value.expectedOutputAtomic)) {
      fail('minimumOutputAtomic', 'A plan cannot require more than the quote expects');
    }
    if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
      fail('expiresAt', 'A plan must expire after it was prepared');
    }
    // A plan may not outlive the swap deadline it encodes: past that second the
    // calls revert on chain, and a Review screen offering them would be lying.
    if (Date.parse(value.expiresAt) > Number(value.deadlineSeconds) * 1000) {
      fail('expiresAt', 'A plan cannot outlive the swap deadline in its own calls');
    }

    // Submission identity, both directions.
    if (value.lifecycle === 'submitted' && !value.submissionId) {
      fail('submissionId', 'A submitted plan must name the submission it claims');
    }
    if (value.lifecycle !== 'submitted' && value.submissionId) {
      fail('submissionId', `A ${value.lifecycle} plan cannot carry a submission id`);
    }

    // The call shape. At most one bounded approval, then exactly one swap, in
    // that order — a reordered or padded batch is a different transaction.
    const indexes = value.calls.map((call) => call.index);
    if (indexes.some((index, position) => index !== position)) {
      fail('calls', 'Call indexes must be dense and in order');
    }
    const swaps = value.calls.filter((call) => call.callType === 'swap');
    if (swaps.length !== 1) fail('calls', 'A plan holds exactly one swap');
    if (value.calls.filter((call) => call.callType === 'approval').length > 1) {
      fail('calls', 'A plan holds at most one approval');
    }
    if (value.calls[value.calls.length - 1]?.callType !== 'swap') {
      fail('calls', 'The swap must be the last call');
    }

    const wallet = value.walletAddress.toLowerCase();
    for (const call of value.calls) {
      if (call.callType === 'swap') {
        if (call.to.toLowerCase() !== B20_ENTRY_ROUTER_V1) {
          fail('calls', 'The swap must target the pinned Aerodrome Router');
        }
        if (call.recipient?.toLowerCase() !== wallet) {
          fail('calls', 'The swap must send the token to the authenticated wallet');
        }
        continue;
      }
      if (call.to.toLowerCase() !== B20_ENTRY_QUOTE_ASSET_V1) {
        fail('calls', 'The approval must be on canonical USDC');
      }
      if (call.spender?.toLowerCase() !== B20_ENTRY_ROUTER_V1) {
        fail('calls', 'The approval must name the pinned Aerodrome Router');
      }
      // Exact, never unlimited. This is the one line that stops this family
      // from ever asking for an open-ended allowance.
      if (call.amountAtomic !== value.positionAtomic) {
        fail('calls', 'The approval must be exactly the position, never more');
      }
    }
  });
export type B20PreparedEntryPlanV1 = z.infer<typeof B20PreparedEntryPlanV1Schema>;

/** The hash over executable bytes alone. Kept identical to the digest the
 * prepare-time simulation was requested with, so a reader can prove the stored
 * calls are the simulated ones. */
export function entryPlanCallsHashV1(
  calls: readonly { to: string; data: string; valueWei: string }[],
): string {
  return stableHashV1('b20-entry-calls/v1', {
    calls: calls.map((call) => ({ to: call.to, data: call.data, value: call.valueWei })),
  });
}

/** The idempotency identity, as one opaque string. Repeated preparation of the
 * same identity returns the same plan rather than re-quoting the pool and
 * offering different numbers to a user who only refreshed. */
export function entryPlanIdempotencyKeyV1(input: {
  tenantId: string;
  walletAddress: string;
  clearanceId: string;
  requestId: string;
}): string {
  return [
    input.tenantId,
    input.walletAddress.toLowerCase(),
    input.clearanceId,
    input.requestId,
  ].join(' ');
}

/**
 * Whether a lifecycle move is allowed.
 *
 * Declared in full now so the boundary can already refuse the transition that
 * matters most: nothing reaches `submitted` without passing through an explicit
 * approval state AND naming a submission. Expiry is deliberately absent — it is
 * a derived fact about a timestamp, and rewriting immutable evidence to record
 * the passage of time would destroy the evidence.
 */
export function entryPlanTransitionRefusalV1(input: {
  from: B20EntryLifecycleV1;
  to: B20EntryLifecycleV1;
  submissionId: string | null;
}): string | null {
  const allowed: Record<B20EntryLifecycleV1, B20EntryLifecycleV1[]> = {
    prepared: ['awaiting_wallet_approval', 'terminal'],
    awaiting_wallet_approval: ['submitted', 'terminal'],
    submitted: ['terminal'],
    terminal: [],
  };
  if (!allowed[input.from].includes(input.to)) {
    return `A ${input.from} plan cannot become ${input.to}`;
  }
  if (input.to === 'submitted' && !input.submissionId) {
    return 'A plan cannot become submitted without a submission id';
  }
  if (input.to !== 'submitted' && input.submissionId) {
    return `A ${input.to} plan cannot carry a submission id`;
  }
  return null;
}

// --- §8: the Review projection ------------------------------------------------

/**
 * What a Review screen may show.
 *
 * Deliberately NOT the plan. There is no `calls`, no `data`, no provider body,
 * no endpoint and no session handle in this shape — the executable bytes stay
 * server-side until submission wiring exists, and a projection is the only
 * thing a surface ever receives.
 */
export interface B20EntryReviewV1 {
  planId: string;
  executionFamily: B20EntryExecutionFamilyV1;
  spend: { asset: string; amountAtomic: string; decimals: 6 };
  receive: {
    tokenAddress: string;
    tokenName: string | null;
    tokenSymbol: string | null;
    tokenDecimals: number | null;
    expectedOutputAtomic: string;
    minimumOutputAtomic: string;
  };
  provider: { providerId: string; providerName: string; sourceKey: string };
  entryRouteHash: string;
  /** Either the exact approval this plan asks for, or the standing allowance it
   * found sufficient. A Review that showed neither would leave the user unable
   * to tell whether they are about to grant one. */
  approval: { required: boolean; amountAtomic: string | null };
  clearanceId: string;
  clearanceCreatedAt: string;
  clearanceExpiresAt: string;
  certificationBlockNumber: string;
  prepareControlBlockNumber: string | null;
  prepareSimulationBlockNumber: string;
  certificationRoundTripBps: number;
  coverage: 'complete' | 'partial';
  viableRouteConfirmed: boolean;
  bestRouteConfirmed: boolean;
  /** The sentence that stops a user believing this round-trips their money. */
  exitNotice: string;
  lifecycle: B20EntryLifecycleV1;
  expiresAt: string;
  /** True only when the WHOLE submission path exists in the calling surface.
   * Never inferred from the plan holding unsigned calls: that inference is how
   * a button appears for a path that does not exist. When false it is not a
   * provider failure and not a token rejection — the plan is sound. */
  executionAvailable: boolean;
  executionUnavailableReason: 'submission_not_wired' | null;
}

export const B20_ENTRY_EXIT_NOTICE_V1 =
  'The entry will be executed. The exit was simulated and will not be executed by this action.';

const PROVIDER_NAMES_V1: Record<string, string> = { aerodrome: 'Aerodrome' };

export function b20EntryReviewV1(
  plan: B20PreparedEntryPlanV1,
  capabilities?: B20EntryExecutionCapabilitiesV1 | null,
): B20EntryReviewV1 {
  const executionAvailable = entryExecutionAvailableV1(capabilities);
  const approval = plan.calls.find((call) => call.callType === 'approval') ?? null;
  return {
    planId: plan.id,
    executionFamily: plan.executionFamily,
    spend: { asset: plan.quoteAsset, amountAtomic: plan.positionAtomic, decimals: 6 },
    receive: {
      tokenAddress: plan.tokenAddress,
      tokenName: plan.tokenName,
      tokenSymbol: plan.tokenSymbol,
      tokenDecimals: plan.tokenDecimals,
      expectedOutputAtomic: plan.expectedOutputAtomic,
      minimumOutputAtomic: plan.minimumOutputAtomic,
    },
    provider: {
      providerId: plan.entryProviderId,
      providerName: PROVIDER_NAMES_V1[plan.entryProviderId] ?? plan.entryProviderId,
      sourceKey: plan.entrySourceKey,
    },
    entryRouteHash: plan.entryRouteHash,
    approval: {
      required: approval !== null,
      amountAtomic: approval?.amountAtomic ?? null,
    },
    clearanceId: plan.clearanceId,
    clearanceCreatedAt: plan.clearanceCreatedAt,
    clearanceExpiresAt: plan.clearanceExpiresAt,
    certificationBlockNumber: plan.certificationBlockNumber,
    prepareControlBlockNumber: plan.prepareControlBlockNumber,
    prepareSimulationBlockNumber: plan.prepareSimulationBlockNumber,
    certificationRoundTripBps: plan.certificationRoundTripBps,
    coverage: plan.coverage,
    viableRouteConfirmed: plan.viableRouteConfirmed,
    bestRouteConfirmed: plan.bestRouteConfirmed,
    exitNotice: B20_ENTRY_EXIT_NOTICE_V1,
    lifecycle: plan.lifecycle,
    expiresAt: plan.expiresAt,
    executionAvailable,
    executionUnavailableReason: executionAvailable ? null : B20_ENTRY_EXECUTION_UNAVAILABLE_V1,
  };
}

// --- §5: the route-run-compatible record --------------------------------------

/**
 * The execution subject the later EIP-5792 and Route Proof machinery will key
 * on.
 *
 * A separate row rather than a `route_runs` insert, and the reason is honesty:
 * `route_runs` requires a `RouteIntentV1`, and a B20 token cannot form one —
 * `isTrustedRouteAsset` refuses it by design. Forging an intent so a foreign
 * key would accept us is exactly the shortcut a clearance exists to avoid
 * needing.
 *
 * It states the relationship the spec asks for and nothing more:
 *   run → executionFamily → preparedPlanId → clearanceId.
 */
export const B20EntryExecutionRunV1Schema = z
  .object({
    schemaVersion: z.literal('b20-entry-execution-run/v1'),
    id: z.string().min(1).max(200),
    tenantId: z.string().min(1).max(200),
    walletAddress: z.string().regex(ADDRESS_V1),
    chainId: z.literal(8453),
    executionFamily: z.literal(B20_ENTRY_EXECUTION_FAMILY_V1),
    preparedPlanId: z.string().min(1).max(200),
    clearanceId: z.string().min(1).max(200),
    state: z.enum(B20_ENTRY_LIFECYCLE_V1),
    /** No submission id, transaction hash or batch id exists at this stage, and
     * the schema refuses one on any state that has not reached submission. */
    submissionId: z.string().min(1).max(200).nullable(),
    createdAt: z.string().min(1).max(60),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === 'submitted' && !value.submissionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['submissionId'],
        message: 'A submitted run must name the submission it claims',
      });
    }
    if (value.state !== 'submitted' && value.submissionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['submissionId'],
        message: `A ${value.state} run cannot carry a submission id`,
      });
    }
  });
export type B20EntryExecutionRunV1 = z.infer<typeof B20EntryExecutionRunV1Schema>;

// --- the repository -----------------------------------------------------------

export interface B20EntryPlanRepositoryV1 {
  /**
   * Immutable. Only a `prepared` plan may be inserted, and a second write for
   * the same idempotency identity either returns the identical stored plan or
   * conflicts — it never overwrites and never silently returns the new one.
   */
  insertPreparedPlan(input: {
    plan: B20PreparedEntryPlanV1;
    run: B20EntryExecutionRunV1;
  }): Promise<{ plan: B20PreparedEntryPlanV1; run: B20EntryExecutionRunV1 }>;
  /** Tenant- AND wallet-scoped. Another wallet gets the not-found answer a
   * nonexistent plan gets, because the difference is information. */
  getPreparedPlan(input: {
    planId: string;
    tenantId: string;
    walletAddress: string;
  }): Promise<B20PreparedEntryPlanV1 | null>;
  /** The idempotency lookup, run BEFORE any quoting so a retry costs nothing. */
  findByIdempotency(input: {
    tenantId: string;
    walletAddress: string;
    clearanceId: string;
    requestId: string;
  }): Promise<B20PreparedEntryPlanV1 | null>;
  getExecutionRun(input: {
    planId: string;
    tenantId: string;
  }): Promise<B20EntryExecutionRunV1 | null>;
}

export function assertPreparedPlanV1(
  value: unknown,
  where: 'write' | 'read',
): B20PreparedEntryPlanV1 {
  const parsed = B20PreparedEntryPlanV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new RouteStorageConflictError(
      `B20 prepared entry plan failed validation on ${where}: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

export function assertEntryExecutionRunV1(
  value: unknown,
  where: 'write' | 'read',
): B20EntryExecutionRunV1 {
  const parsed = B20EntryExecutionRunV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new RouteStorageConflictError(
      `B20 entry execution run failed validation on ${where}: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

/** The write-time guards both repositories share. A fake that accepted what
 * Postgres refuses would hide the only bug that matters here. */
export function entryPlanWriteRefusalV1(input: {
  plan: B20PreparedEntryPlanV1;
  run: B20EntryExecutionRunV1;
}): string | null {
  if (input.plan.lifecycle !== 'prepared') {
    return 'Only a prepared plan may be stored; a lifecycle move is a separate, explicit transition';
  }
  if (input.run.state !== 'prepared') return 'A new execution run starts prepared';
  if (input.run.preparedPlanId !== input.plan.id) return 'The run must name the plan it executes';
  if (input.run.clearanceId !== input.plan.clearanceId) {
    return 'The run and the plan must name one clearance';
  }
  if (input.run.tenantId !== input.plan.tenantId) return 'The run and the plan must share a tenant';
  if (input.run.walletAddress.toLowerCase() !== input.plan.walletAddress.toLowerCase()) {
    return 'The run and the plan must name one wallet';
  }
  if (entryPlanCallsHashV1(input.plan.calls) !== input.plan.callsHash) {
    return 'The stored calls are not the calls the plan was hashed with';
  }
  return null;
}

export function entryPlanConflictV1(reason: string): RouteStorageConflictError {
  return new RouteStorageConflictError(reason);
}
