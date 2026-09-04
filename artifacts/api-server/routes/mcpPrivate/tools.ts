import {
  OPPORTUNITY_QUOTE_ASSET_V1,
  profileIdentityV1,
} from '@mioagent/opportunity-rail';
import { entryPlanCallsHashV1, type McpAuditOutcomeV1 } from '@mioagent/route-storage';
import {
  beginEntrySubmissionV1,
  loadEntryPlanV1,
  prepareEntryFromClearanceV1,
  readEntryPlanStatusV1,
  recordEntrySubmissionV1,
  runOpportunitySimulationV1,
  type B20FacadeRefusalV1,
} from '../b20Control.js';
import {
  stockExecutionHandoffV1,
  type StockExecutionHandoffResultV1,
} from '@mioagent/rwa-market-reality/execution-handoff';
import { getMiorailProductMigrationFlags } from '../../lib/productMigrationConfig.js';
import { logger } from '@mioagent/utils';
import { issueStockActionDraftV1 } from '../../lib/stockActionDraft.js';
import {
  STOCK_ACTION_CLEARANCE_REFUSAL_COPY_V1,
  verifyStockActionClearanceV1,
} from '../../lib/stockActionClearance.js';
import { stockActionIntentV1 } from '../../lib/stockActionIntent.js';
import { rwaMarketRealityRuntime } from '../rwaMarketReality.js';
import { McpAuditUnavailableError, recordAuditV1 } from './audit.js';
import type { RouteIntentV1 } from '@mioagent/route-domain';
import {
  classifySimulationOutcomeV1,
  type TransactionPreparationResultV1,
} from '@mioagent/transaction-composer';
import type { McpPrivateIdentityV1 } from './session.js';

// ---------------------------------------------------------------------------
// T72-B §2 — the private tool layer.
//
// Every tool here is a thin adapter over a facade in `b20Control.ts`. There is
// no second qualification, no second gate, no second view of what `qualified`
// means and no calldata construction — §3 and §5 are enforced by there being
// nothing here that could do those things.
//
// The one thing this layer adds is REFUSAL COPY. An assistant that receives a
// bare code will invent an explanation for it, and the invented explanation is
// always more encouraging than the real one. So every refusal carries the
// sentence a person should be told.
// ---------------------------------------------------------------------------

/** §7 — what an assistant driving execution must not lose. */
export const MIORAIL_PRIVATE_CAVEATS_V1 = {
  approval:
    'MIORAIL NEVER SIGNS. Every transaction is approved by the user in their own Base Account. If you hand these calls to Base MCP, the user still has to approve them, and they may decline.',
  qualification:
    'ONLY A LIVE WALLET-BOUND SIMULATION QUALIFIES A TOKEN. A provisional Discover measurement is not executable and cannot be turned into a plan. Call miorail_check_exit_profile first; nothing else produces a clearance.',
  onePlanOneSubmission:
    'A PLAN HAS ONE SUBMISSION. If a submission’s result is unknown, do not prepare again, do not fetch the action again and do not send again — call miorail_get_execution_status. Resending is how somebody buys the same token twice.',
  entryOnly:
    'THE EXIT IS SIMULATED, NOT EXECUTED. These calls buy the token. Nothing here sells it, and Miorail will not exit a position for the user.',
} as const;

/** §6/§10 — errors an assistant may repeat verbatim to a stranger. */
export class McpPrivateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpPrivateError';
  }
}

/**
 * A facade refusal, translated.
 *
 * The cause is never propagated: a storage error carries a connection string,
 * an RPC error carries an endpoint, and an endpoint carries a key. What the
 * caller gets is the code the web surface already uses plus a sentence.
 */
export const PRIVATE_REFUSAL_COPY_V1: Record<string, string> = {
  b20_rpc_unavailable: 'This Miorail server has no Base mainnet endpoint configured, so it cannot measure anything live.',
  b20_storage_unavailable: 'Miorail’s B20 control storage is not migrated on this server.',
  b20_clearance_unavailable: 'This Miorail server cannot store a clearance, so it cannot qualify an entry.',
  b20_entry_plan_unavailable: 'This Miorail server cannot store an entry plan, so it cannot prepare one.',
  b20_controls_unread:
    'This token’s controls have not been read on this server yet. Miorail refuses to price a token whose transfer controls it has never checked.',
  b20_entry_plan_not_found:
    'No such entry plan exists for this wallet. That is the same answer another wallet’s plan would give — Miorail does not confirm that somebody else’s plan exists.',
  b20_entry_attempt_not_found: 'No such submission attempt exists for this plan and wallet.',
  b20_entry_submission_conflict:
    'That submission was already recorded with a different batch id. Miorail will not overwrite the record of what was sent.',
  storage_integrity: 'Miorail could not store the evidence behind that plan, so it did not describe one.',
  mcp_execution_disabled:
    'This Miorail server does not hand executable calls to MCP clients. The plan is sound; the handoff is switched off here.',
  mcp_audit_unavailable:
    'Miorail could not record this handoff in its execution audit, so it did not perform it. Nothing was released and nothing was sent. This is a server problem, not a problem with the plan — try again shortly.',
};

/** The audit rows a tool writes carry the tool's own name, so a reader can see
 * which call released something without inferring it from the outcome. */
async function auditV1(
  identity: McpPrivateIdentityV1,
  input: Omit<Parameters<typeof recordAuditV1>[0], 'tokenId' | 'tenantId' | 'walletAddress'>,
): Promise<void> {
  await recordAuditV1({
    tokenId: identity.tokenId,
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    ...input,
  });
}

