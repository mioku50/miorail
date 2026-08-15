import { b20RouteRuntime, runB20ConsolePlanV1 } from '../artifacts/api-server/routes/b20Control.js';
import { b20ScopeIsPrivateV1, planB20ConsoleAnswerV1, type B20ConsoleScopeV1 } from '../artifacts/api-server/lib/b20ConsolePlan.js';
import { b20NarrationEvidenceStrengthV1 } from '../artifacts/api-server/lib/b20AnswerVerify.js';

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
  { scope: 'explore', question: 'How many launches were measured?' },
  { scope: 'explore', question: 'Which tokens did people buy but cannot sell?' },
  { scope: 'explore', question: 'Where was coverage incomplete?' },
  { scope: 'changes', question: 'What changed in the last day?' },
  // Russian is first-class on this console; the same reading has to hold.
  { scope: 'explore', question: 'Какие токены купили, а продать нельзя?' },
  { scope: 'explore', question: 'что изменилось за сутки' },
  // Must be refused before any read.
  { scope: 'explore', question: 'Which of these will moon?' },
  { scope: 'investigate', question: 'tell me about it' },
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
        { scope: 'investigate' as const, question: 'Compare these.', tokenAddresses: tokenArgs },
        // The private scope, exercised with addresses an operator supplied.
        // Nothing here reaches a provider and nothing is logged; the controls
        // below check the second half of that.
        { scope: 'portfolio' as const, question: 'Which of my positions is hardest to close?', tokenAddresses: tokenArgs },
      ]
    : QUESTIONS_V1;

  if (!(await b20RouteRuntime.discoverAvailable())) {
    console.error('Discover storage is unavailable — nothing to read.');
    process.exitCode = 1;
    return;
  }

  let widest = 0;
  for (const input of questions) {
    const plan = planB20ConsoleAnswerV1(input);
    console.log('');
    console.log(`Q  [${input.scope}] ${input.question}`);
    if (plan.refusal) {
      console.log(`   refused before any read (${plan.intent})`);
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

    console.log(`   answered in ${plan.scope} as ${plan.intent} · ${Date.now() - started}ms`);
    console.log(`   ${summariseV1(answer.answer)}`);
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
