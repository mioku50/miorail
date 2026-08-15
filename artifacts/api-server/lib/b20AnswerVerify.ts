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
// Over-rejection is safe: a rejected narration falls back to the deterministic
// answer, which is what shipped before any of this existed. Under-rejection is
// not. So the rules are strict on purpose, and the tests below the fold pin
// exactly which paraphrases are refused.
// ---------------------------------------------------------------------------

export interface B20NarrationVerdictV1 {
  ok: boolean;
  /** Human-readable, one per rule broken. Logged, never shown to a user —
   * the user gets the deterministic answer instead. */
  violations: string[];
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
  for (const match of text.matchAll(/-?(?:\d[\d,]*)?\.?\d+/g)) {
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
  const narration = input.narration.trim();

  if (narration.length === 0) {
    return { ok: false, violations: ['the narration is empty'] };
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

  return { ok: violations.length === 0, violations };
}
