import assert from 'node:assert/strict';
import test from 'node:test';
import { stillCardFromStatusV1, stillCardPreparedV1, stillCardReviewHostV1, stillCardStatusV1 } from './stillCardView';

// Every review, hash and link here is synthetic.
const REVIEW_ID = '0b8f4a51-5d0a-4c55-9d4e-0a6a3f3e2c11';
const URL = 'https://stills.lat/lending/miorail-lending-v3.eyJhIjoxfQ.c2lnbmF0dXJl';
const NOW = new Date('2026-11-02T15:00:00.000Z');
const PURCHASE = { reviewUrl: URL, reviewId: REVIEW_ID, expiresAt: '2026-11-02T15:05:00.000Z', venue: 'aave-v4', collateral: 'NVDAc', addCollateral: '0',
  borrowUsdc: '3.62', purchase: { productId: 'bitrefill-esim-japan', productName: 'Bitrefill eSIM Japan', packageValue: '1GB, 7 Days', faceCurrency: 'USD',
    priceUsdc: '3.62', invoiceExpiresAt: '2026-11-02T15:15:00.000Z' }, next: 'Give the user this link.' };

test('a prepared purchase, loan and repayment read in the person’s words, and nothing else becomes a card', () => {
  assert.deepEqual(stillCardPreparedV1(PURCHASE), { kind: 'purchase', reviewId: REVIEW_ID, reviewUrl: URL, expiresAt: PURCHASE.expiresAt,
    title: 'Bitrefill eSIM Japan · 1GB, 7 Days', detail: '3.62 USDC, borrowed against NVDAc on Aave V4, and paid to Bitrefill in the same review.' });
  const topUp = stillCardPreparedV1({ ...PURCHASE, purchase: { ...PURCHASE.purchase, productName: 'Airtel India', packageValue: '10', faceCurrency: 'INR' } });
  assert.equal(topUp?.title, 'Airtel India · 10 INR');
  const loan = stillCardPreparedV1({ reviewUrl: URL, reviewId: REVIEW_ID, expiresAt: PURCHASE.expiresAt, venue: 'morpho', collateral: 'cbBTC', addCollateral: '0.001', borrowUsdc: '40' });
  assert.deepEqual([loan?.kind, loan?.title, loan?.detail], ['loan', 'Borrow 40 USDC against cbBTC', 'On Morpho, pledging 0.001 cbBTC.']);
  const all = stillCardPreparedV1({ reviewUrl: URL, reviewId: REVIEW_ID, expiresAt: PURCHASE.expiresAt, venue: 'aave-v4', collateral: 'NVDAc', repayUsdc: 'all', maximumUsdc: '75' });
  assert.deepEqual([all?.kind, all?.title, all?.detail], ['repay', 'Repay all of the NVDAc loan', 'At most 75 USDC from your wallet, interest included, on Aave V4.']);
  // A link to anywhere but Still's own review is not drawn as one.
  assert.equal(stillCardPreparedV1({ ...PURCHASE, reviewUrl: 'https://example.com/lending/miorail-lending-v3.a.b' }), null);
  assert.equal(stillCardPreparedV1({ ...PURCHASE, reviewId: 'not-a-review' }), null);
  assert.equal(stillCardPreparedV1('a sentence'), null);
});

// 2026-11-04: a purchase paid from the USDC already in the wallet, on Spend's own payment page.
const INVOICE = '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34';
const FROM_WALLET = { reviewUrl: `https://miorail.xyz/spend/pay/${INVOICE}`, reviewId: INVOICE, expiresAt: '2026-11-02T15:12:00.000Z', paidFrom: 'wallet',
  walletUsdc: { usdc: '12.5', block: '53000123' }, purchase: { ...PURCHASE.purchase, priceUsdc: '0.18', productName: 'PUBG Mobile', packageValue: '60 UC' }, next: 'Give the user this link.' };

test('a purchase from the wallet’s own USDC is its payment page, with no loan, and its confirmation says so', () => {
  const prepared = stillCardPreparedV1(FROM_WALLET);
  assert.deepEqual(prepared, { kind: 'purchase', paidFrom: 'wallet', reviewId: INVOICE, reviewUrl: FROM_WALLET.reviewUrl, expiresAt: FROM_WALLET.expiresAt,
    title: 'PUBG Mobile · 60 UC', detail: '0.18 USDC from your wallet, paid to Bitrefill. No loan is taken.' });
  // Only Still's own payment page, for an invoice id, is drawn as one; a loan's review link is not a wallet payment.
  for (const reviewUrl of [`https://example.com/spend/pay/${INVOICE}`, 'https://miorail.xyz/spend/pay/not-an-invoice', URL]) {
    assert.equal(stillCardPreparedV1({ ...FROM_WALLET, reviewUrl }), null, reviewUrl);
  }
  assert.equal(stillCardPreparedV1({ ...FROM_WALLET, purchase: undefined }), null);
  const confirmed = stillCardStatusV1({ reviewId: INVOICE, state: 'confirmed', paidFrom: 'wallet', transactionHash: `0x${'ab'.repeat(32)}`,
    purchase: { invoiceStatus: 'complete', invoiceStatusError: null, shareUrl: null } }, prepared!, NOW);
  assert.deepEqual([confirmed?.line, confirmed?.settled], ['Confirmed onchain: your USDC paid Bitrefill.', true]);
  assert.equal(stillCardStatusV1({ reviewId: REVIEW_ID, state: 'confirmed', purchase: { invoiceStatus: 'complete' } }, stillCardPreparedV1(PURCHASE)!, NOW)?.line,
    'Confirmed onchain: the loan paid Bitrefill.');
  // A status result draws the same card, from the status's own facts.
  const shown = stillCardFromStatusV1({ reviewId: INVOICE, state: 'submitted', paidFrom: 'wallet',
    purchase: { productName: 'PUBG Mobile', packageValue: '60 UC', priceUsdc: '0.18', invoiceStatus: null, invoiceStatusError: null, shareUrl: null } }, NOW);
  assert.deepEqual([shown?.prepared.paidFrom, shown?.prepared.detail, shown?.status.phase], ['wallet', '0.18 USDC from your wallet, paid to Bitrefill.', 'sent']);
});