function refuse(refusal: B20FacadeRefusalV1): never {
  throw new McpPrivateError(
    refusal.code,
    PRIVATE_REFUSAL_COPY_V1[refusal.code] ?? refusal.detail ?? 'Miorail refused that request.',
  );
}

/** Any unexpected throw becomes one public sentence. */
export function privateFailureV1(error: unknown): McpPrivateError {
  if (error instanceof McpPrivateError) return error;
  return new McpPrivateError(
    'miorail_unavailable',
    'Miorail could not complete that right now. Nothing was prepared, sent or recorded.',
  );
}

/** The reference tolerances, used when the caller names only a size. Echoed on
 * every response so an assumed tolerance is never a silent one. */
export const PRIVATE_DEFAULT_ROUND_TRIP_BPS_V1 = 300;
export const PRIVATE_DEFAULT_SLIPPAGE_BPS_V1 = 300;

function profileV1(input: {
  positionAtomic: string;
  maxRoundTripBps?: number;
  maxExitSlippageBps?: number;
}) {
  return {
    quoteAsset: OPPORTUNITY_QUOTE_ASSET_V1,
    positionAtomic: input.positionAtomic,
    maxRoundTripBps: input.maxRoundTripBps ?? PRIVATE_DEFAULT_ROUND_TRIP_BPS_V1,
    maxExitSlippageBps: input.maxExitSlippageBps ?? PRIVATE_DEFAULT_SLIPPAGE_BPS_V1,
  } as const;
}

// --- the five tools ---------------------------------------------------------

/**
 * §3 — the live wallet-specific check.
 *
 * This is the ONLY producer of `qualified` on any surface. It quotes, simulates
 * the entry against the asking wallet, re-quotes the exit at the size the entry
 * actually produced, and simulates all four calls in one state. A background
 * Discover observation cannot reach it and cannot substitute for it.
 */
export async function miorailCheckExitProfileV1(
  identity: McpPrivateIdentityV1,
  args: {
    tokenAddress: string;
    positionAtomic: string;
    maxRoundTripBps?: number;
    maxExitSlippageBps?: number;
  },
): Promise<Record<string, unknown>> {
  const profile = profileV1(args);
  const result = await runOpportunitySimulationV1({
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    chainId: 8453,
    tokenAddress: String(args.tokenAddress ?? '').toLowerCase(),
    positionAtomic: profile.positionAtomic,
    maxRoundTripBps: profile.maxRoundTripBps,
    maxExitSlippageBps: profile.maxExitSlippageBps,
  });
  if (!result.ok) refuse(result);

  const body = result.body as Record<string, unknown>;
  const qualified = body.viability === 'qualified' && typeof body.clearanceId === 'string';
  return {
    ...body,
    // Never inferred by the caller from the presence of a clearance id.
    qualified,
    referenceProfile: profile,
    profileIdentity: profileIdentityV1(profile),
    nextStep: qualified
      ? 'Call miorail_prepare_b20_entry with this clearanceId and the SAME profile. Anything else invalidates it.'
      : 'There is no clearance, so there is nothing to prepare. Do not describe this token as tradeable on this evidence.',
    caveats: MIORAIL_PRIVATE_CAVEATS_V1,
  };
}

/**
 * §4 — consume a clearance into a persisted, simulated plan.
 *
 * Returns the REVIEW and never the calls. That distinction is the whole point
 * of splitting this from `miorail_get_base_mcp_action`: an assistant should be
 * able to describe what a plan does, and be asked to confirm, before anything
 * executable exists in the conversation.
 */
export async function miorailPrepareB20EntryV1(
  identity: McpPrivateIdentityV1,
  args: {
    clearanceId: string;
    positionAtomic: string;
    maxRoundTripBps?: number;
    maxExitSlippageBps?: number;
    requestId: string;
  },
): Promise<Record<string, unknown>> {
  const profile = profileV1(args);
  const prepared = await prepareEntryFromClearanceV1({
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    clearanceId: String(args.clearanceId ?? ''),
    chainId: 8453,
    // Derived here from the stated profile, never accepted as an opaque string:
    // a caller that could supply an identity could aim a clearance at a profile
    // it was not certified for.
    profileIdentity: profileIdentityV1(profile),
    requestId: String(args.requestId ?? ''),
  });
  if (!prepared.ok) refuse(prepared);

  const body = prepared.body as Record<string, unknown>;
  const planId = typeof body.planId === 'string' ? body.planId : null;
  const flags = getMiorailProductMigrationFlags(process.env);

  if (!planId) {
    return {
      outcome: body.outcome,
      refusalReason: body.refusalReason,
      refusalDetail: body.refusalDetail,
      planId: null,
      executionAvailable: false,
      caveats: MIORAIL_PRIVATE_CAVEATS_V1,
    };
  }

  // Read back what was stored, so the hash and the expiry describe the row
  // rather than the response that announced it.
  const loaded = await loadEntryPlanV1({
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    planId,
  });
  if (!loaded.ok) refuse(loaded);
  const plan = loaded.body;

  // §2 — a plan was described to an assistant. Best-effort: refusing to show a
  // user their own review because a log write failed would be a worse outcome
  // than a gap in the log, and nothing irreversible happened here.
  await auditV1(identity, {
    toolName: 'miorail_prepare_b20_entry',
    outcome: 'plan_read',
    planId: plan.id,
    callsHash: plan.callsHash,
  });

  return {
    outcome: body.outcome,
    planId: plan.id,
    review: body.review,
    // §4's required fields, read off the persisted plan.
    callsHash: plan.callsHash,
    blueprintHash: plan.blueprintHash,
    chainId: plan.chainId,
    wallet: plan.walletAddress,
    expiresAt: plan.expiresAt,
    clearanceExpiresAt: plan.clearanceExpiresAt,
    // Two independent gates. `executionAvailable` is the server's submission
    // wiring; the MCP handoff is a separate decision, and a plan can be
    // perfectly sound while this surface refuses to hand out its bytes.
    executionAvailable: Boolean(body.executionAvailable) && flags.mcpPrivateExecutionV1,
    executionUnavailableReason: !flags.mcpPrivateExecutionV1
      ? 'mcp_execution_disabled'
      : (body.executionUnavailableReason ?? null),
    // Said here, not only in the tool description: this payload is what gets
    // quoted back to the user.
    calls: null,
    callsNotice:
      'This response contains no executable calls by design. Ask the user to confirm the review first, then call miorail_get_base_mcp_action.',
    caveats: MIORAIL_PRIVATE_CAVEATS_V1,
  };
}

