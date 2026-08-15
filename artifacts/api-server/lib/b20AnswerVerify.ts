// ---------------------------------------------------------------------------
// The verifier: what a model is allowed to have said.
//
// Everything else in this pipeline can be reasoned about. This is the part that
// has to hold when the reasoning is wrong, because the failure it guards is not
// a crash — it is a fluent, plausible sentence containing a number nobody
// measured, published under Miorail's name.
//
// Three rules, in order of how badly they fail:
//
//   1. EVERY NUMBER IN THE ANSWER MUST BE IN THE EVIDENCE. Not "close to", not
//      "derivable from" — present. A narrator that computes 1.3% from a round
//      trip of 130 bps has done arithmetic nobody checked, and a narrator that
//      rounds 96.82% to "about 97%" has published a figure that is not the
//      measurement. Both are rejected. The bundle carries every figure in every
//      form the answer may use it, so quoting is always possible.
//
//   2. NO RECOMMENDATION OR ACCUSATION VOCABULARY. The same list the standing
//      copy is held to. This product measures exit conditions; "safe", "scam"
//      and "opportunity" are not among them.
//
//   3. NO CLAIM OF CERTAINTY THE MEASUREMENT CANNOT CARRY. A provisional quote
//      is not a guarantee, and a sentence saying "you will be able to sell" is
//      wrong however true the numbers around it are.
//
// A deliberate over-rejection, so a later reader does not "fix" it: a number
// from the QUESTION is not evidence either. Asked "can I get out with a 100
// USDC position", a narrator that answers with 100 in it is refused, because
// nothing distinguishes quoting the reader from asserting the figure as a
// measurement — and the bundle for an ETH-quoted pool has nothing to do with
// 100 USDC. That prompt falls back to the deterministic answer, which handles
// it well. Measured live 2026-08-15.
//
// Over-rejection is safe: a rejected narration falls back to the deterministic
// answer, which is what shipped before any of this existed. Under-rejection is
// not. So the rules are strict on purpose, and the tests below the fold pin
// exactly which paraphrases are refused.
// ---------------------------------------------------------------------------

/**
 * Removes formatting a card cannot render.
 *
 * Observed against the live provider on 2026-08-15: a narration came back as
 * "found an **entry route but no supported exit route**", and the Discover card
 * renders plain text — so the asterisks would have shipped. Stripped rather
 * than rejected: it is a cosmetic defect, and falling back to the
 * deterministic sentence over one is the wrong trade.
 *
 * Bold, italics, inline code and heading markers only. Nothing that could
 * change a number or delete a qualifier.
 */
