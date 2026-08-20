import { b20RouteRuntime, runB20ConsolePlanV1 } from '../artifacts/api-server/routes/b20Control.js';
import { b20ScopeIsPrivateV1, type B20ConsoleScopeV1 } from '../artifacts/api-server/lib/b20ConsolePlan.js';
import { resolveB20ConsolePlanV1 } from '../artifacts/api-server/lib/b20ConsoleIntent.js';
import { b20NarrationEvidenceStrengthV1 } from '../artifacts/api-server/lib/b20AnswerVerify.js';
import { narrateB20AnswerV1 } from '../artifacts/api-server/lib/b20Answer.js';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// Read-only diagnostic for the Stage 07 global console, against the REAL
// corpus.
//
// The endpoint needs an authenticated Base session, so the live path cannot be
// curled. This runs the same planner and the same executor the route runs,
// against the same database, and prints what a reader would be shown.
//
// What it is actually checking, in order of how badly each would fail:
//
//   1. That a count of MIORAIL'S OWN LIMITS is never printed in the shape of a
//      count of tokens. This is the product's recurring bug and a console that
//      prints counts is where it would be made at scale.
//   2. That the evidence bundle stays narrow enough for the verifier to mean
//      something. Printed as a number, not asserted, because the ceiling was
//      chosen from a measurement and should keep being one.
//   3. That "no comparison" is never rendered as "no movement".
//
// Reads only. No wallet, no key, no calldata, no write. Prints no endpoint and
// no credential.
// ---------------------------------------------------------------------------

const QUESTIONS_V1: readonly { scope: B20ConsoleScopeV1; question: string; tokenAddresses?: string[] }[] = [
  // ── The acceptance prompts, typed the way a reader types them ────────────
  //
  // Every line below is a sentence somebody actually wrote into the live
  // console, not a phrasing chosen to fit a pattern. That distinction is the
  // whole point: the matcher used to recognise Miorail's own vocabulary and
  // almost nothing else, so a question in plain English fell through to the
  // universe counts and looked like the console misunderstanding it.
  { scope: 'explore', question: 'How many B20 launches were measured in the last 48 hours?' },
  { scope: 'explore', question: 'Which B20 tokens were bought but a sale could not be priced?' },
  { scope: 'explore', question: 'Show B20 tokens where both entry and exit were priced' },
  { scope: 'explore', question: 'Which B20 launches need more evidence, and why?' },
  { scope: 'explore', question: 'What changed among B20 tokens in the last 24 hours?' },
  { scope: 'explore', question: 'Find me B20 projects with a live product' },
  // Asked from Investigate on purpose: this used to be refused with "paste an
  // address", which reads as a console that cannot parse a plain sentence.
  { scope: 'investigate', question: 'Find me the most interesting B20 tokens to investigate' },

  // ── Russian is first-class; the same readings have to hold ───────────────
  { scope: 'explore', question: 'Какие токены купили, а продать нельзя?' },
  { scope: 'explore', question: 'что изменилось за сутки' },
  { scope: 'explore', question: 'Какие запуски требуют больше доказательств?' },
  // Deliberately avoids the product's own words. This exercises semantic
  // intent resolution rather than one more phrase added to a regex list.
  { scope: 'explore', question: 'Surface assets where acquisition worked but disposal could not be established' },

  // ── Refused before any read ──────────────────────────────────────────────
  { scope: 'explore', question: 'Which of these will moon?' },
  { scope: 'investigate', question: 'tell me about it' },
];

/**
 * The four acceptance tokens: indexed, canonical, and never measured.
 *
 * Each one is a launch that missed the worker's 48-hour window, which is the
 * state 820 launches were in when this was written. Asked about here in the
 * plainest four ways somebody would ask, because "What was measured here?" is
 * Miorail's phrasing and nobody else's.
 */
const ACCEPTANCE_TOKENS_V1: readonly { symbol: string; address: string; question: string }[] = [
  { symbol: 'FLAG', address: '0xb20000000000000000000047f57bc93d7f130101', question: 'Investigate 0xb20000000000000000000047f57bc93d7f130101' },
  { symbol: 'B420', address: '0xb200000000000000000000231d6c1f1ce455ba32', question: 'Check 0xb200000000000000000000231d6c1f1ce455ba32' },
  { symbol: 'BPEPE', address: '0xb2000000000000000000008eeba3a477300c5601', question: 'What do we know about 0xb2000000000000000000008eeba3a477300c5601?' },
  { symbol: 'RWAGMI', address: '0xb200000000000000000000bf0548ab2ebd00ba5e', question: 'Does this B20 token have a working market? 0xb200000000000000000000bf0548ab2ebd00ba5e' },
];

