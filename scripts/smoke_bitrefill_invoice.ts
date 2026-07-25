import assert from 'node:assert/strict';
import {
  COMMERCE_PAYMENT_METHOD_V1,
  createBitrefillPersonalCatalogSourceV1,
  createBitrefillPersonalOrderGatewayV1,
  resolveCommerceCredentialV1,
  validateCommerceInvoiceV1,
  buildCommerceCandidatesV1,
  commerceAmountReviewV1,
} from '@mioagent/commerce-engine';
import { resolveCommerceIntentV1 } from '@mioagent/intent-engine';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// T64.2 §6 — the CONTROLLED invoice smoke.
//
// This is the only script in the repo that can change something at the
// storefront, so it is gated twice and does the smallest possible thing:
//
//   SMOKE_BITREFILL_INVOICE_LIVE=true \
//   CONFIRM_CREATE_UNPAID_INVOICE=yes \
//   pnpm smoke:bitrefill-invoice
//
// Without BOTH it exits having caused no external side effect at all.
//
// What it will NEVER do, and has no code path for: sign anything, send USDC,
// call a wallet, pay an invoice, or print the API key. It prints the invoice
// id, the exact amount, the network, the expiry and the status — nothing else.
// The invoice it creates is UNPAID and simply expires (~15 minutes).
// ---------------------------------------------------------------------------

const WALLET = (process.env.SMOKE_BITREFILL_WALLET?.trim() ??
  '0x000000000000000000000000000000000000dEaD') as `0x${string}`;

function ok(message: string): void {
  console.log(`   ✔ ${message}`);
}