/**
 * §5 — the persisted calls, in the shape Base MCP `send_calls` speaks.
 *
 * Every condition in §5 is checked by the shared submit gate rather than here,
 * which is what stops this surface being the permissive one. The bytes are the
 * stored bytes: this function has no way to build, alter or reorder a call, and
 * the hash travels with them so the caller can verify it did not.
 */
export async function miorailGetBaseMcpActionV1(
  identity: McpPrivateIdentityV1,
  args: {
    planId: string;
    positionAtomic: string;
    maxRoundTripBps?: number;
    maxExitSlippageBps?: number;
    attemptRequestId: string;
  },
): Promise<Record<string, unknown>> {
  const flags = getMiorailProductMigrationFlags(process.env);
  if (!flags.mcpPrivateExecutionV1) {
    throw new McpPrivateError('mcp_execution_disabled', PRIVATE_REFUSAL_COPY_V1.mcp_execution_disabled);
  }

  const loaded = await loadEntryPlanV1({
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    planId: String(args.planId ?? ''),
  });
  if (!loaded.ok) refuse(loaded);
  const plan = loaded.body;

  const profile = profileV1(args);
  const begun = await beginEntrySubmissionV1({
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    plan,
    chainId: 8453,
    profileIdentity: profileIdentityV1(profile),
    attemptRequestId: String(args.attemptRequestId ?? ''),
  });

  if (begun.outcome === 'refused' || !begun.payload) {
    const reason = begun.reason ?? 'entry_plan_not_found';
    const detail = (begun.body as { detail?: string }).detail;
    await auditV1(identity, {
      toolName: 'miorail_get_base_mcp_action',
      outcome: 'refused',
      planId: plan.id,
      callsHash: plan.callsHash,
    });
    return {
      outcome: 'refused',
      reason,
      detail: detail ?? PRIVATE_REFUSAL_COPY_V1[reason] ?? 'Miorail refused to release this plan’s calls.',
      status: (begun.body as { status?: unknown }).status ?? null,
      // Nothing executable, and nothing to retry into.
      action: null,
      caveats: MIORAIL_PRIVATE_CAVEATS_V1,
    };
  }

  // §2 — the mandatory row, written AFTER the attempt is open and BEFORE a
  // single byte is returned.
  //
  // The ordering is the whole argument. Auditing first would record a release
  // that the gate then refused; auditing after returning would let executable
  // bytes leave a server that has no record of it. So the attempt is opened,
  // the row is written, and only then do the calls exist outside this
  // function.
  //
  // If the row cannot be written, the attempt is CANCELLED rather than left
  // holding the plan — nothing was sent, so the honest state is the one that
  // lets the user try again. If that cancellation also fails, the plan stays
  // locked to an attempt that never released anything, which is the safe
  // direction to fail in.
  try {
    await auditV1(identity, {
      toolName: 'miorail_get_base_mcp_action',
      outcome: 'action_released',
      planId: plan.id,
      callsHash: begun.payload.callsHash,
    });
  } catch (error) {
    if (begun.attemptId) {
      await recordEntrySubmissionV1({
        tenantId: identity.tenantId,
        walletAddress: identity.walletAddress,
        plan,
        attemptId: begun.attemptId,
        result: 'cancelled',
        batchId: null,
      }).catch(() => undefined);
    }
    if (error instanceof McpAuditUnavailableError) {
      throw new McpPrivateError('mcp_audit_unavailable', PRIVATE_REFUSAL_COPY_V1.mcp_audit_unavailable);
    }
    throw error;
  }

  const payload = begun.payload;
  return {
    outcome: 'ready',
    attemptId: begun.attemptId,
    action: {
      // The Base MCP / EIP-5792 shape. Hex chain id, because that is what the
      // wallet contract pins and a number here would be a different assertion.
      chainId: payload.chainId,
      from: payload.from,
      calls: payload.calls,
      atomicRequired: payload.atomicRequired,
    },
    callsHash: payload.callsHash,
    // Recomputed from the bytes being returned, not copied from the column, so
    // a caller can prove the two agree without trusting either field alone.
    callsHashOfReturnedCalls: entryPlanCallsHashV1(plan.calls),
    planId: plan.id,
    expiresAt: plan.expiresAt,
    review: (begun.body as { review?: unknown }).review ?? null,
    instructions:
      'Pass these calls to Base MCP send_calls UNCHANGED. Do not reorder, merge, re-encode, add or drop a call, and do not substitute your own recipient, amount or router — a modified batch no longer matches what Miorail simulated, and Miorail will refuse to record it. Then call miorail_record_base_mcp_submission exactly once with what Base MCP returned.',
    caveats: MIORAIL_PRIVATE_CAVEATS_V1,
  };
}