export function stripNarrationFormattingV1(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/(^|[\s(])_(.+?)_(?=[\s.,;:!?)]|$)/gs, '$1$2')
    .replace(/`+/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim();
}

export interface B20NarrationVerdictV1 {
  ok: boolean;
  /** Human-readable, one per rule broken. Logged, never shown to a user —
   * the user gets the deterministic answer instead. */
  violations: string[];
  /** The narration as it would be SHOWN: formatting stripped. Returned so the
   * caller cannot verify one string and display another. */
  narration: string;
}

/** Longest a narration may be. A model that starts explaining the product
 * rather than the evidence runs long first. */
export const B20_NARRATION_MAX_CHARS_V1 = 900;

const FORBIDDEN_VOCABULARY_V1 =
  /\b(safe|unsafe|scam|rug|rugged|honeypot|buy now|sell now|opportunity|promising|gem|moon|guaranteed|risk-free|legit)\b/i;

/**
 * Sentences that claim an outcome rather than report a measurement.
 *
 * Deliberately about the CLAIM, not the sentiment: "you will be able to exit"
 * is refused and "no sale priced at the reference size" is not, though the
 * second is the more negative statement.
 */
const OVERCLAIM_V1 =
  /\b(you (will|can) (be able to )?(sell|exit|get out|profit)|is (definitely|certainly) |will (definitely|certainly) |i recommend|you should (buy|sell|avoid))/i;

/**
 * Every number in a piece of text, normalised so that formatting cannot make
 * two equal figures look different.
 *
 * Thousands separators are dropped, trailing zeros after a decimal point are
 * dropped, and a leading `+` is ignored. `1,139` and `1139` are the same
 * number; `3.00` and `3` are the same number; `0.5` and `.5` are the same
 * number. A minus sign is KEPT — a negative cost is a different claim.
 */
export function numbersInV1(text: string): string[] {
  const found: string[] = [];
  // Russian writes thousands with a space: 49 929 328. Measured live
  // 2026-08-15, that arrived as three separate numbers — 49, 929, 328 — none
  // of which was in the evidence, so a correct Russian answer was rejected for
  // its punctuation. Only exact groups of three are joined, so "in 3 4 5"
  // stays three numbers rather than becoming 345.
  const normalised = text.replace(
    /(\d{1,3})((?:[\u0020\u00a0\u202f\u2009]\d{3})+)/g,
    (_whole, head: string, rest: string) => head + rest.replace(/[\u0020\u00a0\u202f\u2009]/g, ''),
  );
  for (const match of normalised.matchAll(/-?(?:\d[\d,]*)?\.?\d+/g)) {
    const raw = match[0].replace(/,/g, '');
    if (raw === '' || raw === '-' || raw === '.') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    // Canonical form via Number, which collapses 3.00 → 3 and .5 → 0.5. Large
    // atomic amounts lose precision as doubles, so those keep their digits.
    found.push(Math.abs(value) >= Number.MAX_SAFE_INTEGER ? raw : String(value));
  }
  return found;
}

/**
 * How many distinct figures a narrator is allowed to be trusted with.
 *
 * The check above is only as strong as the bundle is small. "Every number must
 * be in the evidence" refuses an invented figure because the allowed set is
 * ten or twenty values; hand it a bundle of two hundred and the same rule
 * starts accepting almost any two-digit number a model cares to write, while
 * still reporting itself as passing.
 *
 * Stage 07 is what forced this: a card carries one token's measurements, and a
 * global console can be asked about the whole universe. So the ceiling is on
 * the EVIDENCE, checked before the provider is called — a bundle this wide is
 * not narrated at all, and the reader gets the deterministic answer, which was
 * built from every one of those figures and states them exactly.
 *
 * Measured 2026-08-15 against the widest bundle each scope can produce:
 * card 8, explore with five named cards 15, investigate with five tokens 16,
 * changes with eight movers 11. The ceiling sits at roughly 2.5x the worst of
 * those — loose enough that adding a fact row never silently disables
 * narration, tight enough to fire long before the check has degraded into a
 * formality. It is a guard against a future bundle, not a limit on today's.
 */
export const B20_NARRATION_MAX_EVIDENCE_NUMBERS_V1 = 40;

export function b20NarrationEvidenceStrengthV1(evidence: readonly string[]): {
  distinctNumbers: number;
  strongEnough: boolean;
} {
  const distinct = new Set<string>();
  for (const item of evidence) {
    for (const value of numbersInV1(item)) distinct.add(value);
  }
  return {
    distinctNumbers: distinct.size,
    strongEnough: distinct.size <= B20_NARRATION_MAX_EVIDENCE_NUMBERS_V1,
  };
}

/**
 * Checks a narration against the evidence it was given.
 *
 * `evidence` is every string the bundle contains — labels, values, caveats.
 * Numbers are drawn from ALL of it rather than from a curated subset, because
 * a curated subset is a second place to get the bundle wrong.
 */
export function verifyB20NarrationV1(input: {
  narration: string;
  evidence: readonly string[];
}): B20NarrationVerdictV1 {
  const violations: string[] = [];
  const narration = stripNarrationFormattingV1(input.narration);

  if (narration.length === 0) {
    return { ok: false, violations: ['the narration is empty'], narration };
  }
  if (narration.length > B20_NARRATION_MAX_CHARS_V1) {
    violations.push(`the narration is ${narration.length} characters, over the ${B20_NARRATION_MAX_CHARS_V1} limit`);
  }

  const allowed = new Set<string>();
  for (const item of input.evidence) {
    for (const value of numbersInV1(item)) allowed.add(value);
  }
  const unsupported = [...new Set(numbersInV1(narration))].filter((value) => !allowed.has(value));
  if (unsupported.length > 0) {
    violations.push(`numbers not present in the evidence: ${unsupported.join(', ')}`);
  }

  const forbidden = FORBIDDEN_VOCABULARY_V1.exec(narration);
  if (forbidden) {
    violations.push(`recommendation or accusation vocabulary: "${forbidden[0]}"`);
  }

  const overclaim = OVERCLAIM_V1.exec(narration);
  if (overclaim) {
    violations.push(`claims an outcome the measurement cannot carry: "${overclaim[0].trim()}"`);
  }

  return { ok: violations.length === 0, violations, narration };
}