async function main(): Promise<void> {
  console.log('\nT64.2 Bitrefill controlled invoice smoke\n');

  console.log('0. Environment');
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const credential = resolveCommerceCredentialV1({
    apiKey: process.env.BITREFILL_API_KEY,
    accessToken: process.env.BITREFILL_ACCESS_TOKEN,
  });
  ok(`configured credential: ${credential.kind}`);
  ok(`invoice settlement pinned to payment_method=${COMMERCE_PAYMENT_METHOD_V1}`);

  const live = process.env.SMOKE_BITREFILL_INVOICE_LIVE === 'true';
  const confirmed = process.env.CONFIRM_CREATE_UNPAID_INVOICE === 'yes';

  if (!live || !confirmed) {
    console.log('\n1. Nothing was created.');
    console.log('   This script needs BOTH of these to touch the storefront:');
    console.log('     SMOKE_BITREFILL_INVOICE_LIVE=true');
    console.log('     CONFIRM_CREATE_UNPAID_INVOICE=yes');
    console.log(`   live=${live} confirmed=${confirmed}\n`);
    console.log('   No invoice was created, no payment was made, no wallet was called.\n');
    return;
  }

  if (credential.kind !== 'personal_api') {
    console.log('\n1. Refusing to continue: a Personal API key is required to create an invoice.');
    console.log('   Set BITREFILL_API_KEY. Nothing was created.\n');
    process.exitCode = 1;
    return;
  }

  console.log('\n1. Intent and catalogue (read-only)');
  const now = new Date();
  const resolution = resolveCommerceIntentV1({
    message: 'Buy a US Steam gift card for $5',
    tenantId: `eip155:8453:${WALLET.toLowerCase()}`,
    walletAddress: WALLET.toLowerCase() as `0x${string}`,
    now,
  });
  assert.equal(resolution.status, 'ready');
  if (resolution.status !== 'ready') throw new Error('intent not ready');
  ok(`intent ceiling ${resolution.intent.maxSpendAtomic} base units`);

  const catalog = createBitrefillPersonalCatalogSourceV1({ apiKey: credential.apiKey });
  const observed = await catalog.search({
    query: 'Steam',
    kind: 'gift_card',
    country: 'US',
    requestedValueDecimal: '5',
    requestedCurrency: 'USD',
    now,
  });
  if (!observed.ok) {
    console.log(`   ⚠ the catalogue did not answer: ${observed.reason}. Nothing was created.\n`);
    process.exitCode = 1;
    return;
  }
  const built = buildCommerceCandidatesV1({
    intent: resolution.intent,
    observation: observed.observation,
    requestedAtomic: '5000000',
    now,
  });
  if (!built.ok) {
    console.log(`   ⚠ no candidate could be built: ${built.reason}. Nothing was created.\n`);
    process.exitCode = 1;
    return;
  }
  // The smallest denomination available, so the invoice is as small as it can be.
  const candidate = [...built.builds]
    .sort((left, right) =>
      BigInt(left.candidate.fees.totalAtomic) < BigInt(right.candidate.fees.totalAtomic) ? -1 : 1,
    )[0].candidate;
  ok(
    `selected ${candidate.product.productId} ${candidate.product.packageValue} ${candidate.product.currency}` +
      `${candidate.product.packageId ? ` (package ${candidate.product.packageId})` : ''}`,
  );

  console.log('\n2. Creating ONE unpaid invoice');
  const gateway = createBitrefillPersonalOrderGatewayV1({ apiKey: credential.apiKey });
  const created = await gateway.createOrder({
    productId: candidate.product.productId,
    packageValue: candidate.product.packageValue,
    packageId: candidate.product.packageId,
    recipientInput: null,
    maxSpendAtomic: resolution.intent.maxSpendAtomic,
    refundAddress: WALLET,
    now,
  });
  if (!created.ok) {
    if (created.reason === 'invoice_creation_unknown') {
      // An invoice may well EXIST — this branch is reached after a successful
      // POST whose answer could not be fully read. Saying "nothing was
      // created" here would be false, and re-running would create a second one.
      console.log(`   ⚠ UNCERTAIN: ${created.detail}`);
      console.log('     An invoice MAY EXIST. Do NOT re-run this script.');
      console.log('     Check it read-only first:');
      console.log('       GET https://api.bitrefill.com/v2/invoices?limit=5   (Authorization: Bearer …)');
      console.log('     No payment was signed or sent, and any such invoice expires unpaid.\n');
      process.exitCode = 1;
      return;
    }
    // Everything else is refused BEFORE the storefront was asked to create
    // anything, so this really is the no-side-effect branch.
    console.log(`   ⚠ the storefront refused before creating anything: ${created.reason}.`);
    console.log('     No invoice was created.\n');
    process.exitCode = 1;
    return;
  }

  const validated = validateCommerceInvoiceV1({
    provider: {
      invoiceId: created.order.invoiceId,
      network: 'eip155:8453',
      asset: created.order.asset,
      payTo: created.order.payTo,
      amountAtomic: created.order.totalAtomic,
      providerFeeAtomic: created.order.providerFeeAtomic ?? null,
      expiresAt: created.order.expiresAt,
      paymentStatus: created.order.paymentStatus ?? 'unpaid',
      orderStatus: created.order.orderStatus ?? 'created',
      productId: candidate.product.productId,
      packageValue: candidate.product.packageValue,
      recipientPolicy: created.order.recipientPolicy ?? 'pinned',
    },
    intent: resolution.intent,
    candidate,
    authenticatedWallet: WALLET,
    now,
  });
  if (!validated.ok) {
    console.log(`   ⚠ the invoice FAILED validation: ${validated.reason}`);
    console.log(`     Invoice ${created.order.invoiceId} EXISTS at the storefront but Miorail will`);
    console.log('     not present it. Nothing was signed or sent; it expires unpaid.\n');
    process.exitCode = 1;
    return;
  }

  const amounts = commerceAmountReviewV1({ candidate, invoice: validated.invoice });
  console.log(`     invoice id      : ${validated.invoice.invoiceId}`);
  console.log(`     recipient policy: ${validated.invoice.recipientPolicy}`);
  console.log(`     exact amount    : ${validated.invoice.amountAtomic} USDC base units`);
  console.log(`     estimated before: ${amounts.estimatedMinimumAtomic} (${amounts.estimatedBasis})`);
  console.log(`     network         : ${validated.invoice.network}`);
  console.log(`     recipient       : ${validated.invoice.payTo}`);
  console.log(`     refund wallet   : ${validated.invoice.refundAddress}`);
  console.log(`     expires at      : ${validated.invoice.expiresAt}`);
  console.log(`     payment status  : ${validated.invoice.paymentStatus}`);
  assert.equal(validated.invoice.paymentStatus, 'awaiting_signature');
  ok('the invoice is UNPAID — nothing was signed, no USDC was sent, no wallet was called');
  console.log('\n   It will expire on its own. Do not pay it from this script; there is no code path to.\n');
}

main().catch((error) => {
  console.error('\nSmoke failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
