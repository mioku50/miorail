import {
  PERMISSION_REFUSAL_COPY_V1,
  verifySpendPermissionV1,
  type PermissionRefusalV1,
  type SpendPermissionClaimV1,
} from '@mioagent/intelligence-budget';
import type { SpendPermission, SpendPermissionRepository } from '@mioagent/autonomy';
import {
  PAID_EVIDENCE_MIN_PERIOD_SECONDS_V1,
  PermissionStatusUnavailableError,
  paidEvidenceTokenV1,
  type SpendPermissionVerifierV1,
} from './spendPermissionVerifier.js';

// ---------------------------------------------------------------------------
// T71 §4 — turning a wallet signature into a budget, or into nothing.
//
// The rule the whole module exists to enforce: NOTHING is written before the
// chain has confirmed the permission. Not the permission record, not the
// budget, not a placeholder. A row created "pending verification" is a DB-only
// permission by another name — §10 forbids exactly that — and it is the kind of
// row a later bug reads as authorisation.
//
// So the order is fixed: derive the hash from the claim's own fields (an
// on-chain read), verify the binding against server-held values, ask the chain
// what it knows, and only then write. The three failure kinds stay distinct all
// the way to the user:
//
//   refused                  — the chain or the binding said no. Never retry.
//   verification_unavailable — the chain could not be asked. Retrying may work.
//   activated                — there is a budget, and it is bound to a
//                              permission that exists on Base.
// ---------------------------------------------------------------------------

/** The wallet grants for a whole period; the product asks for exactly its own
 * monthly ceiling. Requesting more would be Miorail taking authority it has
 * already said it will not use. */
export const PAID_EVIDENCE_PERIOD_DAYS_V1 = 30;

export const PAID_EVIDENCE_DEFAULT_MONTHLY_USDC_V1 = '3.00';
export const PAID_EVIDENCE_DEFAULT_PER_REQUEST_USDC_V1 = '0.02';

export interface PreparedSpendPermissionV1 {
  account: string;
  spender: string;
  token: string;
  chainId: 8453;
  allowanceAtomic: string;
  periodInDays: number;
  consent: string[];
  recipientLabel: string;
}

/**
 * What the client should ask the wallet for.
 *
 * Every field is resolved here. The client passes them to
 * `requestSpendPermission` unchanged and cannot usefully do otherwise: altering
 * any of them produces a permission that fails `verifySpendPermissionV1`,
 * because that function compares against these same server-held values rather
 * than against anything the client sends back.
 */
export async function prepareSpendPermissionV1(input: {
  walletAddress: string;
  periodLimitAtomic: string;
  periodLimitUsdc: string;
  maxPerCallUsdc: string;
  verifier: SpendPermissionVerifierV1;
}): Promise<PreparedSpendPermissionV1> {
  const spender = await input.verifier.spenderAddress();
  return {
    account: input.walletAddress,
    spender,
    token: paidEvidenceTokenV1(),
    chainId: 8453,
    // Exactly the monthly ceiling. `verifyPermissionBindingV1` refuses an
    // allowance BELOW the limit, so this is the smallest grant that can work.
    allowanceAtomic: input.periodLimitAtomic,
    periodInDays: PAID_EVIDENCE_PERIOD_DAYS_V1,
    consent: [
      `Miorail may charge up to ${input.periodLimitUsdc} USDC per month.`,
      `No single request may cost more than ${input.maxPerCallUsdc} USDC.`,
      'Your Base Account signs this permission. Miorail never signs for you, and you can pause or revoke it here at any time.',
    ],
    recipientLabel: 'Miorail service wallet',
  };
}

export type ConfirmOutcomeV1 =
  | { outcome: 'activated'; permissionId: string; permissionRecord: SpendPermission }
  | { outcome: 'refused'; refusal: PermissionRefusalV1; detail: string; retryable: boolean }
  | { outcome: 'verification_unavailable'; detail: string; retryable: true };

/**
 * The refusals worth trying again.
 *
 * `not_approved_onchain` is the one that matters: a wallet can return a signed
 * permission a moment before the chain has it, and telling that user their
 * wallet did something wrong would be false. Everything else is a statement
 * about what was signed, and signing it again changes nothing.
 */
const RETRYABLE_REFUSALS_V1: readonly PermissionRefusalV1[] = ['not_approved_onchain', 'permission_inactive'];