export const MCP_SUBMISSION_RESULTS_V1 = ['submitted', 'user_rejected', 'unknown'] as const;
export type McpSubmissionResultV1 = (typeof MCP_SUBMISSION_RESULTS_V1)[number];

/**
 * §7 — record what Base MCP reported.
 *
 * Three properties, in the order they matter:
 *
 *   * The calls hash is verified against the stored attempt. A caller reporting
 *     a submission of something else is reporting somebody else's transaction.
 *   * `unknown` never becomes a retry. With a batch id it is recorded as
 *     submitted, because a batch id is exactly what makes the result findable
 *     later; without one, NOTHING is written and the attempt keeps this plan's
 *     only slot, so no second action can ever be issued for it.
 *   * A repeat call returns the stored record rather than transitioning again.
 */
export async function miorailRecordBaseMcpSubmissionV1(
  identity: McpPrivateIdentityV1,
  args: {
    planId: string;
    attemptId: string;
    submittedCallsHash: string;
    result: McpSubmissionResultV1;
    batchId?: string | null;
  },
): Promise<Record<string, unknown>> {
  const loaded = await loadEntryPlanV1({
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    planId: String(args.planId ?? ''),
  });
  if (!loaded.ok) refuse(loaded);
  const plan = loaded.body;

  // Checked before anything is written, and against the STORED plan.
  if (String(args.submittedCallsHash ?? '').toLowerCase() !== plan.callsHash.toLowerCase()) {
    throw new McpPrivateError(
      'submitted_calls_mismatch',
      'The calls hash you reported does not match the plan Miorail prepared. Nothing was recorded. Do not send anything else for this plan — fetch the action again and check what your client submitted.',
    );
  }

  const batchId = typeof args.batchId === 'string' && args.batchId.trim() ? args.batchId.trim() : null;

  // §2 — audited BEFORE the state transition, which is safe here precisely
  // because recording is idempotent: a client that gets the audit refusal
  // retries with the same arguments and reaches the same attempt. Auditing
  // afterwards would mean a batch could be recorded on a server with no record
  // that it was.
  if (args.result === 'user_rejected') {
    await auditV1(identity, {
      toolName: 'miorail_record_base_mcp_submission',
      outcome: 'user_rejected',
      planId: plan.id,
      callsHash: plan.callsHash,
    });
  } else {
    try {
      await auditV1(identity, {
        toolName: 'miorail_record_base_mcp_submission',
        outcome: batchId ? 'submission_recorded' : 'submitted_unknown',
        planId: plan.id,
        callsHash: plan.callsHash,
        batchId,
      });
    } catch (error) {
      if (error instanceof McpAuditUnavailableError) {
        throw new McpPrivateError('mcp_audit_unavailable', PRIVATE_REFUSAL_COPY_V1.mcp_audit_unavailable);
      }
      throw error;
    }
  }

  if (args.result === 'unknown' && !batchId) {
    // The one case the storage schema deliberately cannot express: a terminal
    // "unknown" is a claim about a batch, and there is no batch id to claim it
    // about. Rather than invent a state, Miorail writes nothing — the attempt
    // stays open, which keeps this plan's single slot occupied and means no
    // second action can be issued for it.
    const status = await readEntryPlanStatusV1({ tenantId: identity.tenantId, plan });
    return {
      outcome: 'not_recorded',
      reason: 'unknown_without_batch_id',
      detail:
        'Base MCP returned no batch id, so Miorail has nothing it could check on chain and has recorded nothing. The plan stays locked to this attempt and will not be offered again. Ask the user to check their wallet activity; do not send anything else for this plan.',
      ...status,
      caveats: MIORAIL_PRIVATE_CAVEATS_V1,
    };
  }

  const recorded = await recordEntrySubmissionV1({
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    plan,
    attemptId: String(args.attemptId ?? ''),
    // `unknown` WITH a batch id is a submission whose result is not yet known —
    // which is exactly what `submitted` means. The unresolved outcome comes
    // from reconciliation, not from a caller asserting it.
    result: args.result === 'user_rejected' ? 'user_rejected' : 'submitted',
    batchId: args.result === 'user_rejected' ? null : batchId,
  });
  if (!recorded.ok) refuse(recorded);

  return {
    outcome: 'recorded',
    reportedResult: args.result,
    ...(recorded.body as Record<string, unknown>),
    guidance:
      args.result === 'user_rejected'
        ? 'Nothing reached the chain. The user declined; do not resend unless they ask.'
        : 'Miorail recorded the batch. Call miorail_get_execution_status to find out what it did — a wallet approval is not an entry.',
    caveats: MIORAIL_PRIVATE_CAVEATS_V1,
  };
}

/**
 * §8 — where it got to, through the existing reconciliation projection.
 *
 * The named outcomes are the shared `entryUiStateV1` states, unchanged. In
 * particular a confirmed approval WITHOUT the expected B20 receipt is never
 * `entry_succeeded`: that determination belongs to reconciliation, which
 * compares the wallet's own decoded movements against the plan.
 */
