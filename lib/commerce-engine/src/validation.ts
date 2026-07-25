import type { CommerceRouteIntentV1 } from '@mioagent/route-domain';
import {
  COMMERCE_MAX_ORDER_ATOMIC_V1,
  COMMERCE_SUPPORTED_COUNTRIES_V1,
  COMMERCE_SUPPORTED_CURRENCIES_V1,
  COMMERCE_SUPPORTED_KINDS_V1,
  COMMERCE_USDC_ADDRESS_V1,
  BASE_MAINNET_CHAIN_ID_V1,
  BITREFILL_HOST_V1,
  BITREFILL_PAY_TO_V1,
} from './pinned-config.js';
import { normalizeAddressV1 } from './normalization.js';
import type { CommerceFailureReasonV1 } from './types.js';

// ---------------------------------------------------------------------------
// T64 §3 — country / currency / availability / ceiling validation.
//
// Every check here runs BEFORE a provider is contacted or a user is asked to
// sign, and every failure is one of the closed reason codes. There is no
// "close enough" branch: an unlisted country is refused, not converted; an
// unpinned recipient is refused, not corrected.
// ---------------------------------------------------------------------------

export type CommerceValidationResultV1 = { ok: true } | { ok: false; reason: CommerceFailureReasonV1 };

export function validateCommerceCountryV1(country: string): CommerceValidationResultV1 {
  return COMMERCE_SUPPORTED_COUNTRIES_V1.includes(country)
    ? { ok: true }
    : { ok: false, reason: 'unsupported_country' };
}

export function validateCommerceCurrencyV1(currency: string): CommerceValidationResultV1 {
  return COMMERCE_SUPPORTED_CURRENCIES_V1.includes(currency)
    ? { ok: true }
    : { ok: false, reason: 'unsupported_currency' };
}

/**
 * The whole intent, checked against what this deployment will actually
 * transact. Ordered so the cheapest, most specific refusal comes first.
 */
export function validateCommerceIntentV1(intent: CommerceRouteIntentV1): CommerceValidationResultV1 {
  if (!COMMERCE_SUPPORTED_KINDS_V1.includes(intent.kind)) {
    return { ok: false, reason: 'unsupported_kind' };
  }
  const country = validateCommerceCountryV1(intent.country);
  if (!country.ok) return country;
  const currency = validateCommerceCurrencyV1(intent.requestedValue.currency);
  if (!currency.ok) return currency;
  if (intent.chainId !== BASE_MAINNET_CHAIN_ID_V1) {
    return { ok: false, reason: 'pinned_chain_mismatch' };
  }
  if (intent.paymentAsset.address !== COMMERCE_USDC_ADDRESS_V1) {
    return { ok: false, reason: 'pinned_asset_mismatch' };
  }
  if (BigInt(intent.maxSpendAtomic) > BigInt(COMMERCE_MAX_ORDER_ATOMIC_V1)) {
    return { ok: false, reason: 'spend_ceiling_exceeded' };
  }
  return { ok: true };
}

/** A top-up without a recipient cannot be ordered; a gift card with one would
 * send the code somewhere the user did not intend. Both are refused. */
export function validateCommerceRecipientV1(input: {
  recipientRequired: boolean;
  recipientInput: string | null;
}): CommerceValidationResultV1 {
  if (input.recipientRequired && input.recipientInput === null) {
    return { ok: false, reason: 'recipient_required' };
  }
  if (!input.recipientRequired && input.recipientInput !== null) {
    return { ok: false, reason: 'recipient_not_allowed' };
  }
  return { ok: true };
}

export function validateCommerceSpendV1(input: {
  totalAtomic: string;
  maxSpendAtomic: string;
}): CommerceValidationResultV1 {
  const total = BigInt(input.totalAtomic);
  if (total <= BigInt(0)) return { ok: false, reason: 'price_out_of_range' };
  if (total > BigInt(COMMERCE_MAX_ORDER_ATOMIC_V1)) return { ok: false, reason: 'spend_ceiling_exceeded' };
  if (total > BigInt(input.maxSpendAtomic)) return { ok: false, reason: 'spend_ceiling_exceeded' };
  return { ok: true };
}

/**
 * The last gate before a signature: the payment terms the provider handed back
 * must be the pinned ones. Asset, recipient, network and host are compared
 * against constants, and the amount against the ceiling the user already
 * approved. A single mismatch means no signing prompt at all.
 */
export function validateCommercePaymentTermsV1(input: {
  network: string;
  asset: string;
  payTo: string;
  amountAtomic: string;
  maxSpendAtomic: string;
  resource: string;
}): CommerceValidationResultV1 {
  if (input.network !== `eip155:${BASE_MAINNET_CHAIN_ID_V1}`) {
    return { ok: false, reason: 'pinned_chain_mismatch' };
  }
  if (normalizeAddressV1(input.asset) !== COMMERCE_USDC_ADDRESS_V1) {
    return { ok: false, reason: 'pinned_asset_mismatch' };
  }
  if (normalizeAddressV1(input.payTo) !== BITREFILL_PAY_TO_V1) {
    return { ok: false, reason: 'pinned_recipient_mismatch' };
  }
  let host: string;
  try {
    host = new URL(input.resource).host;
  } catch {
    return { ok: false, reason: 'pinned_host_mismatch' };
  }
  if (host !== BITREFILL_HOST_V1) return { ok: false, reason: 'pinned_host_mismatch' };
  return validateCommerceSpendV1({ totalAtomic: input.amountAtomic, maxSpendAtomic: input.maxSpendAtomic });
}

/**
 * T64.2.1 — terms for an INVOICE-SCOPED recipient.
 *
 * The Personal API issues a deposit address per invoice, so `payTo` cannot be
 * compared against a constant. What is still enforced: the pinned chain, the
 * pinned settlement asset, a well-formed recipient that is NOT the zero
 * address, and the amount ceilings. The recipient is deliberately NOT checked
 * against `BITREFILL_PAY_TO_V1` — substituting that constant would send the
 * payment to an address the invoice never named.
 *
 * This is a genuinely weaker guarantee than the pinned one. It is recorded on
 * the invoice (`recipientPolicy: 'invoice_scoped'`) so no surface can present
 * it as pinned, and commerce execution stays gated off until the contract has
 * been verified against a real settled payment.
 */
export function validateCommerceInvoiceScopedTermsV1(input: {
  network: string;
  asset: string;
  payTo: string;
  amountAtomic: string;
  maxSpendAtomic: string;
}): CommerceValidationResultV1 {
  if (input.network !== `eip155:${BASE_MAINNET_CHAIN_ID_V1}`) {
    return { ok: false, reason: 'pinned_chain_mismatch' };
  }
  if (normalizeAddressV1(input.asset) !== COMMERCE_USDC_ADDRESS_V1) {
    return { ok: false, reason: 'pinned_asset_mismatch' };
  }
  const payTo = normalizeAddressV1(input.payTo);
  if (payTo === null || payTo === `0x${'0'.repeat(40)}`) {
    return { ok: false, reason: 'pinned_recipient_mismatch' };
  }
  return validateCommerceSpendV1({ totalAtomic: input.amountAtomic, maxSpendAtomic: input.maxSpendAtomic });
}
