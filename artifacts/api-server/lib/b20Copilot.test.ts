import assert from 'node:assert/strict';
import test from 'node:test';
import { B20CopilotAskResponseV1Schema } from '@mioagent/api-zod';
import type { B20OpportunityCardV1 } from '@mioagent/opportunity-rail';
import type { B20OpportunityObservationV1 } from '@mioagent/route-storage';
import {
  answerB20CopilotV1,
  b20ObservationRefMatchesV1,
  classifyB20CopilotQuestionV1,
} from './b20Copilot.js';

const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const TOKEN = '0xb200000000000000000000195a5f43905160ee01';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function card(overrides: Partial<NonNullable<B20OpportunityCardV1['observation']>> = {}): B20OpportunityCardV1 {
  return {
    schemaVersion: 'b20-opportunity-card/v1',
    project: null,
    launch: {
      tokenAddress: TOKEN,
      name: 'AVANTIS',
      symbol: 'AVANTIS',
      variant: 'asset',
      decimals: 18,
      blockNumber: '49929300',
      transactionHash: `0x${'1'.repeat(64)}`,
      logIndex: 1,
      detectedAt: '2026-08-13T18:00:00.000Z',
      launchedAt: '2026-08-13T17:59:00.000Z',
      launchTimeSource: 'onchain_block',
      ageSeconds: 3_600,
      canonical: true,
    },
    observation: {
      observationId: HASH_A,
      evidenceHash: HASH_B,
      state: 'rejected',
      reasonCode: 'no_exit_route',
      standing: {
        kind: 'no_buyers_yet',
        headline: 'Nobody has bought this yet.',
        detail: 'No buyer appeared in the measured launch window.',
        aboutToken: true,
      },
      headline: 'Nobody has bought this yet.',
      detail: 'Miorail found an entry route but no supported route back out.',
      referencePositionAtomic: '100000000',
      referenceQuoteAsset: USDC,
      maxRoundTripBps: 300,
      maxExitSlippageBps: 300,
      entryRouteFound: true,
      exitRouteFound: false,
      entrySourceKey: 'uniswap-v4:pool',
      exitSourceKey: null,
      poolHook: {
        standing: 'standard',
        permissions: {
          hook: '0x985c14baa2a18316ffda0aefb3a632fadfca2acc',
          permissionBits: 10956,
          flags: ['before_swap'],
          none: false,
          mayChangeSwapAmounts: true,
          mayInterceptSwaps: true,
          mayGateLiquidity: true,
        },
      },
      launchBuyers: null,
      launchBuyerWindow: { status: 'collecting', closesAtBlock: '49939300' },
      optimisticReturnAtomic: null,
      optimisticRoundTripBps: null,
      routeCoverage: 'complete',
      venuesConsulted: ['uniswap-v4'],
      viableRouteConfirmed: false,
      bestRouteConfirmed: false,
      largestPassingSizeAtomic: null,
      firstFailingSizeAtomic: null,
      capacityToleranceBps: 300,
      capacityProbeCount: 0,
      capacityStable: null,
      transfersPaused: false,
      transferPolicyState: 'open',
      transferPolicyNotice: null,
      controlsComplete: true,
      controlsBlockNumber: '49929328',
      observationBlockNumber: '49929328',
      quoteAlignment: 'anchored',
      quoteAlignmentNotice: null,
      preEntryNotice: null,
      measuredAt: '2026-08-13T19:06:45.893Z',
      staleAfter: '2026-08-13T19:21:45.893Z',
      freshness: 'fresh',
      ...overrides,
    },
    canCheckProfile: false,
    action: { action: 'none', label: null, reason: 'No wallet check can create a supported exit route.' },
    notMeasured: ['future price', 'profit probability', 'related-wallet clusters'],
  };
}

function history(overrides: Partial<B20OpportunityObservationV1> = {}): B20OpportunityObservationV1 {
  return {
    id: HASH_A,
    evidenceHash: HASH_B,
    measurementVersion: 'b20-observation/v1',
    profileIdentity: `${USDC}:100000000:300:300`,
    state: 'rejected',
    reasonCode: 'no_exit_route',
    exitRouteFound: false,
    routeCoverage: 'complete',
    optimisticRoundTripBps: null,
    largestPassingSizeAtomic: null,
    observationBlockNumber: '49929328',
    referenceQuoteAsset: USDC,
    ...overrides,
  } as B20OpportunityObservationV1;
}

test('natural-language examples route to bounded evidence questions', () => {
  assert.equal(classifyB20CopilotQuestionV1('Why was this rejected?'), 'why_rejected');
  assert.equal(classifyB20CopilotQuestionV1('Что здесь необычного?'), 'unusual');
  assert.equal(classifyB20CopilotQuestionV1('Каких evidence не хватает?'), 'missing_evidence');
  assert.equal(classifyB20CopilotQuestionV1('Can I get out with a $100 position?'), 'exit_capacity');
  assert.equal(classifyB20CopilotQuestionV1('Compare with previous measurement'), 'compare_previous');
});

