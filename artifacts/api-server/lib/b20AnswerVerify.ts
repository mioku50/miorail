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
//   4. THE MEANING OF THE DETERMINISTIC ANSWER MUST SURVIVE. Rules 1–3 are
//      about the tokens on the page and are all blind to a narration that is
//      fluent, figure-free and simply says the opposite of its evidence —
//      which is the failure production produced. See the semantic section
//      below the fold.
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
  // A comma is a thousands separator in English and a DECIMAL POINT in
  // Russian, and this console is used in both. Stripping every comma read
  // "0,1784511" as the integer 1784511 and "178,45" as 17845 — neither of
  // which is in any bundle, so a correct Russian narration was refused for
  // its punctuation. (The same defect as the thousands-space fix above, on
  // the other separator.)
  //
  // The disambiguation is the group size: exactly three digits after a comma
  // is a thousands separator, anything else is a decimal fraction. "1,139"
  // stays 1139; "0,1784511" becomes 0.1784511; "178,45" becomes 178.45. A
  // three-digit Russian fraction is genuinely ambiguous and keeps the English
  // reading, which is the one this corpus has always used.
  const decimalised = normalised.replace(/(\d),(\d{1,2}|\d{4,})\b/g, '$1.$2');
  for (const match of decimalised.matchAll(/-?(?:\d[\d,]*)?\.?\d+/g)) {
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


// ---------------------------------------------------------------------------
// The semantic check: what the narration was allowed to have MEANT.
//
// The three rules above are about tokens on the page — figures, vocabulary,
// claims of certainty. They are blind to the one failure production actually
// produced: asked "how many B20 launches were measured in the last 48 hours",
// with a bundle stating 3,000 launches read and five section counts, the
// narrator answered "Not measured." Every number rule passed, because there
// were no numbers. No forbidden word appeared. No outcome was claimed. The
// answer was simply the opposite of the evidence it was built from.
//
// So the deterministic answer now travels with a small set of assertions about
// its own MEANING, and a narration has to preserve them. This is deliberately
// not a second language model judging the first: every rule below is a
// mechanical check against a structure the deterministic builder already knew,
// and a narration that fails one is discarded for the answer that shipped
// before any model was involved.
//
// The principle, stated once: THE DETERMINISTIC ANSWER OWNS THE VERDICT. A
// narrator may explain it, shorten it, or translate it. It may not change what
// state it is in.
// ---------------------------------------------------------------------------

export interface B20AnswerAssertionsV1 {
  /**
   * What the deterministic answer concluded about evidence.
   *
   * `measured` — the read produced findings, whatever they were. A zero match
   * is still `measured`: "no launch was bought and then failed to price a
   * sale" is a result, not an absence of one.
   * `not_measured` — the read found nothing stored to report.
   * `mixed` — some subjects carry a measurement and some do not.
   */
  state: 'measured' | 'not_measured' | 'mixed';
  /** How many subjects the answer is about. Zero is a real, sayable answer. */
  matched: number;
  /** Whether the read behind the answer covered everything it was asked
   * about. False for a scan that hit its cap. */
  complete: boolean;
  /** Why an incomplete answer is incomplete. A bounded universe scan needs a
   * ceiling qualifier; a targeted token read needs attribution to Miorail
   * instead. Keeping those states separate prevents the scan-cap verifier
   * from demanding the word "cap" in a token-level timeout. */
  incompleteReason?: 'scan_cap' | 'targeted_read';
  /** The subjects the answer named, in the order it named them. */
  subjects: readonly string[];
  /** Whose the leading finding is. `miorail` when the answer is about a
   * reading that did not complete rather than about any token. */
  about: 'token' | 'miorail' | 'mixed';
}

/**
 * A narration claiming nothing was measured.
 *
 * Matched anywhere, not only at the start: the observed failure was a
 * two-word answer, but the same replacement inside a longer paraphrase is the
 * same defect. Both languages, because both are used here.
 */
const NOT_MEASURED_CLAIM_V1 =
  /\b(not measured|no measurement|nothing (was )?measured|no (?:stored |exit[- ]first )?measurements?|has not been measured|hasn'?t been measured|no data)\b|(не измер|нет измерен|измерений нет|ничего не измер|нет данных|данных нет)/iu;

/** A narration claiming the answer is empty. */
const EMPTY_CLAIM_V1 =
  /^\s*(no|none|nothing|zero)\b|\bnone (of them|of the|were|are|matched|found)\b|\bnothing (was )?found\b|(^\s*(нет|ничего|ни один)|ничего не найден|не найден)/iu;

/** Words that mark a figure as a ceiling rather than a total. */
const SCAN_CAP_VOCABULARY_V1 =
  /\b(cap|capped|ceiling|limit|limited|newest|most recent|not the total|does not establish|partial|prefix)\b|(предел|лимит|ограничен|новейш|последн|не (все|общ)|не устанавлива)/iu;

/** The brand, which is how an answer attributes a gap to Miorail. Latin in
 * both languages, because that is how it is written in both. */
const ATTRIBUTION_V1 = /miorail|миорейл/iu;

/**
 * Checks a narration against what the deterministic answer MEANT.
 *
 * Returns the violations, empty when the narration preserved every assertion.
 * Separate from `verifyB20NarrationV1` so each can be read and tested on its
 * own, and called by it so no caller can run one without the other.
 */
export function verifyB20NarrationSemanticsV1(input: {
  narration: string;
  assertions: B20AnswerAssertionsV1;
}): string[] {
  const { narration, assertions } = input;
  const violations: string[] = [];

  // S1 — the failure this whole section exists for.
  if (assertions.state === 'measured' && NOT_MEASURED_CLAIM_V1.test(narration)) {
    violations.push(
      'the deterministic answer reports stored measurement findings and the narration says nothing was measured',
    );
  }

  // S2 — an ENUMERATION must still name one of the things it enumerated. A
  // "which tokens" question answered with section totals has silently become a
  // different answer.
  //
  // Two or more, deliberately. An answer about a single subject is read beside
  // that subject — the card copilot's whole context is one card on screen — and
  // requiring the symbol back in the sentence there would reject correct
  // paraphrases for saying "this token" like a person would.
  if (assertions.subjects.length >= 2) {
    const lowered = narration.toLowerCase();
    const named = assertions.subjects.some((subject) => lowered.includes(subject.toLowerCase()));
    if (!named) {
      violations.push(
        `the deterministic answer names ${assertions.subjects.length} subject(s) and the narration names none of them`,
      );
    }
  }

  // S3 — a non-empty result reported as empty.
  if (assertions.matched > 0 && EMPTY_CLAIM_V1.test(narration.trim())) {
    violations.push(`the deterministic answer matched ${assertions.matched} and the narration reports none`);
  }

  // S4 — a ceiling reported as a total. Only when the narration actually
  // quotes a figure: a narration that states no count cannot misstate one.
  if (
    !assertions.complete &&
    assertions.incompleteReason !== 'targeted_read' &&
    numbersInV1(narration).length > 0 &&
    !SCAN_CAP_VOCABULARY_V1.test(narration)
  ) {
    violations.push('the scan did not complete and the narration quotes a count without saying it is a ceiling');
  }

  // S5 — a gap of Miorail's, reported without saying whose it is. The same
  // rule the standing layer enforces on the card, applied to the sentence.
  if (assertions.about === 'miorail' && !ATTRIBUTION_V1.test(narration)) {
    violations.push('the finding is about Miorail\u2019s own reading and the narration does not attribute it');
  }

  return violations;
}

/**
 * Checks a narration against the evidence it was given.
 *
 * `evidence` is every string the bundle contains — labels, values, caveats.
 * Numbers are drawn from ALL of it rather than from a curated subset, because
 * a curated subset is a second place to get the bundle wrong.
 *
 * `assertions` is what the deterministic answer MEANT. Optional only because
 * one caller predates it; when present, a narration that changed the meaning
 * is refused however well-formed its numbers are.
 */
export function verifyB20NarrationV1(input: {
  narration: string;
  evidence: readonly string[];
  assertions?: B20AnswerAssertionsV1;
  /**
   * Length ceiling, when the caller's answer contract is not one sentence.
   *
   * Added for the Stocks bundle, whose answer is a structured object with a
   * claim per measurement rather than a paragraph — flattening it for these
   * rules produces a longer string, and the ceiling's real job (a model that
   * starts explaining the product) is done there by a cap on the prose field.
   * Every other rule is unchanged, which is the point of passing a number
   * rather than writing a second verifier.
   */
  maxChars?: number;
}): B20NarrationVerdictV1 {
  const violations: string[] = [];
  const narration = stripNarrationFormattingV1(input.narration);

  if (narration.length === 0) {
    return { ok: false, violations: ['the narration is empty'], narration };
  }
  const maxChars = input.maxChars ?? B20_NARRATION_MAX_CHARS_V1;
  if (narration.length > maxChars) {
    violations.push(`the narration is ${narration.length} characters, over the ${maxChars} limit`);
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

  if (input.assertions) {
    violations.push(...verifyB20NarrationSemanticsV1({ narration, assertions: input.assertions }));
  }

  return { ok: violations.length === 0, violations, narration };
}
