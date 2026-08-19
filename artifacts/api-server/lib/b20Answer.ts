import type { LlmProvider } from '@mioagent/llm';

import {
  verifyB20NarrationV1,
  b20NarrationEvidenceStrengthV1,
  B20_NARRATION_MAX_CHARS_V1,
  B20_NARRATION_MAX_EVIDENCE_NUMBERS_V1,
  type B20AnswerAssertionsV1,
} from './b20AnswerVerify.js';
import type { B20AnswerPlanV1 } from './b20AnswerPlan.js';
import type { B20ConsoleIntentV1 } from './b20ConsolePlan.js';

// ---------------------------------------------------------------------------
// Plan → evidence → narration → verification, in that order and no other.
//
// The model sits in exactly one place: it turns a bundle of already-measured
// facts into a sentence. It does not choose what to read (the planner does,
// from a fixed list), it does not read anything (the executor does), and it
// does not get the last word (the verifier does).
//
// The fallback is the point. Every failure — no provider configured, a timeout,
// a refusal, an unverifiable answer — lands on the deterministic sentence this
// product already shipped. So the worst case of adding a model here is the
// product as it was, and `answerSource` says which one the reader got rather
// than leaving it to be guessed from the prose.
// ---------------------------------------------------------------------------

export interface B20EvidenceFactV1 {
  label: string;
  value: string;
}

export interface B20EvidenceBundleV1 {
  /** What the planner decided the question was. Either planner's vocabulary:
   * one narrator serves the card and the global console, and it is given the
   * same bundle shape by both. */
  intent: B20AnswerPlanV1['intent'] | B20ConsoleIntentV1;
  /** The measured facts, already formatted. A narrator may quote these and
   * nothing else. */
  facts: B20EvidenceFactV1[];
  /** Named absences. As load-bearing as the facts, and the ONLY absences a
   * narration may state — see rule 4. */
  missing: string[];
  /** Sentences that must survive any paraphrase. */
  caveats: string[];
  /**
   * What the deterministic answer MEANT, for the verifier to hold a narration
   * to.
   *
   * Not part of the prompt — the narrator is told the same things in words,
   * and this is what checks that it listened. Optional so a caller that has
   * not been taught to compute it still narrates as before, with the number
   * and vocabulary rules alone.
   */
  assertions?: B20AnswerAssertionsV1;
}

export type B20AnswerSourceV1 = 'deterministic_evidence' | 'verified_narration';

export interface B20NarratedAnswerV1 {
  answer: string;
  answerSource: B20AnswerSourceV1;
  /** Why the narration was not used, when it was not. Operator-facing. */
  narrationRejectedBecause: string[] | null;
}

/** Every string a narrator is allowed to draw a number from. */
export function bundleEvidenceStringsV1(bundle: B20EvidenceBundleV1): string[] {
  return [
    ...bundle.facts.flatMap((fact) => [fact.label, fact.value]),
    ...bundle.missing,
    ...bundle.caveats,
  ];
}

/**
 * The instruction the narrator gets.
 *
 * Written as constraints rather than as a persona, because a persona is not
 * checkable and these are: every one of them has a corresponding rule in the
 * verifier, and a narration that ignores them is discarded rather than
 * argued with.
 */
