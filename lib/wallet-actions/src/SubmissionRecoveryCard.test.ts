import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createConfig, http, WagmiProvider } from 'wagmi';
import { base } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SubmissionAttemptWireV1 } from '@mioagent/api-spec';

import { RECOVERY_AUTO_RESUME_MS_V1, SubmissionRecoveryCard } from './SubmissionRecoveryCard';
import { SUBMISSION_ALREADY_SENT_V1, SUBMISSION_UNRECORDED_V1 } from './useSubmitApprovedBlueprint';

// ---------------------------------------------------------------------------
// The operator, 2026-11-12: «сделай автозакрытие». A card closes by itself
// only on the chain's answer: one with a batch asks at once what became of it,
// and one without a batch, which has nothing to ask about, stays as it was.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';

function attempt(patch: Partial<SubmissionAttemptWireV1> = {}): SubmissionAttemptWireV1 {
  return {
    schemaVersion: 'submission-attempt/v1',
    id: 'submission-attempt:1',
    walletAddress: WALLET,
    chainId: 8453,
    goal: 'swap',
    routeRunId: 'run-1',
    blueprintId: 'blueprint-1',
    proofId: 'route-proof:blueprint-1',
    approvedCallsHash: `0x${'ab'.repeat(32)}`,
    batchId: `0x${'cd'.repeat(32)}`,
    status: 'submitted',
    errorCode: null,
    createdAt: '2026-11-12T13:39:00.000Z',
    updatedAt: '2026-11-12T13:40:00.000Z',
    completedAt: null,
    ...patch,
  } as SubmissionAttemptWireV1;
}

function render(props: Partial<React.ComponentProps<typeof SubmissionRecoveryCard>>): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const config = createConfig({ chains: [base], transports: { [base.id]: http() } });
  return renderToStaticMarkup(
    React.createElement(WagmiProvider, { config },
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(SubmissionRecoveryCard, { attempt: attempt(), markerStorage: null, ...props }))),
  );
}

test('a card with a batch asks at once, by itself, and offers no press while it does', () => {
  const html = render({ autoResume: true });
  assert.match(html, /Checking with your wallet…/);
  assert.doesNotMatch(html, />Resume verification</);
  // Dismissing stays possible.
  assert.match(html, />Dismiss recovery</);
});

test('without the automatic ask the card waits for the press, as before', () => {
  const html = render({});
  assert.match(html, />Resume verification</);
  assert.doesNotMatch(html, /Checking with your wallet…/);
});

test('a card without a batch has nothing to ask about, and does not pretend to', () => {
  const html = render({ autoResume: true, attempt: attempt({ batchId: null, status: 'wallet_pending' }) });
  assert.doesNotMatch(html, /Checking with your wallet…|Resume verification/);
  assert.match(html, /The wallet batch identifier was not captured\./);
  assert.match(html, />Open wallet activity</);
});

test('the automatic ask is bounded, and the rail turns it on with a settle that opens nothing', () => {
  assert.equal(RECOVERY_AUTO_RESUME_MS_V1, 120_000);
  const rail = readFileSync(resolve(import.meta.dirname, 'SubmissionRecoveryRail.tsx'), 'utf8');
  assert.match(rail, /autoResume\n/);
  assert.match(rail, /onSettled=\{\(\) => void query\.refetch\(\)\}/);
});

test('calls that already reached Base are refused in words that do not invite pressing again', () => {
  assert.match(SUBMISSION_ALREADY_SENT_V1, /already went to Base from your wallet once/);
  assert.match(SUBMISSION_ALREADY_SENT_V1, /Compare again for a fresh quote\./);
  assert.doesNotMatch(SUBMISSION_ALREADY_SENT_V1, /Press again/);
  // The other refusal still says what it said.
  assert.match(SUBMISSION_UNRECORDED_V1, /Press again in a moment\./);
});