test('every state the status tool returns has its own line, and only a finished one stops the card', () => {
  const prepared = stillCardPreparedV1(PURCHASE)!;
  const line = (status: Record<string, unknown>, now = NOW) => stillCardStatusV1({ reviewId: REVIEW_ID, ...status }, prepared, now);
  assert.deepEqual([line({ state: 'not_opened' })?.phase, line({ state: 'not_opened' })?.settled], ['waiting', false]);
  const lapsed = line({ state: 'not_opened' }, new Date('2026-11-02T15:06:00.000Z'));
  assert.deepEqual([lapsed?.phase, lapsed?.settled], ['expired', true]);
  assert.match(lapsed!.line, /Nothing was sent/);
  assert.equal(line({ state: 'ready' })?.phase, 'open');
  assert.equal(line({ state: 'awaiting_wallet' })?.phase, 'wallet');
  assert.equal(line({ state: 'submitted' })?.phase, 'sent');
  assert.match(line({ state: 'unknown' })!.line, /This is not a failure/);
  assert.deepEqual([line({ state: 'failed' })?.phase, line({ state: 'failed' })?.settled], ['failed', true]);
  assert.equal(line({ state: 'something_new' }), null);
  // A loan in steps stopped on purpose is final with what landed, not a failed transaction.
  assert.match(line({ state: 'failed', errorCode: 'loan_steps_stopped' })!.line, /^Stopped part way: what landed is in place, and the rest was never sent\./);
  assert.match(line({ state: 'failed', errorCode: 'loan_step_reverted' })!.line, /^Base shows the transaction failed/);

  // A confirmed purchase waits for Bitrefill to finish, and shares only Still's own card link.
  const share = 'https://stills.lat/spend/p/ss1.eyJ2IjoxfQ.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmUtc2lnbmE';
  const paying = line({ state: 'confirmed', transactionHash: `0x${'ab'.repeat(32)}`, purchase: { invoiceStatus: 'payment_confirmed', invoiceStatusError: null, shareUrl: share } });
  assert.deepEqual([paying?.phase, paying?.settled, paying?.shareUrl], ['confirmed', false, share]);
  assert.match(paying!.bitrefill!, /confirmed the payment/);
  const done = line({ state: 'confirmed', purchase: { invoiceStatus: 'complete', invoiceStatusError: null, shareUrl: 'https://example.com/x' } });
  assert.deepEqual([done?.settled, done?.shareUrl], [true, null]);
  assert.match(done!.line, /the loan paid Bitrefill/);
  const forgotten = line({ state: 'confirmed', purchase: { invoiceStatus: null, invoiceStatusError: 'spend_order_forgotten', shareUrl: null } });
  assert.equal(forgotten?.settled, true);
  assert.equal(line({ state: 'confirmed', purchase: { invoiceStatus: 'denied', invoiceStatusError: null, shareUrl: null } })?.bitrefill,
    'Bitrefill reports the order as denied. Its email says what happens next.');
});

test('a status result draws its own card from the status’s facts, with no link to open', () => {
  const shown = stillCardFromStatusV1({ reviewId: REVIEW_ID, state: 'submitted', operation: 'borrow', venue: 'aave-v4', collateral: 'NVDAc',
    purchase: { productName: 'Bitrefill eSIM Japan', packageValue: '1GB, 7 Days', priceUsdc: '3.62', invoiceStatus: null, invoiceStatusError: null, shareUrl: null } }, NOW);
  assert.deepEqual([shown?.prepared.kind, shown?.prepared.reviewUrl, shown?.prepared.title, shown?.status.phase], ['purchase', null, 'Bitrefill eSIM Japan · 1GB, 7 Days', 'sent']);
  const repay = stillCardFromStatusV1({ reviewId: REVIEW_ID, state: 'confirmed', operation: 'repay', venue: 'morpho', collateral: 'WETH' }, NOW);
  assert.deepEqual([repay?.prepared.title, repay?.status.line], ['Repayment on the WETH loan', 'Confirmed onchain: the repayment is in.']);
  assert.equal(stillCardFromStatusV1({ reviewId: REVIEW_ID }, NOW), null);
});

test('the card names the host its review opens on, and shares a card link from either of Still’s hosts', () => {
  const onMiorail = 'https://miorail.xyz/lending/miorail-lending-v3.eyJhIjoxfQ.c2lnbmF0dXJl';
  assert.equal(stillCardReviewHostV1(URL), 'stills.lat');
  assert.equal(stillCardReviewHostV1(onMiorail), 'miorail.xyz');
  assert.equal(stillCardReviewHostV1('not a link'), 'Still');
  const prepared = stillCardPreparedV1({ ...PURCHASE, reviewUrl: onMiorail })!;
  assert.equal(prepared.reviewUrl, onMiorail);
  const share = 'https://miorail.xyz/spend/p/ss1.eyJ2IjoxfQ.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmUtc2lnbmE';
  const status = stillCardStatusV1({ reviewId: REVIEW_ID, state: 'confirmed', purchase: { invoiceStatus: 'complete', invoiceStatusError: null, shareUrl: share } }, prepared, NOW);
  assert.equal(status?.shareUrl, share);
});