export function refusalIsRetryableV1(refusal: PermissionRefusalV1): boolean {
  return RETRYABLE_REFUSALS_V1.includes(refusal);
}

/**
 * Verifies a wallet-signed permission and, only if it holds up, records it.
 *
 * The permission record's id IS the server-derived hash. That is not a
 * convention: it means the row cannot be about a different permission than the
 * one the chain confirmed, and a second confirmation of the same grant collides
 * onto the same id rather than creating a second authorisation.
 */
export async function confirmSpendPermissionV1(input: {
  tenantId: string;
  walletAddress: string;
  claim: SpendPermissionClaimV1;
  periodLimitAtomic: string;
  now: Date;
  verifier: SpendPermissionVerifierV1;
  permissions: SpendPermissionRepository;
}): Promise<ConfirmOutcomeV1> {
  let derivedHash: string;
  let status: Awaited<ReturnType<SpendPermissionVerifierV1['status']>>;
  let spender: string;
  try {
    // The spender comes from the same source the charger later draws with.
    // Resolving it any other way would let a permission verify here and be
    // unusable at charge time — the user would have signed something, been
    // told it worked, and found out a month later.
    spender = await input.verifier.spenderAddress();
    derivedHash = await input.verifier.derivedHash(input.claim);
    status = await input.verifier.status(input.claim);
  } catch (error) {
    if (error instanceof PermissionStatusUnavailableError) {
      return {
        outcome: 'verification_unavailable',
        detail:
          'Miorail could not reach Base to check this permission, so it did not create a budget. Your wallet is unaffected and nothing was charged — try again shortly.',
        retryable: true,
      };
    }
    throw error;
  }

  const verified = verifySpendPermissionV1({
    claim: input.claim,
    expected: {
      // From the SESSION, never the body.
      walletAddress: input.walletAddress,
      chainId: 8453,
      token: paidEvidenceTokenV1(),
      spender,
      periodLimitAtomic: input.periodLimitAtomic,
      minimumPeriodSeconds: PAID_EVIDENCE_MIN_PERIOD_SECONDS_V1,
      now: input.now,
    },
    derivedHash,
    status,
  });
  if (!verified.ok) {
    return {
      outcome: 'refused',
      refusal: verified.refusal,
      detail: PERMISSION_REFUSAL_COPY_V1[verified.refusal],
      retryable: refusalIsRetryableV1(verified.refusal),
    };
  }

  // Only now. The id is the chain's own identity for this permission, so a
  // repeat confirmation addresses the same row rather than creating a second.
  const permissionId = derivedHash.toLowerCase();

  // And a repeat confirmation must not REWRITE it. `create` is an upsert that
  // sets `spent` from the incoming record, so calling it again on a permission
  // that has already been drawn against would reset the ledger to zero and hand
  // the wallet its whole monthly allowance back. A double-click would do it.
  const existing = await input.permissions.getById(permissionId);
  if (existing) {
    if (existing.userId !== input.tenantId) {
      // Somebody else's wallet already bound this permission. Unreachable while
      // `account` is checked against the session, and refused anyway rather
      // than reassigned.
      return {
        outcome: 'refused',
        refusal: 'wallet_mismatch',
        detail: PERMISSION_REFUSAL_COPY_V1.wallet_mismatch,
        retryable: false,
      };
    }
    // Reactivated rather than recreated: a permission the user revoked here and
    // then re-granted on-chain is the same permission, and its spend history is
    // not something a confirmation should erase.
    if (!existing.isActive) await input.permissions.setActive(permissionId, true);
    return {
      outcome: 'activated',
      permissionId,
      permissionRecord: { ...existing, isActive: true },
    };
  }

  const record: SpendPermission = {
    id: permissionId,
    userId: input.tenantId,
    chainId: 8453,
    asset: paidEvidenceTokenV1(),
    // The chain's own allowance, not the requested limit: if the wallet granted
    // more, the permission record says what was actually granted.
    limit: Number(input.claim.permission.allowance),
    spent: 0,
    // Empty by construction. This permission funds paid evidence through the
    // configured recipient; a whitelist here would suggest it could fund
    // something else.
    whitelist: [],
    expiresAt: input.claim.permission.end * 1000,
    isActive: true,
  };
  await input.permissions.create(record);
  return { outcome: 'activated', permissionId, permissionRecord: record };
}