export async function miorailGetExecutionStatusV1(
  identity: McpPrivateIdentityV1,
  args: { planId: string },
): Promise<Record<string, unknown>> {
  const loaded = await loadEntryPlanV1({
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    planId: String(args.planId ?? ''),
  });
  if (!loaded.ok) refuse(loaded);

  const status = await readEntryPlanStatusV1({ tenantId: identity.tenantId, plan: loaded.body });
  const state = (status.status as { state?: string } | undefined)?.state ?? null;
  // §1 — the reconciled outcomes have their own audit vocabulary, so the trail
  // ends with what actually happened rather than stopping at "a batch was
  // recorded". Best-effort: a user asking where their entry got to must be
  // told, even if the audit is unavailable.
  await auditV1(identity, {
    toolName: 'miorail_get_execution_status',
    outcome: STATE_AUDIT_OUTCOME_V1[state ?? ''] ?? 'plan_read',
    planId: loaded.body.id,
    callsHash: loaded.body.callsHash,
    batchId: (status.status as { batchId?: string | null } | undefined)?.batchId ?? null,
  });
  return {
    ...status,
    stateMeaning: state ? (EXECUTION_STATE_COPY_V1[state] ?? null) : null,
    caveats: MIORAIL_PRIVATE_CAVEATS_V1,
  };
}

/**
 * §1 — the reconciled states that have an audit outcome of their own.
 *
 * Anything not listed here is an ordinary read of a plan, which is what
 * `plan_read` means. Mapping every state onto a distinct outcome would have
 * meant inventing vocabulary the migration does not allow.
 */
export const STATE_AUDIT_OUTCOME_V1: Record<string, McpAuditOutcomeV1> = {
  entry_succeeded: 'entry_succeeded',
  entry_reverted: 'entry_reverted',
  reconciliation_required: 'reconciliation_required',
  submitted_unknown: 'submitted_unknown',
  user_rejected: 'user_rejected',
};

/** §8 — one sentence per named outcome, so an assistant reports the state it
 * was given rather than the state it expected. */
export const EXECUTION_STATE_COPY_V1: Record<string, string> = {
  preparing: 'Miorail is still building this plan. Nothing has been offered to a wallet.',
  review: 'The plan is prepared and waiting. Nothing has been sent.',
  expired: 'The plan expired before it was submitted. Nothing was sent. A new check is needed.',
  awaiting_wallet_approval:
    'The calls were handed out and Miorail is waiting to hear what the wallet did. Do not send again.',
  user_rejected: 'The user declined in their wallet. Nothing reached the chain.',
  submitted: 'A batch was submitted. Whether the entry happened is NOT yet established.',
  reconciling: 'Miorail is checking on chain what the batch actually did. Do not send again.',
  entry_succeeded:
    'The entry executed and Miorail verified the wallet’s own decoded movements: it spent USDC and received the token.',
  entry_reverted: 'The batch reached the chain and reverted. No token was received.',
  submitted_unknown:
    'A batch was sent and Miorail could not establish what it did. This is NOT a failure and NOT a success. Never resend on this state — ask the user to check their wallet.',
  reconciliation_required:
    'The batch was confirmed but the expected token receipt was not found in it. A confirmed approval is not an entry. This needs a person to look.',
};

// ---------------------------------------------------------------------------
// Connected Intelligence 1 — the stock action draft.
//
// The one stock-native primitive on this surface, and deliberately the
// narrowest thing that can be called a prepare: it establishes WHICH exact
// representation and WHICH exact question a review will be about, mints a
// short-lived wallet-bound draft, and returns a link.
//
// It returns no financial terms at all. Not "roughly", not "as of a minute
// ago" — none. An assistant that knew the cash figure would repeat it in its
// own prose, and that prose is the one surface Miorail does not control: the
// user would then approve a number they read in a chat window rather than the
// number the review page derived. So the assistant is allowed to know what is
// being reviewed and not what it costs.
//
// It also creates nothing executable. `miorail_get_base_mcp_action` is
// unchanged and still reachable only through the B20 entry path, which requires
// its own clearance and its own confirmed review.
// ---------------------------------------------------------------------------

/**
 * The seam Connected Intelligence 1 is tested through.
 *
 * Assembly, the handoff rule, the clock, the signing secret and the public
 * origin, in one object a test can replace. Nothing here is a new source of
 * truth: `assembleMarketReality` and `handoff` are the SAME functions the web
 * page calls, so an assistant and a browser cannot be told different things
 * about which representations exist.
 */