export const B20_NARRATOR_SYSTEM_V1 = `You are the narrator for Miorail, a Base L2 route-intelligence product. You are given a bundle of measurements and you write one short answer from it.

Rules, all enforced automatically after you answer:

1. Use ONLY numbers that appear verbatim in the bundle. Do not round, convert, sum, average or derive. If a figure is not in the bundle, do not write a figure.
2. Never recommend, warn about, or characterise a token. No "safe", "unsafe", "scam", "rug", "opportunity", "promising". Miorail measures exit conditions; none of those are measurements.
3. Never claim an outcome. A measured quote is not a promise that a trade will fill.
4. State absences as plainly as presences — but ONLY the absences the bundle lists under NOT MEASURED. "Not measured" is never a general fallback. If the bundle contains measured facts, the answer states them; answering "not measured" over a bundle that measured something is the one failure that makes this whole surface untrustworthy. An absence is also never a zero.
5. When the bundle says a finding is about MIORAIL rather than about the token — a venue it did not search, a call that did not answer — say so. Do not report it as a property of the token.
6. Do not change what the answer is. You are rephrasing a conclusion that has already been reached: if it names tokens, name them; if it counts matches, keep the count; if it says a scan hit its limit, keep that. You may shorten, explain or translate. You may not replace it with a different conclusion.
7. Answer in the language of the question. Be brief: a few sentences, under ${B20_NARRATION_MAX_CHARS_V1} characters.

Write only the answer. No preamble, no headings, no lists unless the bundle is a list.`;

function bundleAsPromptV1(bundle: B20EvidenceBundleV1, question: string): string {
  const lines: string[] = [`QUESTION: ${question}`, '', 'MEASURED FACTS:'];
  for (const fact of bundle.facts) lines.push(`- ${fact.label}: ${fact.value}`);
  if (bundle.missing.length > 0) {
    lines.push('', 'NOT MEASURED (state these as absences, never as zero):');
    for (const item of bundle.missing) lines.push(`- ${item}`);
  }
  if (bundle.caveats.length > 0) {
    lines.push('', 'MUST SURVIVE ANY PARAPHRASE:');
    for (const item of bundle.caveats) lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

/**
 * Narrates a bundle, or explains why the deterministic answer was kept.
 *
 * `deterministic` is not a fallback bolted on afterwards — it is the answer,
 * and the narration only replaces it by passing every check.
 */
export async function narrateB20AnswerV1(input: {
  question: string;
  bundle: B20EvidenceBundleV1;
  deterministic: string;
  provider: LlmProvider | null;
  /** Bounded so a hung provider cannot hold a request open. */
  timeoutMs?: number;
}): Promise<B20NarratedAnswerV1> {
  const keep = (because: string[]): B20NarratedAnswerV1 => ({
    answer: input.deterministic,
    answerSource: 'deterministic_evidence',
    narrationRejectedBecause: because,
  });

  if (!input.provider) return keep(['no language provider is configured']);

  // Checked BEFORE the call, because a bundle too wide to verify is a bundle
  // not worth paying to narrate. The deterministic answer already states every
  // figure in it.
  const evidence = bundleEvidenceStringsV1(input.bundle);
  const strength = b20NarrationEvidenceStrengthV1(evidence);
  if (!strength.strongEnough) {
    return keep([
      `the evidence carries ${strength.distinctNumbers} distinct figures, over the ${B20_NARRATION_MAX_EVIDENCE_NUMBERS_V1} a narration can be checked against`,
    ]);
  }

  let narration: string;
  try {
    const response = await Promise.race([
      input.provider.generate({
        messages: [
          { role: 'system', content: B20_NARRATOR_SYSTEM_V1 },
          { role: 'user', content: bundleAsPromptV1(input.bundle, input.question) },
        ],
        // Zero, because this is transcription with grammar. Sampling here buys
        // variety in a place where variety is the defect.
        temperature: 0,
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('narrator timed out')), input.timeoutMs ?? 12_000),
      ),
    ]);
    narration = (response.message.content ?? '').trim();
  } catch (error) {
    // The message, never the cause: a provider error carries a base URL, and a
    // base URL carries a key.
    return keep([`the narrator did not answer (${error instanceof Error ? error.name : 'unknown'})`]);
  }

  const verdict = verifyB20NarrationV1({ narration, evidence, assertions: input.bundle.assertions });
  if (!verdict.ok) return keep(verdict.violations);

  // The VERIFIED string, not the raw one. Verifying one text and displaying
  // another is how a check stops checking what ships.
  return { answer: verdict.narration, answerSource: 'verified_narration', narrationRejectedBecause: null };
}
