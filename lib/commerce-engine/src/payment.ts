import {
  CommercePaymentBlueprintV1Schema,
  hashApprovedCallsV1,
  hashCommercePaymentBlueprintV1,
  ZERO_HASH_V1,
  type CommerceCandidateV1,
  type CommerceInvoiceV1,
  type CommerceOrderV1,
  type CommercePaymentBlueprintV1,
  type CommerceRouteIntentV1,
  type ExecutionCallV1,
  type SafetyKernelCheckV1,
  type SafetyKernelResultV1,
} from '@mioagent/route-domain';
import { COMMERCE_MAX_ORDER_ATOMIC_V1, COMMERCE_USDC_ADDRESS_V1 } from './pinned-config.js';
import { normalizeAddressV1 } from './normalization.js';
import type { CommerceFailureReasonV1 } from './types.js';

// ---------------------------------------------------------------------------
// T64.3 §3 — the exact payment call, and the kernel that re-checks it.
//
// ONE call: USDC.transfer(invoice recipient, exact invoice amount). No
// approval, no allowance, no second call, no native value, no arbitrary
// target, and NO Builder Code suffix — appending bytes to ERC-20 calldata
// would change what the token contract executes.
// ---------------------------------------------------------------------------

/** `transfer(address,uint256)`. */
export const ERC20_TRANSFER_SELECTOR_V1 = '0xa9059cbb';

