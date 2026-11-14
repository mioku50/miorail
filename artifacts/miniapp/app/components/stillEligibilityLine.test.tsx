import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MiniStillEligibilityLine } from './StillEligibilityLine';

void React;

// Audit UI-15 (2026-11-14): the mini app's loan and stock-buy reviews asked for a confirmation they
// gave no place to make. The line the web draws at the top of every Still page now sits above both.
const WALLET = '0x1111111111111111111111111111111111111111';
function render(eligibility: Record<string, unknown>, scoped = false): string {
  const client = new QueryClient();
  client.setQueryData(['session'], { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } });
  client.setQueryData(['still-eligibility', WALLET], {
    schemaVersion: 'still-eligibility/v1', gate: 'on', region: { state: 'allowed', country: 'DE', reason: null },
    table: { loaded: true, month: '2026-11' }, signedIn: true, confirmed: false, confirmedAt: null,
    statement: 'I am not a U.S. person, and I am not currently located in the United States.', version: 'v-test',
    open: 'You can still repay a loan, take your collateral back and sell.', ...eligibility,
  });
  return renderToStaticMarkup(<QueryClientProvider client={client}><MiniStillEligibilityLine scoped={scoped} /></QueryClientProvider>);
}

test('the mini app draws the confirmation box a new loan or stock buy asks for', () => {
  const html = render({});
  assert.match(html, /class="still-eligibility is-confirm"/);
  assert.match(html, /<input type="checkbox"\/><span>I am not a U\.S\. person, and I am not currently located in the United States\.<\/span>/);
  assert.match(html, /A U\.S\. person is a U\.S\. citizen or green-card holder/);
  // On a page drawn in the console's colours, the line carries Still's own.
  assert.match(render({}, true), /^<div class="still"><section class="still-eligibility is-confirm"/);
  // Confirmed: nothing is drawn, and no empty wrapper either.
  assert.equal(render({ confirmed: true }, true), '');
  // From a place Still is not offered in, the refusal, with what stays open.
  assert.match(render({ region: { state: 'restricted', country: 'US', reason: null } }), /class="still-eligibility is-restricted"[^]*You can still repay a loan/);
});

test('both mini app reviews draw the line above the review itself', () => {
  for (const [page, screen] of [['../lending/[draft]/page.tsx', '<LendingReviewScreen'], ['../action/[draft]/page.tsx', '<StockActionReviewScreen']] as const) {
    const source = readFileSync(new URL(page, import.meta.url), 'utf8');
    const line = source.indexOf('<MiniStillEligibilityLine'), review = source.indexOf(screen);
    assert.ok(line > 0 && review > line, `${page} draws the eligibility line before ${screen}`);
  }
  // The loan review is read again once the confirmation lands, as on the web.
  assert.match(readFileSync(new URL('../lending/[draft]/page.tsx', import.meta.url), 'utf8'), /rereadKey: reread/);
});