test('an Ask-this-card reference must match both append-only identity and evidence', () => {
  assert.equal(
    b20ObservationRefMatchesV1(
      { id: HASH_A, evidenceHash: HASH_B },
      { observationId: HASH_A, evidenceHash: HASH_B },
    ),
    true,
  );
  assert.equal(
    b20ObservationRefMatchesV1(
      { id: HASH_A, evidenceHash: HASH_B },
      { observationId: HASH_A, evidenceHash: `0x${'c'.repeat(64)}` },
    ),
    false,
  );
  assert.equal(
    b20ObservationRefMatchesV1(null, { observationId: null, evidenceHash: null }),
    true,
  );
  assert.equal(
    b20ObservationRefMatchesV1(
      { id: HASH_A, evidenceHash: HASH_B },
      { observationId: null, evidenceHash: null },
    ),
    false,
  );
});

test('a rejection answer names the exact reason and preserves the product boundary', () => {
  const answer = answerB20CopilotV1({ card: card(), history: [history()], question: 'Why rejected?' });
  assert.equal(answer.questionKind, 'why_rejected');
  assert.match(answer.answer, /no_exit_route/);
  assert.match(answer.answer, /block 49929328/);
  assert.match(answer.answer, /not a scam label/);
  assert.equal(answer.answerSource, 'deterministic_evidence');
  B20CopilotAskResponseV1Schema.parse(answer);
});

test('missing evidence stays missing and is never rendered as a zero', () => {
  const answer = answerB20CopilotV1({ card: card(), history: [history()], question: 'What evidence is missing?' });
  assert.ok(answer.missingEvidence.some((item) => /supported exit route/i.test(item)));
  assert.ok(answer.missingEvidence.some((item) => /launch-buying window/i.test(item)));
  assert.ok(answer.missingEvidence.some((item) => /second comparable observation/i.test(item)));
  assert.doesNotMatch(answer.answer, /0\.00%/);
});

test('a dollar exit question compares only against a USDC ladder and still opens Routes', () => {
  const measured = card({
    state: 'provisional',
    reasonCode: 'quoted_pre_entry',
    detail: 'A supported round trip passed the reference profile.',
    exitRouteFound: true,
    optimisticRoundTripBps: 180,
    largestPassingSizeAtomic: '180000000',
    firstFailingSizeAtomic: '240000000',
    capacityProbeCount: 4,
    capacityStable: true,
    viableRouteConfirmed: true,
    bestRouteConfirmed: true,
    preEntryNotice: 'Measured before entry moved the pool.',
  });
  const answer = answerB20CopilotV1({ card: measured, history: [history()], question: 'Can I get out with $100?' });
  assert.match(answer.answer, /100 USDC is not greater than the largest passing probe/);
  assert.match(answer.answer, /not an executable quote/);
  assert.equal(answer.routeHandoff?.label, 'Open in Routes');
  assert.match(answer.routeHandoff?.goal ?? '', /to USDC/);
});

test('hook explanation states permission and refuses to infer behaviour', () => {
  const answer = answerB20CopilotV1({ card: card(), history: [history()], question: 'Explain this hook' });
  assert.match(answer.answer, /permits it to/);
  assert.match(answer.answer, /Permissions do not prove behaviour/);
});

test('previous-measurement comparison is a deterministic delta', () => {
  const current = card({
    state: 'provisional',
    reasonCode: 'quoted_pre_entry',
    exitRouteFound: true,
    optimisticRoundTripBps: 180,
    largestPassingSizeAtomic: '180000000',
  });
  const answer = answerB20CopilotV1({
    card: current,
    history: [
      history(),
      history({ id: `0x${'c'.repeat(64)}`, observationBlockNumber: '49920000' }),
    ],
    question: 'What changed since previous measurement?',
  });
  assert.match(answer.answer, /state rejected → provisional/);
  assert.match(answer.answer, /exit route missing → found/);
  assert.match(answer.answer, /block 49920000/);
});

test('previous-measurement comparison refuses a different profile', () => {
  const current = card({ state: 'provisional', reasonCode: 'quoted_pre_entry', exitRouteFound: true });
  const answer = answerB20CopilotV1({
    card: current,
    history: [
      history(),
      history({
        id: `0x${'c'.repeat(64)}`,
        observationBlockNumber: '49920000',
        profileIdentity: `${USDC}:500000000:300:300`,
      }),
    ],
    question: 'Compare with previous measurement',
  });
  assert.match(answer.answer, /no earlier comparable observation/i);
  assert.doesNotMatch(answer.answer, /49920000/);
});