function padHex32(value: string): string {
  return value.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/**
 * ERC-20 transfer calldata, built from the two values and nothing else.
 *
 * Deliberately hand-encoded rather than taken from a helper that might append
 * an attribution suffix: this calldata is what a token contract executes, and
 * a trailing byte is not decoration.
 */
export function encodeUsdcTransferCallDataV1(input: {
  recipient: string;
  amountAtomic: string;
}): `0x${string}` | null {
  const recipient = normalizeAddressV1(input.recipient);
  if (recipient === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(input.amountAtomic)) return null;
  const amount = BigInt(input.amountAtomic);
  if (amount <= BigInt(0)) return null;
  return `${ERC20_TRANSFER_SELECTOR_V1}${padHex32(recipient)}${padHex32(amount.toString(16))}` as `0x${string}`;
}

/** Decodes calldata this module produced, so a check can read what will
 * actually run rather than what the caller claims. */
export function decodeUsdcTransferCallDataV1(
  data: string,
): { recipient: `0x${string}`; amountAtomic: string } | null {
  const value = data.toLowerCase();
  if (!value.startsWith(ERC20_TRANSFER_SELECTOR_V1)) return null;
  const body = value.slice(ERC20_TRANSFER_SELECTOR_V1.length);
  // Exactly two 32-byte words: a longer payload is a different call.
  if (body.length !== 128) return null;
  const recipientWord = body.slice(0, 64);
  if (!/^0{24}[0-9a-f]{40}$/.test(recipientWord)) return null;
  const amountWord = body.slice(64);
  if (!/^[0-9a-f]{64}$/.test(amountWord)) return null;
  return {
    recipient: `0x${recipientWord.slice(24)}` as `0x${string}`,
    amountAtomic: BigInt(`0x${amountWord}`).toString(),
  };
}

export function buildCommercePaymentCallV1(input: {
  recipient: string;
  amountAtomic: string;
}): ExecutionCallV1 | null {
  const recipient = normalizeAddressV1(input.recipient);
  const data = encodeUsdcTransferCallDataV1(input);
  if (recipient === null || data === null) return null;
  return {
    index: 0,
    callType: 'transfer',
    to: COMMERCE_USDC_ADDRESS_V1,
    valueWei: '0',
    data,
    asset: {
      assetId: `eip155:8453/erc20:${COMMERCE_USDC_ADDRESS_V1}`,
      chainId: 8453,
      kind: 'erc20',
      address: COMMERCE_USDC_ADDRESS_V1,
      symbol: 'USDC',
      decimals: 6,
    },
    amountAtomic: input.amountAtomic,
    recipient,
    spender: null,
  };
}

// --- Invoice revalidation (§2) ----------------------------------------------

export type CommerceRevalidationResultV1 =
  | { ok: true }
  | { ok: false; reason: 'invoice_changed' | 'invoice_expired' | CommerceFailureReasonV1; detail: string };

export interface RevalidateCommerceInvoiceInputV1 {
  /** What the provider says RIGHT NOW. */
  fresh: {
    invoiceId: string;
    paymentStatus: string;
    method: string;
    currency: string;
    amountAtomic: string | null;
    recipient: string | null;
    expiresAt: string | null;
    productId?: string;
    packageValue?: string;
  };
  /** What was persisted when the invoice was created and reviewed. */
  persisted: CommerceInvoiceV1;
  order: CommerceOrderV1;
  intent: CommerceRouteIntentV1;
  candidate: CommerceCandidateV1;
  authenticatedWallet: string;
  now: Date;
}

/**
 * The last read before a Blueprint exists.
 *
 * A changed amount or recipient is `invoice_changed` and STOPS here — it never
 * opens a replacement invoice, because doing that automatically is how a user
 * ends up owing for two.
 */
export function revalidateCommerceInvoiceV1(
  input: RevalidateCommerceInvoiceInputV1,
): CommerceRevalidationResultV1 {
  const { fresh, persisted } = input;
  const changed = (detail: string): CommerceRevalidationResultV1 => ({ ok: false, reason: 'invoice_changed', detail });

  if (fresh.invoiceId !== persisted.invoiceId) return changed('The provider returned a different invoice id.');
  if (fresh.paymentStatus.trim().toLowerCase() !== 'unpaid') {
    return changed(`The invoice is no longer unpaid (${fresh.paymentStatus}).`);
  }
  if (fresh.method.trim().toLowerCase() !== 'usdc_base') {
    return changed(`The invoice now settles on ${fresh.method}, not usdc_base.`);
  }
  if (fresh.currency.trim().toUpperCase() !== 'USDC') {
    return changed(`The invoice is now denominated in ${fresh.currency}, not USDC.`);
  }
  if (fresh.amountAtomic === null || fresh.amountAtomic !== persisted.amountAtomic) {
    return changed(
      `The invoice amount changed from ${persisted.amountAtomic} to ${fresh.amountAtomic ?? 'an unreadable value'}.`,
    );
  }
  const recipient = normalizeAddressV1(fresh.recipient ?? '');
  if (recipient === null || recipient !== persisted.payTo) {
    return changed(`The invoice payment address changed from ${persisted.payTo} to ${fresh.recipient ?? 'none'}.`);
  }
  if (fresh.productId !== undefined && fresh.productId !== input.candidate.product.productId) {
    return changed('The invoice is for a different product than the one selected.');
  }
  if (fresh.packageValue !== undefined && fresh.packageValue !== input.candidate.product.packageValue) {
    return changed('The invoice is for a different denomination than the one selected.');
  }

  const expiresAtMs = Date.parse(fresh.expiresAt ?? persisted.expiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= input.now.getTime()) {
    return { ok: false, reason: 'invoice_expired', detail: 'The invoice price lock has expired.' };
  }

  const amount = BigInt(persisted.amountAtomic);
  if (amount > BigInt(input.intent.maxSpendAtomic) || amount > BigInt(COMMERCE_MAX_ORDER_ATOMIC_V1)) {
    return { ok: false, reason: 'spend_ceiling_exceeded', detail: 'The invoice exceeds the authorized ceiling.' };
  }
  const wallet = normalizeAddressV1(input.authenticatedWallet);
  if (wallet === null || wallet !== persisted.refundAddress) {
    return { ok: false, reason: 'pinned_recipient_mismatch', detail: 'The refund wallet is not the authenticated wallet.' };
  }
  if (input.order.invoiceId !== persisted.invoiceId) {
    return changed('The stored order is bound to a different invoice.');
  }
  return { ok: true };
}

// --- Commerce Safety Kernel (§3) --------------------------------------------

export interface CommercePaymentKernelInputV1 {
  calls: readonly ExecutionCallV1[];
  invoice: CommerceInvoiceV1;
  authenticatedWallet: string;
  intent: CommerceRouteIntentV1;
  now: Date;
}

/**
 * The last gate before a wallet prompt.
 *
 * It re-derives everything from the CALLDATA rather than trusting the call's
 * own fields: an attacker who could set `recipient` on the object could not
 * also change what the token contract executes without failing here.
 */
export function commercePaymentSafetyKernelV1(
  input: CommercePaymentKernelInputV1,
): SafetyKernelResultV1 {
  const checks: SafetyKernelCheckV1[] = [];
  const add = (id: string, description: string, passed: boolean, detail: string | null = null): void => {
    checks.push({ id, description, status: passed ? 'passed' : 'failed', detail: passed ? null : detail });
  };

  add('single_call', 'The payment is exactly one call', input.calls.length === 1, `Found ${input.calls.length} calls`);
  const call = input.calls[0];

  add(
    'canonical_usdc',
    'The call targets canonical Base USDC',
    call?.to === COMMERCE_USDC_ADDRESS_V1,
    `Target ${call?.to ?? 'missing'}`,
  );
  add('zero_native_value', 'The call moves no native value', call?.valueWei === '0', `valueWei ${call?.valueWei ?? 'missing'}`);
  add('no_allowance', 'The call grants no allowance', call?.spender === null, 'A spender was set');

  const decoded = call ? decodeUsdcTransferCallDataV1(call.data) : null;
  add(
    'transfer_selector_only',
    'The calldata is a bare transfer(address,uint256)',
    decoded !== null,
    'The calldata is not an exact ERC-20 transfer',
  );
  add(
    'exact_recipient',
    'The calldata pays the invoice address',
    decoded !== null && decoded.recipient === input.invoice.payTo,
    `Calldata recipient ${decoded?.recipient ?? 'unreadable'} != invoice ${input.invoice.payTo}`,
  );
  add(
    'exact_amount',
    'The calldata pays the exact invoice amount',
    decoded !== null && decoded.amountAtomic === input.invoice.amountAtomic,
    `Calldata amount ${decoded?.amountAtomic ?? 'unreadable'} != invoice ${input.invoice.amountAtomic}`,
  );

  const wallet = normalizeAddressV1(input.authenticatedWallet);
  add(
    'authenticated_wallet',
    'The payer is the authenticated wallet',
    wallet !== null && wallet === normalizeAddressV1(input.intent.walletAddress),
    'The payer does not match the session wallet',
  );
  add(
    'within_ceiling',
    'The amount is within the authorized ceiling',
    BigInt(input.invoice.amountAtomic) <= BigInt(input.intent.maxSpendAtomic),
    `Amount ${input.invoice.amountAtomic} exceeds ceiling ${input.intent.maxSpendAtomic}`,
  );
  add(
    'invoice_not_expired',
    'The invoice price lock is still valid',
    Date.parse(input.invoice.expiresAt) > input.now.getTime(),
    'The invoice has expired',
  );

  const failed = checks.filter((check) => check.status === 'failed');
  return failed.length === 0
    ? { schemaVersion: 'safety-kernel-result/v1', verdict: 'allowed', checks, blockedReason: null }
    : {
        schemaVersion: 'safety-kernel-result/v1',
        verdict: 'blocked',
        checks,
        blockedReason: failed.map((check) => check.description).join('; '),
      };
}

// --- Blueprint construction --------------------------------------------------

export type CommercePaymentBlueprintResultV1 =
  | { ok: true; blueprint: CommercePaymentBlueprintV1; safety: SafetyKernelResultV1 }
  | { ok: false; reason: string; safety: SafetyKernelResultV1 | null };

export function buildCommercePaymentBlueprintV1(input: {
  order: CommerceOrderV1;
  orderId: string;
  invoice: CommerceInvoiceV1;
  intent: CommerceRouteIntentV1;
  candidate: CommerceCandidateV1;
  routeCardHash: `0x${string}`;
  authenticatedWallet: string;
  now: Date;
}): CommercePaymentBlueprintResultV1 {
  const call = buildCommercePaymentCallV1({
    recipient: input.invoice.payTo,
    amountAtomic: input.invoice.amountAtomic,
  });
  if (call === null) {
    return { ok: false, reason: 'The payment call could not be encoded from the invoice.', safety: null };
  }
  const safety = commercePaymentSafetyKernelV1({
    calls: [call],
    invoice: input.invoice,
    authenticatedWallet: input.authenticatedWallet,
    intent: input.intent,
    now: input.now,
  });
  if (safety.verdict === 'blocked') {
    return { ok: false, reason: safety.blockedReason ?? 'The payment was blocked.', safety };
  }

  const nowIso = input.now.toISOString();
  const base = {
    schemaVersion: 'commerce-payment-blueprint/v1' as const,
    id: `commerce-payment:${input.invoice.invoiceId}`,
    tenantId: input.intent.tenantId,
    walletAddress: input.intent.walletAddress,
    chainId: input.intent.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'ready_for_review' as const,
    blueprintHash: ZERO_HASH_V1,
    callsHash: hashApprovedCallsV1([call]),
    approvedCallsHash: null,
    orderId: input.orderId,
    invoiceId: input.invoice.invoiceId,
    routeCardHash: input.routeCardHash,
    candidateHash: input.candidate.candidateHash,
    exactAmountAtomic: input.invoice.amountAtomic,
    asset: COMMERCE_USDC_ADDRESS_V1,
    recipient: input.invoice.payTo,
    recipientPolicy: input.invoice.recipientPolicy,
    invoiceExpiresAt: input.invoice.expiresAt,
    calls: [call],
    simulationState: {
      status: 'not_requested' as const,
      observedAt: null,
      blockNumber: null,
      requestHash: null,
      responseHash: null,
      errorCode: null,
    },
  };
  const parsed = CommercePaymentBlueprintV1Schema.safeParse({
    ...base,
    blueprintHash: hashCommercePaymentBlueprintV1(base as unknown as CommercePaymentBlueprintV1),
  });
  if (!parsed.success) {
    return { ok: false, reason: 'The payment Blueprint failed contract validation.', safety };
  }
  return { ok: true, blueprint: parsed.data, safety };
}

/** Whether the wallet may be prompted at all. Simulation is a precondition,
 * not a nicety: an unsimulated or reverted call is never offered for signing. */
export function commercePaymentSignableV1(
  blueprint: CommercePaymentBlueprintV1,
  now: Date,
): { signable: boolean; reason: string | null } {
  if (blueprint.simulationState.status !== 'passed') {
    return {
      signable: false,
      reason:
        blueprint.simulationState.status === 'failed'
          ? 'The simulation reverted, so this payment is not offered for signing.'
          : 'This payment has not been simulated yet.',
    };
  }
  if (Date.parse(blueprint.invoiceExpiresAt) <= now.getTime()) {
    return { signable: false, reason: 'The invoice price lock has expired.' };
  }
  if (blueprint.status !== 'ready_for_review' && blueprint.status !== 'approved') {
    return { signable: false, reason: `This payment is already ${blueprint.status.replaceAll('_', ' ')}.` };
  }
  return { signable: true, reason: null };
}
