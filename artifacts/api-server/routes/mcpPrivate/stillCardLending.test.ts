import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { hashApprovedCallsV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';

import { issueLendingDraftV1, type LendingQuestionV1 } from '../../lib/lendingDraft.js';
import type { LendingRunV1 } from '../../lib/lendingReview.js';
import { MemoryLoanExecutionStoreV1 } from '../../lib/loanExecutionStore.js';
import { rwaLendingRuntimeV1 } from '../rwaLending.js';
import { mcpAuditRuntime } from './audit.js';
import { createMiorailPrivateMcpServerV1 } from './server.js';
import { StillCardLendingInputV1Schema, cardReviewBodyV1, stillCardLendingV1 } from './stillCardLending.js';

// The card's way to the review it signs: the page's own lending routes, run as
// the grant's wallet. Every loan, hash and wallet here is synthetic.
const WALLET = `0x${'1'.repeat(40)}` as const, OTHER = `0x${'2'.repeat(40)}` as const;
const IDENTITY = { tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET, chainId: 8453 as const, tokenId: 'grant-card-test', source: 'oauth' as const };
const NOW = new Date('2026-11-02T15:00:00.000Z'), SECRET = 'still-card-fixture-secret-never-production';
const STOCK = STOCKS.find((stock) => stock.id === 'NVDAc')!.token.toLowerCase();
const ROOT = '/api/route-intelligence/rwa/lending';

function loanRun(question: LendingQuestionV1): Extract<LendingRunV1, { state: 'ready' }> {
  if (question.operation !== 'borrow') throw new Error('borrow only');
  const calls: ExecutionCallV1[] = [{ index: 0, callType: 'other', to: ADDRESSES.aaveSpoke.toLowerCase() as `0x${string}`, valueWei: '0', data: '0x12345678', asset: null, amountAtomic: null, recipient: null, spender: null }];
  return { state: 'ready', calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: `0x${'11'.repeat(32)}`, expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    atomicRequired: true, steps: [{ index: 0, to: calls[0]!.to, reading: 'Synthetic fixture only' }], measured: { blockNumber: 53_100_000, provider: 'fixture', loanDeltaAssets: question.borrowAssets },
    facts: { operation: 'borrow', venue: 'aave-v4', collateralTokenAddress: question.collateralTokenAddress, collateralSymbol: 'NVDAc', collateralDecimals: 8,
      marketId: ADDRESSES.aaveSpoke.toLowerCase(), amountMode: 'assets', requestedAssets: question.borrowAssets, maximumDebitAssets: '0', collateralSupplyAssets: question.collateralSupplyAssets,
      debtBeforeAssets: '0', debtAfterAssets: question.borrowAssets, collateralBeforeAssets: '0', collateralAfterAssets: '0', debtBeforeShares: '0', debtAfterShares: '1', blockNumber: 53_100_000, warnings: [] } };
}

function fixture(t: test.TestContext, input: { audit?: 'ok' | 'down' } = {}) {
  const originalLending = { ...rwaLendingRuntimeV1 }, originalAudit = { ...mcpAuditRuntime };
  const store = new MemoryLoanExecutionStoreV1();
  const audited: Array<Record<string, unknown>> = [];
  Object.assign(rwaLendingRuntimeV1, { store: async () => store, secret: () => SECRET, now: () => NOW,
    runAave: async ({ question }: { question: LendingQuestionV1 }) => loanRun(question) });
  Object.assign(mcpAuditRuntime, {
    available: async () => input.audit !== 'down',
    audit: () => ({ record: async (row: Record<string, unknown>) => { audited.push(row); }, list: async () => [] }),
  });
  t.after(() => { Object.assign(rwaLendingRuntimeV1, originalLending); Object.assign(mcpAuditRuntime, originalAudit); });
  const draft = (wallet: string = WALLET) => issueLendingDraftV1({ tenantId: `eip155:8453:${wallet}`, walletAddress: wallet,
    question: { operation: 'borrow', collateralTokenAddress: STOCK, borrowAssets: '100000000', collateralSupplyAssets: '0' }, secret: SECRET, now: NOW }).draft;
  return { store, audited, draft };
}

test('the card gets the page’s own review, armed and recorded by the page’s own routes, for the grant’s wallet', async (t) => {
  const { audited, draft } = fixture(t);
  const review = await stillCardLendingV1(IDENTITY, { method: 'GET', path: `${ROOT}/review/${draft()}` });
  assert.equal(review.status, 200);
  assert.equal(review.wallet, WALLET);
  const body = review.body as { state: string; executionId: string; callsHash: string; signingTermsHash: string; calls: unknown[] };
  assert.equal(body.state, 'ready');
  assert.equal(body.calls.length, 1);
  // A ready review leaves only once its release is on record.
  assert.deepEqual(audited.map((row) => [row.toolName, row.outcome, row.planId, row.callsHash]), [['still_card_lending', 'action_released', body.executionId, body.callsHash]]);

  const arm = await stillCardLendingV1(IDENTITY, { method: 'POST', path: `${ROOT}/executions/${body.executionId}/arm`,
    body: { callsHash: body.callsHash, signingTermsHash: body.signingTermsHash } });
  const attemptId = (arm.body as { attemptId?: string }).attemptId;
  assert.equal(arm.status, 200);
  assert.match(attemptId ?? '', /^[a-zA-Z0-9_-]+$/);
  const sent = await stillCardLendingV1(IDENTITY, { method: 'POST', path: `${ROOT}/executions/${body.executionId}/submission`, body: { attemptId, outcome: 'unknown' } });
  assert.equal(sent.status, 200);
  const status = await stillCardLendingV1(IDENTITY, { method: 'GET', path: `${ROOT}/executions/${body.executionId}` });
  assert.equal((status.body as { state?: string }).state, 'unknown');
});

// Audit MCP-3 (2026-11-10): the review shows where Bitrefill sends a purchase. Through an assistant's tool
// result it is never repeated in full.
test('where a purchase goes reaches the card by its ends only, and nothing else is touched', () => {
  const review = { state: 'ready', executionId: 'execution_1', calls: [{ to: '0x1', value: '0', data: '0x' }], deliverTo: { email: 'buyer@example.com', phone: '+919876543210' } };
  const carried = cardReviewBodyV1(review) as typeof review;
  assert.deepEqual(carried.deliverTo, { email: 'b…r@example.com', phone: '+…3210' });
  assert.deepEqual({ ...carried, deliverTo: undefined }, { ...review, deliverTo: undefined });
  assert.equal(JSON.stringify(carried).includes('buyer@'), false);
  assert.equal(JSON.stringify(carried).includes('9876543210'), false);
  // A shape that is not one is dropped; an answer without one passes as it is.
  assert.deepEqual(cardReviewBodyV1({ state: 'ready', deliverTo: 'buyer@example.com' }), { state: 'ready' });
  assert.deepEqual(cardReviewBodyV1({ state: 'ready', deliverTo: { email: 'nobody', phone: null } }), { state: 'ready' });
  for (const plain of [{ state: 'refused', refusal: 'x', detail: 'y' }, null, 'text', [1]]) assert.deepEqual(cardReviewBodyV1(plain), plain);
});

test('another wallet’s draft is refused by the same check, a write must be a POST, and an unrecorded release is withheld', async (t) => {
  const { audited, draft } = fixture(t, { audit: 'down' });
  const theirs = await stillCardLendingV1(IDENTITY, { method: 'GET', path: `${ROOT}/review/${draft(OTHER)}` });
  assert.equal(theirs.status, 403);
  const wrongMethod = await stillCardLendingV1(IDENTITY, { method: 'GET', path: `${ROOT}/executions/0b8f4a51-5d0a-4c55-9d4e-0a6a3f3e2c11/arm` });
  assert.deepEqual([wrongMethod.status, (wrongMethod.body as { error: string }).error], [400, 'lending_request_invalid']);
  // Stopping a loan in steps where it stands is a write too, and reaches the page's own route.
  assert.equal(StillCardLendingInputV1Schema.safeParse({ method: 'POST', path: `${ROOT}/executions/0b8f4a51-5d0a-4c55-9d4e-0a6a3f3e2c11/stop`, body: {} }).success, true);
  const readStop = await stillCardLendingV1(IDENTITY, { method: 'GET', path: `${ROOT}/executions/0b8f4a51-5d0a-4c55-9d4e-0a6a3f3e2c11/stop` });
  assert.equal(readStop.status, 400);
  const stop = await stillCardLendingV1(IDENTITY, { method: 'POST', path: `${ROOT}/executions/0b8f4a51-5d0a-4c55-9d4e-0a6a3f3e2c11/stop`, body: {} });
  assert.deepEqual([stop.status, (stop.body as { error: string }).error], [404, 'lending_execution_not_found']);
  // So is releasing one sent as a single batch that the wallet never sent (audit LEND-1): until 2026-11-11
  // the card's path rule did not name it, and such an attempt could be released only on Still's site.
  assert.equal(StillCardLendingInputV1Schema.safeParse({ method: 'POST', path: `${ROOT}/executions/0b8f4a51-5d0a-4c55-9d4e-0a6a3f3e2c11/release`, body: {} }).success, true);
  const readRelease = await stillCardLendingV1(IDENTITY, { method: 'GET', path: `${ROOT}/executions/0b8f4a51-5d0a-4c55-9d4e-0a6a3f3e2c11/release` });
  assert.equal(readRelease.status, 400);
  const release = await stillCardLendingV1(IDENTITY, { method: 'POST', path: `${ROOT}/executions/0b8f4a51-5d0a-4c55-9d4e-0a6a3f3e2c11/release`, body: {} });
  assert.deepEqual([release.status, (release.body as { error: string }).error], [404, 'lending_execution_not_found']);
  // And nothing else under an execution is reachable through the card.
  for (const other of ['delete', 'release/', 'releases', 'arm/release']) {
    assert.equal(StillCardLendingInputV1Schema.safeParse({ method: 'POST', path: `${ROOT}/executions/0b8f4a51-5d0a-4c55-9d4e-0a6a3f3e2c11/${other}`, body: {} }).success, false, other);
  }
  const withheld = await stillCardLendingV1(IDENTITY, { method: 'GET', path: `${ROOT}/review/${draft()}` });
  assert.equal(withheld.status, 503);
  assert.ok(!JSON.stringify(withheld.body).includes('0x12345678'), 'no calls leave without their audit row');
  assert.deepEqual(audited, []);
});

test('only a client that draws apps lists the card’s tool, hidden from the model, and it reaches no other route', async (t) => {
  fixture(t);
  const connect = async (apps: boolean) => {
    const client = new Client({ name: 'card-lending-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), createMiorailPrivateMcpServerV1(IDENTITY, {}, { apps }).connect(b)]);
    t.after(() => client.close());
    return client;
  };
  const plain = await connect(false);
  assert.ok(!(await plain.listTools()).tools.some((tool) => tool.name === 'still_card_lending'));
  const drawing = await connect(true);
  const tool = (await drawing.listTools()).tools.find((entry) => entry.name === 'still_card_lending');
  assert.deepEqual(tool?._meta, { ui: { resourceUri: 'ui://still/review.html', visibility: ['app'] } });
  assert.equal(tool?.annotations?.readOnlyHint, false);
  const elsewhere = await drawing.callTool({ name: 'still_card_lending', arguments: { method: 'POST', path: '/api/route-intelligence/rwa/repay/intent', body: {} } });
  assert.equal((elsewhere as { isError?: boolean }).isError, true);
});