function summariseV1(text: string, width = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

async function main(): Promise<void> {
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const tokenArgs = process.argv.slice(2).filter((value) => /^0x[0-9a-fA-F]{40}$/.test(value));
  const questions = tokenArgs.length > 0
    ? [
        ...QUESTIONS_V1,
        ...ACCEPTANCE_TOKENS_V1.map((token) => ({ scope: 'investigate' as const, question: token.question })),
        { scope: 'investigate' as const, question: 'Compare these.', tokenAddresses: tokenArgs },
        // The private scope, exercised with addresses an operator supplied.
        // Nothing here reaches a provider and nothing is logged; the controls
        // below check the second half of that.
        { scope: 'portfolio' as const, question: 'Which of my positions is hardest to close?', tokenAddresses: tokenArgs },
      ]
    : [
        ...QUESTIONS_V1,
        ...ACCEPTANCE_TOKENS_V1.map((token) => ({ scope: 'investigate' as const, question: token.question })),
      ];

  if (!(await b20RouteRuntime.discoverAvailable())) {
    console.error('Discover storage is unavailable — nothing to read.');
    process.exitCode = 1;
    return;
  }

  let widest = 0;
  for (const input of questions) {
    const resolution = await resolveB20ConsolePlanV1({
      ...input,
      provider: b20RouteRuntime.classifier(),
    });
    const plan = resolution.plan;
    console.log('');
    console.log(`Q  [${input.scope}] ${input.question}`);
    if (plan.refusal) {
      console.log(`   refused before any read (${plan.intent} · ${resolution.source}${resolution.reason ? ` · ${resolution.reason}` : ''})`);
      console.log(`   ${summariseV1(plan.refusal)}`);
      continue;
    }

    const started = Date.now();
    const answer = await runB20ConsolePlanV1(plan);
    const evidence = [
      ...answer.facts.flatMap((fact) => [fact.label, fact.value]),
      ...answer.missingEvidence,
      ...answer.caveats,
    ];
    const strength = b20NarrationEvidenceStrengthV1(evidence);
    widest = Math.max(widest, strength.distinctNumbers);

    console.log(`   answered in ${plan.scope} as ${plan.intent} · ${resolution.source} · ${Date.now() - started}ms`);
    console.log(`   deterministic: ${summariseV1(answer.answer)}`);

    // The narrated answer, which is what a reader is actually shown — and where
    // the failure this gate exists for lived: a fluent, figure-free sentence
    // saying the opposite of the evidence under it. Private scopes are never
    // narrated, so the provider is withheld exactly as the route withholds it.
    const narrated = await narrateB20AnswerV1({
      question: input.question,
      bundle: {
        intent: plan.intent,
        facts: answer.facts.map((fact) => ({ label: fact.label, value: fact.value })),
        missing: answer.missingEvidence,
        caveats: answer.caveats,
        assertions: answer.assertions,
      },
      deterministic: answer.answer,
      provider: b20ScopeIsPrivateV1(plan.scope) ? null : b20RouteRuntime.narrator(),
    });
    console.log(`   source: ${narrated.answerSource}`);
    if (narrated.narrationRejectedBecause) {
      console.log(`   narration not used: ${narrated.narrationRejectedBecause.join('; ')}`);
    }
    console.log(`   shown: ${summariseV1(narrated.answer)}`);
    console.log(
      `   assertions: state=${answer.assertions.state} matched=${answer.assertions.matched}` +
        ` complete=${answer.assertions.complete} about=${answer.assertions.about}` +
        ` subjects=${answer.assertions.subjects.length}`,
    );
    console.log(
      `   evidence: ${answer.facts.length} facts · ${strength.distinctNumbers} distinct figures · narratable=${strength.strongEnough}`,
    );
    console.log(`   read: ${answer.reads.map((read) => read.tool).join(', ') || 'nothing'}`);
    if (answer.missingEvidence.length > 0) {
      console.log(`   absences: ${answer.missingEvidence.length} — ${summariseV1(answer.missingEvidence[0]!, 120)}`);
    }

    // The control this probe exists for. A count under a conclusion that is
    // about Miorail must never be stated as a property of that many tokens.
    const limitFact = answer.facts.find((fact) => /Miorail could not measure/i.test(fact.label));
    if (limitFact && !/Miorail’s own limit/.test(limitFact.value)) {
      console.error('   FAIL: a Miorail-limit count was printed as a count of tokens');
      process.exitCode = 1;
    }
    if (plan.intent === 'measured_changes' && /nothing moved|no movement/i.test(answer.answer)) {
      console.error('   FAIL: an absence of comparison was rendered as an absence of movement');
      process.exitCode = 1;
    }
    if (b20ScopeIsPrivateV1(plan.scope)) {
      // The private scope's two obligations, checked rather than trusted: the
      // answer states whose size was measured, and nothing that goes back into
      // a log repeats which tokens the wallet holds.
      if (!/not at the size you are holding/.test(answer.answer)) {
        console.error('   FAIL: a portfolio answer did not state that the measured size is not the held size');
        process.exitCode = 1;
      }
      const surfaced = JSON.stringify(answer.reads);
      for (const address of plan.tokenAddresses) {
        if (surfaced.includes(address)) {
          console.error('   FAIL: a held token address was repeated into the reads list');
          process.exitCode = 1;
        }
      }
    }
  }

  console.log('');
  console.log(`Widest evidence bundle: ${widest} distinct figures.`);
}

void main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    // The message only. A storage error carries a connection string.
    console.error(`probe failed: ${error instanceof Error ? error.name : 'unknown'}`);
    process.exit(1);
  },
);