export const stockActionRuntime = {
  assembleMarketReality: async (question: {
    underlyingKey: string;
    direction: 'buy' | 'sell';
    requestedCashAtomic: string;
    destination: 'USDC';
  }): Promise<unknown> =>
    rwaMarketRealityRuntime.assemble(
      {
        underlyings: rwaMarketRealityRuntime.underlyings(),
        cashExit: rwaMarketRealityRuntime.cashExit(),
        ratios: rwaMarketRealityRuntime.ratios(),
        supplies: rwaMarketRealityRuntime.supplies(),
        now: rwaMarketRealityRuntime.now,
        reference: rwaMarketRealityRuntime.reference(),
      },
      question,
    ),
  handoff: (input: {
    response: never;
    tokenAddress: string;
    now: Date;
  }): StockExecutionHandoffResultV1 => stockExecutionHandoffV1(input),
  issue: issueStockActionDraftV1,
  now: () => new Date(),
  secret: (): string | null => {
    const secret = (process.env.SESSION_SECRET ?? '').trim();
    return secret.length > 0 ? secret : null;
  },
  origin: (): string =>
    (process.env.MIORAIL_PUBLIC_ORIGIN ?? 'https://miorail.xyz').replace(/\/+$/, ''),
  /**
   * The two flags this surface is gated on.
   *
   * A seam like every other dependency here, and for a reason a test found:
   * files in one package share a process, so `process.env` is global mutable
   * state that another file's teardown can clear in the middle of a call. A
   * gate that a neighbour can flip is not a gate.
   */
  flags: () => {
    const resolved = getMiorailProductMigrationFlags(process.env);
    return {
      routeIntelligenceV1: resolved.routeIntelligenceV1,
      mcpPrivateExecutionV1: resolved.mcpPrivateExecutionV1,
    };
  },
  verifyClearance: verifyStockActionClearanceV1,
  intent: stockActionIntentV1,
  /**
   * `decimals()` and `symbol()` for the exact representation, read on chain.
   *
   * A representation binding does not carry them, and a wrong decimals turns an
   * exact size into a different size entirely. Supplied as a seam so a test can
   * hand in a token without opening an RPC.
   */
  readToken: async (
    tokenAddress: string,
  ): Promise<{ ok: true; decimals: number; symbol: string } | { ok: false }> => {
    const { readStockRepresentationTokenV1 } = await import('../../lib/stockTokenRead.js');
    return readStockRepresentationTokenV1(tokenAddress);
  },
  /**
   * Plan and prepare, through the path the web console already uses.
   *
   * The resolver is deterministic — it returns the intent this clearance
   * describes and reads no words at all — and everything after it is shared:
   * route run, adapters, engine, card, composer, Safety Kernel, blueprint.
   */
  planAndPrepare: async (input: {
    intent: RouteIntentV1;
    tenantId: string;
    walletAddress: `0x${string}`;
    requestId: string;
    now: Date;
  }): Promise<TransactionPreparationResultV1> => {
    const { prepareStockActionBlueprintV1 } = await import('../routeIntelligence.js');
    return prepareStockActionBlueprintV1(input);
  },
};

export const STOCK_ACTION_REFUSAL_COPY_V1: Record<string, string> = {
  stock_action_disabled:
    'Route intelligence is switched off on this server, so no representation can be prepared. That is a statement about this deployment, not about the security.',
  stock_action_unknown_security:
    'Miorail holds no reviewed representation graph for that underlying key. Nothing was substituted.',
  representation_not_reviewed:
    'That exact address is not one of the reviewed representations for that security at that question. Miorail did not substitute another one.',
  zero_supply_representation:
    'That representation has no outstanding supply, so there is no position to act on. Miorail will not redirect to its wrapper, its underlying, or another issuer — those are different contracts and a different question.',
  supply_not_established:
    'Outstanding supply for that representation is not established, so Miorail will not prepare an action against it.',
  route_policy_not_established:
    'No reviewed route policy is established for that representation at that question.',
  destination_not_supported: 'Only USDC-denominated reviewed questions can be prepared.',
  stock_action_identity_mismatch:
    'One of the identity fields you supplied does not match Miorail’s reviewed evidence for that exact address. Nothing was prepared. Re-read the representation and pass the fields exactly as Miorail returned them.',
  stock_action_secret_unavailable:
    'This server cannot sign an action draft right now, so nothing was prepared.',
};

/** The exact identity a caller must state, and Miorail must confirm. */
export interface StockActionArgsV1 {
  chainId: number;
  tokenAddress: string;
  underlyingKey: string;
  issuerId: string;
  issuerInstrumentKey: string;
  representationKind: string;
  direction: string;
  requestedCashAtomic: string;
  destination: string;
  routePolicyKey: string;
}

function stockActionRefusalV1(code: string): McpPrivateError {
  return new McpPrivateError(
    code,
    STOCK_ACTION_REFUSAL_COPY_V1[code] ?? 'Miorail refused that request.',
  );
}

/**
 * Prepare a review of ONE exact reviewed representation.
 *
 * Every identity field the caller supplied is checked against what canonical
 * Stocks evidence says about that address. A model that guessed an issuer, or
 * carried a route policy over from another size, is refused rather than
 * silently corrected — a correction here would be Miorail choosing a different
 * contract than the one the conversation was about.
 */
