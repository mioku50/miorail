import {
  bundleEvidenceStringsV1,
  narrateB20AnswerV1,
} from '../artifacts/api-server/lib/b20Answer.js';
import { planB20AnswerV1 } from '../artifacts/api-server/lib/b20AnswerPlan.js';
import { verifyB20NarrationV1 } from '../artifacts/api-server/lib/b20AnswerVerify.js';
import { createLlmProvider } from '@mioagent/llm';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// Read-only diagnostic for the Stage 06 pipeline, against the REAL provider.
//
// The copilot route needs an authenticated Base session, so the live path
// cannot be curled. This exercises the same three components with a fixed
// bundle: plan the question, narrate the evidence, verify what came back — and
// print whether the narration would have been used or discarded.
//
// It is the only way to find out the thing that matters operationally: how
// often a real model actually satisfies the verifier. A pipeline that always
// falls back is a pipeline that costs a request and changes nothing.
//
// Sends the bundle and the question to the configured provider. Sends no
// wallet, no token address and no key. Prints no endpoint.
// ---------------------------------------------------------------------------

const BUNDLE_V1 = {
  intent: 'card' as const,
  facts: [
    { label: 'Round trip', value: 'not measured' },
    { label: 'Exit capacity', value: 'not measured' },
    { label: 'Route liquidity', value: 'Entry found · exit missing' },
    { label: 'Bought at launch', value: '62 wallets · largest 12.00%' },
    { label: 'Measured at', value: 'block 49929328' },
    { label: 'Measured against', value: '0.03 ETH · 3.00% round trip' },
  ],
  missing: [
    'a supported exit route at the reference size',
    'a second comparable observation to compare against',
  ],
  caveats: [
    'This describes one stored measurement, not a recommendation.',
    'Launch-window buying is gross buying, not current holdings.',
  ],
};

const QUESTIONS_V1 = [
  'What happened here?',
  'Why was this rejected?',
  'Что здесь необычного?',
  'Can I get out with a 100 USDC position?',
  'Should I buy this?',
  'Сколько запусков всего измерено?',
];

async function main(): Promise<void> {
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  let provider: ReturnType<typeof createLlmProvider> | null = null;
  try {
    provider = createLlmProvider();
    console.log('provider: configured\n');
  } catch (error) {
    console.log(`provider: NOT configured (${error instanceof Error ? error.message : 'unknown'})`);
    console.log('every answer will be the deterministic sentence, which is the designed fallback.\n');
  }

  let used = 0;
  let refused = 0;
  for (const question of QUESTIONS_V1) {
    const plan = planB20AnswerV1({ question, tokenAddress: '0x' + 'b2'.repeat(20) });
    if (plan.refusal) {
      console.log(`Q: ${question}\n   PLAN refused (${plan.intent}) — no model call`);
      console.log(`   → ${plan.refusal}\n`);
      continue;
    }
    const result = await narrateB20AnswerV1({
      question,
      bundle: BUNDLE_V1,
      deterministic: 'A purchase priced against the measured pool; a sale did not.',
      provider,
    });
    if (result.answerSource === 'verified_narration') used += 1;
    else refused += 1;
    console.log(`Q: ${question}\n   ${result.answerSource}`);
    if (result.narrationRejectedBecause) {
      console.log(`   because: ${result.narrationRejectedBecause.join(' | ')}`);
    }
    console.log(`   → ${result.answer.replace(/\n+/g, ' ').slice(0, 260)}\n`);
  }

  console.log(`narrations used ${used}, fell back ${refused}`);
  // A self-check on the verifier itself: if a deliberately wrong narration
  // passed, the run above proves nothing.
  const control = verifyB20NarrationV1({
    narration: 'The round trip was 2.4% and this is a safe token.',
    evidence: bundleEvidenceStringsV1(BUNDLE_V1),
  });
  console.log(`verifier control (must be refused): ok=${control.ok} — ${control.violations.join(' | ')}`);
}

void main();
