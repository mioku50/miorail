import assert from 'node:assert/strict';
import {
  BITREFILL_ALLOWED_PATHS_V1,
  BITREFILL_INVOICE_CREATE_PATH_V1,
  BITREFILL_V2_INVOICES_PATH_V1,
  BITREFILL_V2_PRODUCT_SEARCH_PATH_V1,
  COMMERCE_PAYMENT_METHOD_V1,
  CommerceCredentialSurfaceError,
  commerceAuthHeadersV1,
  createBitrefillPersonalCatalogSourceV1,
  resolveCommerceCredentialV1,
  BITREFILL_HOST_V1,
  BITREFILL_PAY_TO_V1,
  COMMERCE_MAX_ORDER_ATOMIC_V1,
  COMMERCE_USDC_ADDRESS_V1,
  buildCommerceUrlV1,
  buildCommercePaymentRequirementsV1,
  buildCommerceOrderV1,
  buildCommerceRouteProofV1,
  compareCommerceRoutesV1,
  createBitrefillCatalogSourceV1,
  validateCommercePaymentTermsV1,
} from '@mioagent/commerce-engine';
import { resolveCommerceIntentV1 } from '@mioagent/intent-engine';
import { ALLOWED_PARTNER_HOSTS } from '@mioagent/security/httpAllowlist';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// T64 — FREE smoke test for the Bitrefill commerce route family.
//
// "Free" in three senses: it costs no USDC, it creates NO order, and by
// default it makes no network request at all — the offline section runs the
// whole family (intent → catalogue → candidates → score → card → checkout →
// three-leg proof) against recorded payloads.
//
// Run offline (default, no credentials needed):
//   pnpm smoke:bitrefill
// Add the read-only live probe (one catalogue search, no checkout):
//   SMOKE_BITREFILL_LIVE=true pnpm smoke:bitrefill
//   BITREFILL_API_KEY=... SMOKE_BITREFILL_LIVE=true pnpm smoke:bitrefill
//
// The live probe only SEARCHES. It never creates an invoice, never pays, and
// never asks for a signature — there is no code path in this script that can
// spend anything.
// ---------------------------------------------------------------------------

const WALLET = '0x000000000000000000000000000000000000dEaD' as const;
const NOW = new Date();

function ok(message: string): void {
  console.log(`   ✔ ${message}`);
}

const SEARCH_BODY = {
  products: [{ slug: 'steam-usa', name: 'Steam US', country_code: 'US', currency: 'USD', in_stock: true }],
};

const DETAIL_BODY = {
  slug: 'steam-usa',
  name: 'Steam US',
  country_code: 'US',
  currency: 'USD',
  in_stock: true,
  recipient_required: false,
  packages: [
    { package_value: '25', value: '25', usdc_price: '25', in_stock: true },
    { package_value: '10', value: '10', usd_price: '10', in_stock: true },
  ],
};

function recordedFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) =>
    new Response(JSON.stringify(String(input).includes('detail') ? DETAIL_BODY : SEARCH_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

async function main(): Promise<void> {
  console.log('\nT64 Bitrefill commerce smoke\n');

  console.log('0. Environment');
  // The repo's convention is `node --env-file=.env`, which is easy to forget
  // behind a pnpm alias — without this the script reports "anonymous" for a
  // credential that is actually configured.
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  console.log('\n1. Pinned configuration');
  assert.ok(
    (ALLOWED_PARTNER_HOSTS as readonly string[]).includes(BITREFILL_HOST_V1),
    'the commerce host must be on the partner allowlist',
  );
  ok(`host allowlisted: ${BITREFILL_HOST_V1}`);
  ok(`${BITREFILL_ALLOWED_PATHS_V1.length} pinned paths, and no others`);
  assert.throws(() => buildCommerceUrlV1('/x402/anything-else'), /not pinned/);
  assert.throws(() => buildCommerceUrlV1('/v2/accounts/balance'), /not pinned/);
  ok('an unpinned path cannot be built into a request, on either surface');
  ok(`settlement pinned to USDC ${COMMERCE_USDC_ADDRESS_V1} → ${BITREFILL_PAY_TO_V1}`);
  ok(`hard order ceiling: ${COMMERCE_MAX_ORDER_ATOMIC_V1} USDC base units`);

  console.log('\n2. Credential routing (T64.1)');
  const credential = resolveCommerceCredentialV1({
    apiKey: process.env.BITREFILL_API_KEY,
    accessToken: process.env.BITREFILL_ACCESS_TOKEN,
  });
  ok(`configured credential: ${credential.kind}`);
  if (credential.kind === 'anonymous') {
    console.log('     ⚠ neither BITREFILL_API_KEY nor BITREFILL_ACCESS_TOKEN is visible.');
    console.log('       The live probe cannot read a catalogue without one.');
  } else if (credential.kind === 'personal_api') {
    ok('the Personal API surface (/v2, Bearer) is the one this deployment will use');
  } else {
    ok('the x402 surface (/x402, X-Access-Token) is the one this deployment will use');
  }
  assert.deepEqual(
    commerceAuthHeadersV1({ kind: 'personal_api', apiKey: 'k' }, BITREFILL_V2_PRODUCT_SEARCH_PATH_V1),
    { authorization: 'Bearer k' },
  );
  ok('Personal API key -> Authorization: Bearer on /v2/*');
  assert.deepEqual(
    commerceAuthHeadersV1({ kind: 'x402_session', accessToken: 't' }, BITREFILL_INVOICE_CREATE_PATH_V1),
    { 'X-Access-Token': 't' },
  );
  ok('SIWX session -> X-Access-Token on /x402/*');
  assert.throws(
    () => commerceAuthHeadersV1({ kind: 'personal_api', apiKey: 'k' }, BITREFILL_INVOICE_CREATE_PATH_V1),
    CommerceCredentialSurfaceError,
  );
  ok('a Personal API key is REFUSED on an x402 route — never sent as X-Access-Token');
  assert.throws(
    () => commerceAuthHeadersV1({ kind: 'x402_session', accessToken: 't' }, BITREFILL_V2_INVOICES_PATH_V1),
    CommerceCredentialSurfaceError,
  );
  ok('a SIWX session is REFUSED on the Personal API');
  ok(`invoice settlement pinned to payment_method=${COMMERCE_PAYMENT_METHOD_V1}`);

  console.log('\n3. Intent grounding (offline, deterministic)');
  const resolution = resolveCommerceIntentV1({
    message: 'Buy a US Steam gift card for $25',
    tenantId: `eip155:8453:${WALLET.toLowerCase()}`,
    walletAddress: WALLET.toLowerCase() as `0x${string}`,
    now: NOW,
  });
  assert.equal(resolution.status, 'ready');
  if (resolution.status !== 'ready') throw new Error('intent not ready');
  ok(`intent ${resolution.intent.intentHash.slice(0, 18)}… · ceiling ${resolution.intent.maxSpendAtomic}`);

  console.log('\n4. Comparison against recorded catalogue payloads');
  const comparison = await compareCommerceRoutesV1(
    { catalog: createBitrefillCatalogSourceV1({ fetchImpl: recordedFetch() }) },
    { intent: resolution.intent, now: NOW },
  );
  assert.ok(comparison.ok, 'the recorded comparison must succeed');
  if (!comparison.ok) throw new Error('comparison failed');
  const card = comparison.routeCard;
  ok(`${card.comparisons.length} denomination(s) compared · card ${card.routeCardHash.slice(0, 18)}…`);
  for (const entry of card.comparisons) {
    const scored = entry.score.dimensions.filter((dimension) => dimension.status === 'scored').length;
    console.log(
      `     ${entry.candidate.product.packageValue} ${entry.candidate.product.currency} → ` +
        `${entry.candidate.payment.amountDecimal} USDC (${entry.candidate.fees.totalBasis}) · ` +
        `${entry.availability} · ${scored}/4 scored`,
    );
  }
  const delivery = card.comparisons[0].score.dimensions.find(
    (dimension) => dimension.dimension === 'delivery_certainty',
  );
  assert.equal(delivery?.status, 'not_scored');
  assert.equal(delivery?.score, null);
  ok('delivery certainty is visibly unscored — no source publishes it');

  console.log('\n5. Checkout terms (built, never sent)');
  const candidate = card.comparisons[0].candidate;
  const order = buildCommerceOrderV1({
    intent: resolution.intent,
    candidate,
    created: {
      invoiceId: 'smoke-invoice',
      totalAtomic: candidate.fees.totalAtomic,
      payTo: BITREFILL_PAY_TO_V1,
      asset: COMMERCE_USDC_ADDRESS_V1,
      expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
      items: [{ productId: candidate.product.productId, packageValue: candidate.product.packageValue, orderId: null }],
    },
    now: NOW,
  });
  assert.ok(order.ok, 'the pinned checkout must validate');
  if (!order.ok) throw new Error('order build failed');
  assert.equal(order.order.paymentState, 'awaiting_signature');
  assert.equal(order.order.paymentTransactionHash, null);
  ok('the order exists with NOTHING signed and no transaction');

  const wrongRecipient = validateCommercePaymentTermsV1({
    network: 'eip155:8453',
    asset: COMMERCE_USDC_ADDRESS_V1,
    payTo: '0x00000000000000000000000000000000deadbeef',
    amountAtomic: candidate.fees.totalAtomic,
    maxSpendAtomic: resolution.intent.maxSpendAtomic,
    resource: `https://${BITREFILL_HOST_V1}/x402/invoice/pay`,
  });
  assert.deepEqual(wrongRecipient, { ok: false, reason: 'pinned_recipient_mismatch' });
  ok('a 402 naming another recipient produces no signing prompt');

  const payment = buildCommercePaymentRequirementsV1({
    accepts: {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: COMMERCE_USDC_ADDRESS_V1,
      payTo: BITREFILL_PAY_TO_V1,
      maxAmountRequired: candidate.fees.totalAtomic,
      resource: `https://${BITREFILL_HOST_V1}/x402/invoice/pay`,
      maxTimeoutSeconds: 600,
    },
    order: order.order,
    intent: resolution.intent,
    now: NOW,
  });
  assert.ok(payment.ok);
  if (!payment.ok) throw new Error('payment requirements failed');
  ok(`review terms: ${payment.requirements.maxAmountAtomic} base units → ${payment.requirements.payTo}`);

  console.log('\n6. The rule this family exists for');
  const paidNoOrder = buildCommerceRouteProofV1({
    order: order.order,
    observation: {
      invoiceId: 'smoke-invoice',
      paymentSettled: true,
      paymentTransactionHash: `0x${'a'.repeat(64)}` as `0x${string}`,
      settledAt: NOW.toISOString(),
      orderIds: [],
      deliveryState: 'unknown',
      itemCount: 1,
      deliveredCount: 0,
      observedAt: NOW.toISOString(),
    },
    evidenceSetHash: `0x${'0'.repeat(64)}` as `0x${string}`,
    now: NOW,
  });
  assert.ok(paidNoOrder.ok);
  if (!paidNoOrder.ok) throw new Error('proof build failed');
  assert.equal(paidNoOrder.proof.finalStatus, 'order_unconfirmed');
  ok('a settled payment with no confirmed order is order_unconfirmed, NOT delivered');

  const delivered = buildCommerceRouteProofV1({
    order: order.order,
    observation: {
      invoiceId: 'smoke-invoice',
      paymentSettled: true,
      paymentTransactionHash: `0x${'a'.repeat(64)}` as `0x${string}`,
      settledAt: NOW.toISOString(),
      orderIds: ['smoke-order'],
      deliveryState: 'all_delivered',
      itemCount: 1,
      deliveredCount: 1,
      observedAt: NOW.toISOString(),
    },
    evidenceSetHash: `0x${'0'.repeat(64)}` as `0x${string}`,
    now: NOW,
  });
  assert.ok(delivered.ok);
  if (!delivered.ok) throw new Error('proof build failed');
  assert.equal(delivered.proof.finalStatus, 'delivered');
  ok('payment + confirmed order + delivery is the ONLY successful proof');

  if (process.env.SMOKE_BITREFILL_LIVE !== 'true') {
    // Named explicitly so the reader knows the probe was skipped by choice.
    console.log('\n7. Live probe skipped (set SMOKE_BITREFILL_LIVE=true to run one read-only search).\n');
    console.log('Offline smoke passed.\n');
    return;
  }

  console.log('\n7. Live probe — ONE catalogue search, read-only');
  // Whichever surface the environment actually configures, exactly as the
  // server chooses it.
  const apiKey = process.env.BITREFILL_API_KEY?.trim();
  const live = apiKey
    ? createBitrefillPersonalCatalogSourceV1({ apiKey })
    : createBitrefillCatalogSourceV1({ accessToken: process.env.BITREFILL_ACCESS_TOKEN?.trim() || undefined });
  console.log(`   surface: ${apiKey ? 'Personal API /v2 (Bearer)' : 'x402 /x402 (session or anonymous)'}`);
  const result = await live.search({
    query: 'Steam',
    kind: 'gift_card',
    country: 'US',
    requestedValueDecimal: '25',
    requestedCurrency: 'USD',
    now: new Date(),
  });
  if (!result.ok) {
    console.log(`   ⚠ the storefront did not answer: ${result.reason}`);
    console.log('     provider_payment_required = the x402 route is gated; set BITREFILL_API_KEY to use the Personal API.');
    console.log('     provider_not_configured   = no key, or the key was rejected (401/403).\n');
    return;
  }
  ok(`${result.observation.packages.length} denomination(s) read from ${result.observation.endpoint}`);
  for (const entry of result.observation.packages.slice(0, 5)) {
    console.log(
      `     ${entry.product.packageValue} ${entry.product.currency} → ` +
        `${entry.fees.totalAtomic} base units (${entry.fees.totalBasis}) · ${entry.availability}`,
    );
  }
  ok(`request ${result.observation.requestHash.slice(0, 18)}… response ${result.observation.responseHash.slice(0, 18)}…`);
  console.log('\nLive probe passed. No order was created and nothing was paid.\n');
}

main().catch((error) => {
  console.error('\nSmoke failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