export async function miorailPrepareStockActionV1(
  identity: McpPrivateIdentityV1,
  args: StockActionArgsV1,
): Promise<Record<string, unknown>> {
  if (!stockActionRuntime.flags().routeIntelligenceV1) {
    throw stockActionRefusalV1('stock_action_disabled');
  }
  if (Number(args.chainId) !== 8453) throw stockActionRefusalV1('representation_not_reviewed');
  if (String(args.destination) !== 'USDC') throw stockActionRefusalV1('destination_not_supported');

  const tokenAddress = String(args.tokenAddress ?? '').trim().toLowerCase();
  // A ticker can never select a representation: 61.7% of launches share a
  // symbol, and two different CHEESEBURGE contracts once sat on one screen.
  if (!/^0x[0-9a-f]{40}$/.test(tokenAddress)) {
    throw stockActionRefusalV1('representation_not_reviewed');
  }

  const runtime = stockActionRuntime;
  let response: unknown;
  try {
    response = await runtime.assembleMarketReality({
      underlyingKey: String(args.underlyingKey ?? ''),
      direction: String(args.direction ?? '') === 'buy' ? 'buy' : 'sell',
      requestedCashAtomic: String(args.requestedCashAtomic ?? ''),
      destination: 'USDC',
    });
  } catch {
    throw stockActionRefusalV1('stock_action_unknown_security');
  }

  const built = runtime.handoff({
    response: response as never,
    tokenAddress,
    now: runtime.now(),
  });
  if (built.status === 'refused') throw stockActionRefusalV1(built.reason);

  const handoff = built.handoff;
  // The caller stated an identity; canonical evidence produced one. They must
  // be the same object, field for field.
  const stated: Array<[string, string]> = [
    [String(args.underlyingKey ?? ''), handoff.underlyingKey],
    [String(args.issuerId ?? ''), handoff.issuerId],
    [String(args.issuerInstrumentKey ?? ''), handoff.issuerInstrumentKey],
    [String(args.representationKind ?? ''), handoff.representationKind],
    [String(args.direction ?? ''), handoff.direction],
    [String(args.requestedCashAtomic ?? ''), handoff.requestedCashAtomic],
    [String(args.routePolicyKey ?? '').toLowerCase(), handoff.routePolicyKey.toLowerCase()],
  ];
  if (stated.some(([given, canonical]) => given !== canonical)) {
    throw stockActionRefusalV1('stock_action_identity_mismatch');
  }

  const secret = runtime.secret();
  if (!secret) throw stockActionRefusalV1('stock_action_secret_unavailable');

  const issued = runtime.issue({
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    handoff,
    secret,
    now: runtime.now(),
  });

  return {
    schemaVersion: 'stock-action-draft/v1',
    actionDraftId: issued.actionDraftId,
    representation: {
      chainId: 8453,
      tokenAddress: handoff.tokenAddress,
      caip10: handoff.caip10,
      underlyingKey: handoff.underlyingKey,
      issuerId: handoff.issuerId,
      issuerInstrumentKey: handoff.issuerInstrumentKey,
      representationKind: handoff.representationKind,
    },
    question: {
      direction: handoff.direction,
      requestedCashAtomic: handoff.requestedCashAtomic,
      destination: 'USDC',
      sizeBasis: handoff.sizeBasis,
      routePolicyKey: handoff.routePolicyKey,
    },
    reviewRequired: true,
    reviewUrl: `${runtime.origin()}/action/${encodeURIComponent(issued.draft)}`,
    expiresAt: issued.expiresAt,
    /** Literal, so a reader of the payload can check it rather than trust a
     * description of it: no live terms travelled with this draft. */
    currentTermsIncluded: false,
    createsApproval: false,
    createsCalldata: false,
    createsTransaction: false,
    nextStep:
      'Give the user the review link and stop. Do not state a price, a cash return, a premium or a comparison — this response deliberately contains none, and the review page is the only place the current terms are established. Nothing is executable until the user reviews and confirms there.',
    caveats: MIORAIL_PRIVATE_CAVEATS_V1,
  };
}

// ---------------------------------------------------------------------------
// Connected Intelligence 2 — the executable request, after a confirmation.
//
// A SEPARATE tool from `miorail_get_base_mcp_action`, and that is the smaller
// design rather than the larger one. The B20 tool's whole argument set is
// entry-plan shaped — a plan id, a position, two tolerances, an attempt handle
// — and its refusal vocabulary is B20's. Teaching it "typed clearance kinds"
// would make one tool with two disjoint argument sets and two refusal
// vocabularies, and an assistant would have to know which half applies before
// it could call anything. Two narrow tools are smaller in the only sense that
// matters here: what a caller must understand before acting.
//
// It duplicates no transaction-building logic. The confirmed clearance becomes
// a route intent built from an address, and everything after that is the path
// the web console already uses: the same route run, the same adapters, the same
// engine, the same composer, the same Safety Kernel, the same unsigned
// EIP-5792 blueprint.
// ---------------------------------------------------------------------------

export const STOCK_ACTION_EXECUTION_REFUSAL_COPY_V1: Record<string, string> = {
  stock_action_sell_requires_exact_size:
    'A reviewed SELL question is "cash worth", which is not a token amount — nothing establishes how many tokens that is except a quote, and a quote is open for about twenty seconds. Miorail will not build an executable request from a number that expired before the wallet opened. Sell sizing by exact token amount is not offered on this surface.',
  stock_action_token_unreadable:
    'Miorail could not read this representation’s decimals and symbol on chain, and it will not assume them: a wrong decimals turns an exact size into a different size entirely.',
  stock_action_route_unavailable:
    'No route was found for this exact confirmed question through the reviewed sources. Nothing was prepared.',
  stock_action_refresh_required:
    'The market moved after this was confirmed. Miorail will not offer the old request — review the current terms again.',
  stock_action_blocked:
    'Miorail’s Safety Kernel refused this plan. Nothing executable was produced.',
};

export interface StockActionExecutionArgsV1 {
  clearance: string;
  requestId: string;
}

/**
 * Turn a CONFIRMED stock clearance into the existing unsigned Base MCP request.
 */
export async function miorailGetStockBaseMcpActionV1(
  identity: McpPrivateIdentityV1,
  args: StockActionExecutionArgsV1,
): Promise<Record<string, unknown>> {
  const flags = stockActionRuntime.flags();
  if (!flags.routeIntelligenceV1) throw stockActionRefusalV1('stock_action_disabled');
  if (!flags.mcpPrivateExecutionV1) {
    throw new McpPrivateError(
      'mcp_execution_disabled',
      PRIVATE_REFUSAL_COPY_V1.mcp_execution_disabled,
    );
  }

  const runtime = stockActionRuntime;
  const secret = runtime.secret();
  if (!secret) throw stockActionRefusalV1('stock_action_secret_unavailable');

  // The tenant is the PROVED one. A clearance minted for another wallet and
  // presented under this token is a refusal, never a lookup.
  const verified = runtime.verifyClearance({
    clearance: String(args.clearance ?? ''),
    secret,
    now: runtime.now(),
    expectTenantId: identity.tenantId,
  });
  if (!verified.ok) {
    throw new McpPrivateError(
      verified.reason,
      STOCK_ACTION_CLEARANCE_REFUSAL_COPY_V1[verified.reason],
    );
  }
  const clearance = verified.claims;

  const token = await runtime.readToken(clearance.tokenAddress);
  if (!token.ok) throw stockActionExecutionRefusalV1('stock_action_token_unreadable');

  const built = runtime.intent({
    clearance,
    tokenDecimals: token.decimals,
    tokenSymbol: token.symbol,
    requestId: String(args.requestId ?? ''),
    now: runtime.now(),
  });
  if (!built.ok) throw stockActionExecutionRefusalV1(built.reason);

  const prepared = await runtime.planAndPrepare({
    intent: built.intent,
    tenantId: identity.tenantId,
    walletAddress: identity.walletAddress,
    requestId: String(args.requestId ?? ''),
    now: runtime.now(),
  });

  if (prepared.outcome === 'refresh_required') {
    throw stockActionExecutionRefusalV1('stock_action_refresh_required');
  }
  if (prepared.outcome === 'unsupported') {
    throw stockActionExecutionRefusalV1('stock_action_route_unavailable');
  }
  if (prepared.outcome === 'blocked') {
    // The kernel knows WHY and the client is not told, deliberately: a refusal
    // on an execution surface must not narrate its own checks to a caller.
    // The server had no record either, which is a different problem — the
    // acceptance smoke hit this refusal and the only way to learn the cause
    // was to read the wallet's balance on chain by hand.
    //
    // Logged: the ids of the checks that FAILED. Our own check identifiers,
    // never `blockedReason` or a check's `detail` — those are free text and a
    // provider message can end up in free text.
    // Read defensively, and never let this line decide the outcome. A refusal
    // is the safe path; a logger that throws on an unexpected shape turns it
    // into a crash, which is strictly worse than not logging. Caught in gates:
    // the first version read `.checks` straight and a stub without it made a
    // clean refusal fail as a TypeError.
    const failedChecks = Array.isArray(prepared.safety?.checks)
      ? prepared.safety.checks
          .filter((check) => check?.status === 'failed')
          .map((check) => check.id)
          .slice(0, 8)
      : null;
    // And WHICH simulation outcome, when that is the check that failed.
    //
    // `simulation_evidence` has five mutually exclusive causes — passed,
    // reverted, insufficient funds, the call shape refused, no provider
    // answered — and the check id names none of them. A production refusal on
    // 2026-09-04 cost an hour of SSH, an on-chain balance read and a hand-built
    // batch simulation to get no further than "one of four", because the id was
    // all that was recorded.
    //
    // It is the OUTCOME enum, not the detail: a closed vocabulary this codebase
    // owns, so the standing rule holds — no provider message and no free text
    // can arrive here.
    const simulationOutcome = prepared.simulation
      ? classifySimulationOutcomeV1(prepared.simulation)
      : null;
    logger.warn('Stock action blocked by the Safety Kernel', {
      tenantId: identity.tenantId,
      tokenAddress: clearance.tokenAddress,
      failedChecks,
      simulationOutcome,
      // The stored status and OUR failure code — `provider_rate_limited`,
      // `provider_method_unsupported`, `provider_insufficient_funds` and the
      // rest are a union this codebase declares, so no endpoint, key or
      // upstream sentence can arrive through this field.
      simulationStatus: prepared.simulation?.status ?? null,
      simulationErrorCode: prepared.simulation?.errorCode ?? null,
    });
    throw stockActionExecutionRefusalV1('stock_action_blocked');
  }

  await auditV1(identity, {
    toolName: 'miorail_get_stock_base_mcp_action',
    outcome: 'action_released',
    planId: prepared.blueprint.id,
    callsHash: prepared.blueprint.blueprintHash,
  });

  return {
    schemaVersion: 'stock-action-execution/v1',
    outcome: 'ready',
    clearanceId: clearance.clearanceId,
    actionDraftId: clearance.actionDraftId,
    representation: {
      chainId: 8453,
      tokenAddress: clearance.tokenAddress,
      caip10: clearance.caip10,
      underlyingKey: clearance.underlyingKey,
      issuerId: clearance.issuerId,
      issuerInstrumentKey: clearance.issuerInstrumentKey,
      representationKind: clearance.representationKind,
    },
    action: {
      chainId: prepared.blueprint.chainId,
      from: prepared.blueprint.walletAddress,
      calls: prepared.blueprint.calls,
      atomicRequired: true,
    },
    blueprintId: prepared.blueprint.id,
    blueprintHash: prepared.blueprint.blueprintHash,
    routeRunId: prepared.routeRunId,
    blueprintStatus: prepared.blueprint.status,
    reviewConfirmed: true,
    approvalRequired: true,
    instructions:
      'Pass these calls to Base MCP send_calls UNCHANGED. Do not reorder, merge, re-encode, add or drop a call, and do not substitute your own recipient, amount or router — a modified batch no longer matches what Miorail simulated. Do not describe the terms: the review surface established them and is the only place they are current.',
    caveats: MIORAIL_PRIVATE_CAVEATS_V1,
  };
}

function stockActionExecutionRefusalV1(code: string): McpPrivateError {
  return new McpPrivateError(
    code,
    STOCK_ACTION_EXECUTION_REFUSAL_COPY_V1[code] ?? 'Miorail refused that request.',
  );
}
