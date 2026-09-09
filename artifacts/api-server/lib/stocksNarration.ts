import type { LlmProvider } from '@mioagent/llm';

import {
  numbersInV1,
  stripNarrationFormattingV1,
  verifyB20NarrationV1,
} from './b20AnswerVerify.js';
import {
  STOCKS_EXPLANATION_MAX_CHARS_V1,
  StocksNarrationV1Schema,
  type StocksAnswerSourceV1,
  type StocksNarrationV1,
} from '@mioagent/rwa-market-reality/narration-contract';
import {
  stocksBundleEvidenceStringsV1,
  type StocksEvidenceBundleV1,
  type StocksEvidenceItemV1,
} from './stocksEvidence.js';

// ---------------------------------------------------------------------------
// The Stocks answer contract, and what a model is allowed to have said in it.
//
// One narrator, one verifier, one fallback — the pipeline B20 already runs.
// Two things are new, and both are forced by the shape of the evidence rather
// than by taste:
//
//   1. THE ANSWER IS A STRUCTURE, NOT A PARAGRAPH. A Stocks answer separates
//      what is established from what is not, and a paragraph lets those two
//      blur into each other under a paraphrase. The reader of a security that
//      Base carries three ways needs to see the line.
//
//   2. A CLAIM CITES THE EVIDENCE IT STANDS ON. The failure this shape invites
//      is a sentence about Backed's token built from Coinbase's reference
//      price: fluent, specific, and about two different things at once. With a
//      citation the check is mechanical — the cited row either belongs to the
//      representation the claim names or it does not.
//
// Everything else is the existing verifier, called once on the flattened text:
// every number must be in the bundle, no recommendation or accusation
// vocabulary, no claimed outcome, and the meaning of the deterministic answer
// must survive. A narration that fails any rule is discarded for the
// deterministic answer, which is built from the same bundle and states it
// exactly.
// ---------------------------------------------------------------------------

/** Flattened-text ceiling. The prose field carries its own, smaller cap: that
 * is where a model that starts explaining the product runs long. */
export const STOCKS_NARRATION_MAX_CHARS_V1 = 4_000;
// The answer shape is the wire contract, shared with the screen that renders
// it. Only the rules live here.
export {
  STOCKS_EXPLANATION_MAX_CHARS_V1,
  StocksNarrationClaimV1Schema,
  StocksNarrationV1Schema,
  type StocksNarrationClaimV1,
  type StocksNarrationV1,
} from '@mioagent/rwa-market-reality/narration-contract';

export interface StocksNarrationViolationV1 {
  /** Stable machine code, so a benchmark can count rejection classes. */
  code: StocksNarrationViolationCodeV1;
  detail: string;
}

export const STOCKS_NARRATION_VIOLATION_CODES_V1 = [
  'not_the_answer_contract',
  'unsupported_number',
  'forbidden_vocabulary',
  'overclaim',
  'meaning_changed',
  'over_length',
  'unknown_subject',
  'subject_as_established_claim',
  'unknown_source_id',
  'claim_number_not_in_cited_evidence',
  'claim_cites_another_representation',
  'judgement_vocabulary',
  'universal_market_claim',
  'provider_failure_unattributed',
  'expired_quote_as_current',
  'zero_supply_as_dead',
  'invented_issuer',
  'invented_venue',
  'absences_not_stated',
  'absence_invented',
] as const;
export type StocksNarrationViolationCodeV1 = (typeof STOCKS_NARRATION_VIOLATION_CODES_V1)[number];

export interface StocksNarrationVerdictV1 {
  ok: boolean;
  violations: StocksNarrationViolationV1[];
  /** The narration as it would be SHOWN — formatting stripped from every text
   * field, so a caller cannot verify one answer and display another. */
  narration: StocksNarrationV1 | null;
  /** Which evidence item supports each material statement. Empty when the
   * answer never parsed. */
  support: Array<{ claim: string; items: StocksEvidenceItemV1[] }>;
}

// ---------------------------------------------------------------------------
// Stocks-specific refusals. Each one is a sentence that reads as a measurement
// and is not one.
// ---------------------------------------------------------------------------

/** Judgements. The product measures an exit at a size; none of these are
 * measurements, and "liquid" is the one that sounds most like one. */
const JUDGEMENT_VOCABULARY_V1 =
  /\b(illiquid|liquid|liquidity is (good|bad|poor|deep|thin|low|high)|best|worst|bad|cheap|expensive|attractive|favou?rable|superior|inferior)\b|(ликвид|лучш|худш|плох|дешев|дорог|выгодн)/iu;

/**
 * A claim about the whole market drawn from one router's answer. Miorail asks
 * a reviewed router set at an exact size; that is never every venue.
 *
 * Two alternations were removed after the benchmark, because they matched the
 * product's own vocabulary rather than an overclaim:
 *
 *   "no market"   also matched "no market OUTCOME is established", which is
 *                 the name of a coverage field and the correct sentence.
 *   "any router"  also matched "any router quote is a price at one block",
 *                 which is the caveat this rule exists to protect.
 *
 * Both refused answers that were saying exactly the right thing. The rule is
 * about REACH — traded anywhere, no liquidity at all — so reach is what it
 * matches now.
 */
const UNIVERSAL_MARKET_CLAIM_V1 =
  /\b(anywhere|any (venue|dex|exchange)|every (venue|dex|exchange|router)|all (venues|exchanges|routers)|no market(?!\s+outcome)|cannot be (traded|sold|bought)|un(tradeable|tradable)|not tradable|no liquidity)\b|(нигде|ни на одной|нельзя (продать|купить)|нет ликвидности)/iu;

/** Zero outstanding supply is a denominator, not an obituary. */
const ZERO_SUPPLY_AS_DEAD_V1 =
  /\b(dead|delisted|defunct|worthless|no longer exists|discontinued|retired|abandoned|rug)\b|(мертв|делистинг|больше не существует|обесценен)/iu;

/** A read of ours that did not complete, told as a property of the token. */
const ASSET_BLAMED_V1 =
  /\b(the (token|asset|representation)|it) (is|was|has been) (broken|down|failing|offline|unavailable)\b|(токен|актив) (сломан|недоступен|не работает)/iu;

/**
 * Present-tense freshness, in two strengths.
 *
 * The first names a cost outright and is wrong on its own. The second is a
 * bare adverb, which is only wrong beside a figure: "there is currently no
 * outstanding supply" is a true sentence about a denominator and says nothing
 * about a quote. The first version of this rule refused it, which is an
 * over-rejection with a cost — it fired on three of the ten fixtures for
 * sentences that never mentioned a price.
 */
const CURRENT_COST_CLAIM_V1 = /\b(now costs|current (price|cost)|today it costs)\b|(сейчас стоит|текущая цена)/iu;
const CURRENT_ADVERB_V1 =
  /\b(currently|right now|at this moment|as of now)\b|(сейчас|в данный момент|на текущий момент)/iu;
/** What makes a bare adverb a claim about a quote. */
const PRICE_TOKEN_V1 = /\d|\bUSDC\b|\b(costs?|price|priced|returns?|spends?)\b|(цен|стои)/iu;

/** Vocabulary that marks a figure as history rather than a live price. */
const FRESHNESS_QUALIFIER_V1 =
  /\b(expired|stale|no longer open|as of|last (measured|observed|observation)|minutes ago|hours ago|history|historical|earlier)\b|(истёк|истек|устарел|минут назад|назад|по состоянию на)/iu;

/** The one reused semantic violation the structured contract answers better.
 * Matched by its message, which is the shared verifier's own wording. */
const EMPTIED_ANSWER_RULE_V1 = /^the deterministic answer matched \d+ and the narration reports none$/;

/** How an answer attributes a gap to Miorail. */
const ATTRIBUTION_V1 = /miorail|миорейл/iu;

const KNOWN_ISSUERS_V1 = ['coinbase', 'dinari', 'backed'] as const;

/** Venues a narration could plausibly name. Only used to catch a venue the
 * bundle never asked — never to authorise one. */
const KNOWN_VENUES_V1 = [
  'kyberswap',
  'uniswap',
  'aerodrome',
  'odos',
  'paraswap',
  '1inch',
  'openocean',
  'sushiswap',
  'curve',
  'balancer',
  'pancakeswap',
  'baseswap',
  'matcha',
] as const;

/** Removes exact identifiers before counting figures.
 *
 * An address is 40 hex characters and reads to a number scanner as several
 * large integers. They are identity, not measurement, and holding a claim to
 * "every digit run in this address appears in the row I cited" would reject
 * correct answers for naming the thing they are about. */
export function withoutExactIdentifiersV1(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{40,64}/g, ' ').replace(TRUNCATED_IDENTIFIER_V1, ' ');
}

/**
 * An address a narration shortened for prose: `0xb200…`, `0x7e81...`.
 *
 * Read by a number scanner these are the integers 200 and 81, neither of which
 * is in any bundle — so an answer was refused for abbreviating the address it
 * had already given in full in its claims. They are identity, not measurement.
 *
 * Only the TRUNCATED form is removed. A full address stays in the text, because
 * the reused semantic rule that asks whether an answer named its subjects looks
 * for exactly that string.
 */
const TRUNCATED_IDENTIFIER_V1 = /0x[0-9a-fA-F]{1,39}(?:\u2026|\.{3})/g;

/**
 * Parses a provider reply into the answer contract.
 *
 * Code fences are stripped rather than rejected: a JSON object wrapped in
 * ```json is the same answer, and falling back to the deterministic sentence
 * over a formatting habit is the wrong trade — the same call the B20 narrator
 * makes about bold markers.
 */
export function parseStocksNarrationV1(raw: string): StocksNarrationV1 | null {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = StocksNarrationV1Schema.safeParse(parsed);
  if (!result.success) return null;
  return {
    ...result.data,
    established: result.data.established.map((entry) => ({
      ...entry,
      claim: stripNarrationFormattingV1(entry.claim),
    })),
    notEstablished: result.data.notEstablished.map((entry) => stripNarrationFormattingV1(entry)),
    explanation: stripNarrationFormattingV1(result.data.explanation),
  };
}

/** Case, punctuation and spacing removed, so a quoted sentence can be
 * recognised as the one the bundle asked for. */
export function normaliseSentenceV1(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** One claim, absence or sentence at a time.
 *
 * Rules about how a figure is QUALIFIED have to run at this scale. A rule that
 * asks whether the qualifier appears anywhere in the answer is satisfied by an
 * unrelated line, which is how "it currently costs" survived beside "the quote
 * expired 48 minutes ago". */
export function sentencesV1(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Every text field, as one string, for the rules that are about prose.
 *
 * Explanation FIRST, because the prose field is the answer and the claims are
 * the evidence under it. That is the order the reused rules were written for.
 */
export function flattenStocksNarrationV1(narration: StocksNarrationV1): string {
  return [
    narration.explanation,
    ...narration.established.map((entry) => entry.claim),
    ...narration.notEstablished,
  ].join('\n');
}

/**
 * Holds a narration to the bundle it was built from.
 *
 * The reused verifier runs first and carries four of the rules; everything
 * after it is a rule the older surface never needed, because the older surface
 * answered about one token at a time.
 */
export function verifyStocksNarrationV1(input: {
  raw: string;
  bundle: StocksEvidenceBundleV1;
}): StocksNarrationVerdictV1 {
  const narration = parseStocksNarrationV1(input.raw);
  if (!narration) {
    return {
      ok: false,
      violations: [
        {
          code: 'not_the_answer_contract',
          detail: 'the reply is not a JSON object matching the Stocks answer contract',
        },
      ],
      narration: null,
      support: [],
    };
  }

  const { bundle } = input;
  const violations: StocksNarrationViolationV1[] = [];
  const text = flattenStocksNarrationV1(narration);
  const evidence = stocksBundleEvidenceStringsV1(bundle);

  // ---- the existing verifier, unchanged -----------------------------------
  const reused = verifyB20NarrationV1({
    // Truncated identifiers removed, full addresses kept: the reused semantic
    // rule about naming subjects matches on the exact address string.
    narration: text.replace(TRUNCATED_IDENTIFIER_V1, ' '),
    evidence,
    assertions: bundle.assertions,
    maxChars: STOCKS_NARRATION_MAX_CHARS_V1,
  });
  for (const detail of reused.violations) {
    // One reused rule does not survive the change of contract. It asks whether
    // an answer OPENS by saying none of them matched — a sound question about a
    // paragraph, and the wrong one here, because a Stocks answer legitimately
    // opens "No reviewed router returned a route at this exact size." and then
    // names the representation it is about.
    //
    // The structured contract answers that question in a field instead of by
    // inspecting prose: an answer carrying subjects is not claiming the result
    // was empty, and `subjects` is separately checked against the bundle above.
    // So the rule is suppressed only when the narration names a subject, and
    // every other reused rule is untouched.
    if (EMPTIED_ANSWER_RULE_V1.test(detail) && narration.subjects.length > 0) continue;
    violations.push({ code: reusedCodeV1(detail), detail });
  }

  // ---- subjects ------------------------------------------------------------
  const knownSubjects = new Set(bundle.subjects.map((subject) => subject.tokenAddress.toLowerCase()));
  for (const subject of narration.subjects) {
    if (!knownSubjects.has(subject.trim().toLowerCase())) {
      violations.push({
        code: 'unknown_subject',
        detail: `the answer is about ${subject}, which is not a reviewed representation in the bundle`,
      });
    }
  }

  // ---- citations -----------------------------------------------------------
  const byId = new Map(bundle.items.map((item) => [item.id, item]));
  const questionRows = bundle.items.filter((item) => item.kind === 'question');
  const cited = new Set<string>();
  const support: Array<{ claim: string; items: StocksEvidenceItemV1[] }> = [];

  for (const entry of narration.established) {
    const items: StocksEvidenceItemV1[] = [];
    for (const id of entry.sourceIds) {
      cited.add(id);
      const item = byId.get(id);
      if (!item) {
        violations.push({
          code: 'unknown_source_id',
          detail: `"${entry.claim}" cites ${id}, which is not in the bundle`,
        });
        continue;
      }
      items.push(item);
    }
    support.push({ claim: entry.claim, items });
    if (items.length === 0) continue;

    // A representation's identity is who it is. It is a subject of the answer,
    // never one of the answer's findings.
    if (items.every((item) => item.kind === 'identity')) {
      violations.push({
        code: 'subject_as_established_claim',
        detail: `"${entry.claim}" stands only on identity rows — a representation is a subject, not an established fact`,
      });
    }

    const allowed = new Set<string>();
    // The question's own figures are ambient: the size, the chain and the
    // destination are what every claim is ABOUT, not findings a claim has to
    // cite separately. Without this, "kyberswap returned no_route at the exact
    // size of 1000 USDC" was refused for naming the size it was asked about.
    for (const item of questionRows) {
      for (const value of numbersInV1(withoutExactIdentifiersV1(`${item.label} ${item.value}`))) {
        allowed.add(value);
      }
    }
    for (const item of items) {
      for (const value of numbersInV1(withoutExactIdentifiersV1(`${item.label} ${item.value}`))) {
        allowed.add(value);
      }
    }
    const unsupported = [...new Set(numbersInV1(withoutExactIdentifiersV1(entry.claim)))].filter(
      (value) => !allowed.has(value),
    );
    if (unsupported.length > 0) {
      violations.push({
        code: 'claim_number_not_in_cited_evidence',
        detail: `"${entry.claim}" states ${unsupported.join(', ')}, which the rows it cites do not carry`,
      });
    }

    // Cross-representation borrowing: the claim names one representation and
    // stands on another's row.
    const mentioned = bundle.subjects
      .map((subject) => subject.tokenAddress.toLowerCase())
      .filter((address) => entry.claim.toLowerCase().includes(address));
    const citedSubjects = [
      ...new Set(items.map((item) => item.subject).filter((value): value is string => value !== null)),
    ].map((value) => value.toLowerCase());
    if (mentioned.length === 1 && citedSubjects.length > 0 && !citedSubjects.includes(mentioned[0]!)) {
      violations.push({
        code: 'claim_cites_another_representation',
        detail: `"${entry.claim}" is about ${mentioned[0]} and stands on evidence for ${citedSubjects.join(', ')}`,
      });
    }
  }

  // `sources` is derived, so it is repaired rather than refused.
  //
  // It used to have to equal the citations exactly, and a narration that got
  // every fact right was discarded for listing one id its claims did not cite.
  // That protected no reader: the claims carry the citations, and this field
  // is their union. A bookkeeping slip in a derived field is not a false
  // statement about a market, and the only rejections worth spending are the
  // ones that are.
  const declared = new Set(narration.sources);
  for (const id of [...declared].filter((entry) => !byId.has(entry))) {
    violations.push({ code: 'unknown_source_id', detail: `sources names ${id}, which is not in the bundle` });
  }
  narration.sources = [...cited];

  // ---- absences ------------------------------------------------------------
  if (bundle.missing.length > 0 && narration.notEstablished.length === 0) {
    violations.push({
      code: 'absences_not_stated',
      detail: `the bundle names ${bundle.missing.length} thing(s) Miorail could not establish and the answer states none of them`,
    });
  }
  if (bundle.missing.length === 0 && narration.notEstablished.length > 0) {
    violations.push({
      code: 'absence_invented',
      detail: 'the bundle names no absence and the answer states one',
    });
  }

  // ---- prose rules ---------------------------------------------------------
  // A sentence the bundle told the narrator to preserve cannot also be a
  // violation of the rule it states. The benchmark refused
  // "no representation carries open evidence, so nothing here may be stated as
  // a current cost" — my own caveat, quoted back verbatim, on the fixtures
  // that caveat exists for. Roughly a hundred of the rejections were that.
  const quotedCaveats = new Set(bundle.caveats.map(normaliseSentenceV1));
  const isQuotedCaveat = (sentence: string): boolean => quotedCaveats.has(normaliseSentenceV1(sentence));

  const judgement = JUDGEMENT_VOCABULARY_V1.exec(text);
  if (judgement) {
    violations.push({ code: 'judgement_vocabulary', detail: `a judgement, not a measurement: "${judgement[0]}"` });
  }

  for (const sentence of sentencesV1(text)) {
    if (isQuotedCaveat(sentence)) continue;
    const universal = UNIVERSAL_MARKET_CLAIM_V1.exec(sentence);
    if (universal) {
      violations.push({
        code: 'universal_market_claim',
        detail: `a reviewed router set at one size is not every venue: "${universal[0]}"`,
      });
      break;
    }
  }

  const dead = ZERO_SUPPLY_AS_DEAD_V1.exec(text);
  if (dead) {
    violations.push({
      code: 'zero_supply_as_dead',
      detail: `no supply reading establishes this: "${dead[0]}"`,
    });
  }

  const providerFailures = bundle.items.filter((item) => item.kind === 'provider_failure');
  if (providerFailures.length > 0) {
    if (!ATTRIBUTION_V1.test(text)) {
      violations.push({
        code: 'provider_failure_unattributed',
        detail: 'a read of Miorail’s did not complete and the answer does not say whose gap it is',
      });
    }
    const blamed = ASSET_BLAMED_V1.exec(text);
    if (blamed) {
      violations.push({
        code: 'provider_failure_unattributed',
        detail: `a failed read reported as a property of the asset: "${blamed[0]}"`,
      });
    }
  }

  if (!bundle.hasOpenEvidence) {
    // Sentence by sentence, not over the whole answer. A qualifier three
    // claims away does not qualify anything: the first version of this rule
    // passed "it currently costs 1000 USDC" because some other line in the
    // same answer happened to contain the word "expired".
    for (const sentence of sentencesV1(text)) {
      if (isQuotedCaveat(sentence)) continue;
      // You cannot misstate a price without stating one.
      //
      // The exemption above only recognises the caveat quoted verbatim, and
      // models paraphrase it — "nothing here is a current cost" against the
      // bundle's "nothing here may be stated as a current cost". Those
      // paraphrases say exactly what the rule wants said, and were refused for
      // saying it in their own words: 87 of the rejections in the second run.
      //
      // A figure in the sentence is what separates the two, and it is the
      // rule's actual subject. A sentence with no number cannot describe an
      // expired quote as current, whichever way it is phrased.
      if (numbersInV1(withoutExactIdentifiersV1(sentence)).length === 0) continue;
      const claimsNow =
        CURRENT_COST_CLAIM_V1.test(sentence) ||
        (CURRENT_ADVERB_V1.test(sentence) && PRICE_TOKEN_V1.test(sentence));
      if (claimsNow && !FRESHNESS_QUALIFIER_V1.test(sentence)) {
        violations.push({
          code: 'expired_quote_as_current',
          detail: `no representation carries open evidence and this states a present-tense cost: "${sentence.trim()}"`,
        });
      }
    }
  }

  // ---- invented actors -----------------------------------------------------
  const bundleIssuers = new Set(bundle.subjects.map((subject) => subject.issuerId));
  for (const issuer of KNOWN_ISSUERS_V1) {
    if (bundleIssuers.has(issuer)) continue;
    // "backed by" is ordinary English and not a claim about the issuer.
    const pattern = issuer === 'backed' ? /\bbacked\b(?!\s+by)/i : new RegExp(`\\b${issuer}\\b`, 'i');
    if (pattern.test(text)) {
      violations.push({
        code: 'invented_issuer',
        detail: `${issuer} carries no representation in this bundle`,
      });
    }
  }
  // A venue is permitted when a router by that name was asked, OR when the
  // chain named it as holding a pool of one of these tokens. Both are things
  // Miorail measured; neither authorises the other's claim, and the caveat the
  // bundle carries keeps a pool from being narrated as a price.
  //
  // Substring, not equality: a pool venue arrives as the name the chain
  // established — "Aerodrome CL", "Uniswap v3" — and an equality test against
  // the bare word would have refused an answer for naming the exchange whose
  // pool the bundle had just handed it.
  const bundleVenues = [...bundle.approvedSources, ...bundle.pooledVenues]
    .map((source) => source.toLowerCase())
    .join(' ');
  for (const venue of KNOWN_VENUES_V1) {
    if (bundleVenues.includes(venue)) continue;
    if (new RegExp(`\\b${venue.replace('1inch', '1inch')}\\b`, 'i').test(text)) {
      violations.push({
        code: 'invented_venue',
        detail: `${venue} was not asked for this question`,
      });
    }
  }

  return { ok: violations.length === 0, violations, narration, support };
}

function reusedCodeV1(detail: string): StocksNarrationViolationCodeV1 {
  if (detail.startsWith('numbers not present')) return 'unsupported_number';
  if (detail.startsWith('recommendation or accusation vocabulary')) return 'forbidden_vocabulary';
  if (detail.startsWith('claims an outcome')) return 'overclaim';
  if (detail.includes('over the') && detail.includes('limit')) return 'over_length';
  if (detail === 'the narration is empty') return 'not_the_answer_contract';
  return 'meaning_changed';
}

// ---------------------------------------------------------------------------
// The deterministic answer, in the same contract.
//
// Not a fallback bolted on afterwards: it is the answer, and a narration only
// replaces it by passing every rule above. Returning it in the same shape means
// a surface renders one structure whatever happened to the provider, and
// `answerSource` says which one the reader got.
// ---------------------------------------------------------------------------

export function deterministicStocksNarrationV1(bundle: StocksEvidenceBundleV1): StocksNarrationV1 {
  const claimable = bundle.items.filter(
    (item) => item.kind !== 'identity' && item.kind !== 'question',
  );
  const established = claimable.slice(0, 24).map((item) => ({
    claim: `${item.label}: ${item.value}`,
    sourceIds: [item.id],
  }));
  return {
    subjects: bundle.subjects.map((subject) => subject.tokenAddress),
    established,
    notEstablished: bundle.missing.slice(0, 24).map((entry) => `Miorail has not established ${entry}.`),
    explanation:
      `Every reviewed representation listed here was read for the exact question in the bundle. ` +
      `What Miorail could not establish is stated beside what it did.`,
    sources: established.flatMap((entry) => entry.sourceIds),
  };
}

export interface StocksNarratedAnswerV1 {
  answer: StocksNarrationV1;
  answerSource: StocksAnswerSourceV1;
  /** Why the narration was not used, when it was not. Operator-facing. */
  rejectedBecause: StocksNarrationViolationV1[] | null;
  /** How the provider failed, when it did. A name, never a cause — a provider
   * error carries a base URL and a base URL carries a key. */
  providerError: string | null;
  /** Wall time of the provider call, or null when none was made. */
  latencyMs: number | null;
}

/**
 * The instruction the narrator gets.
 *
 * Constraints rather than a persona, because a persona is not checkable and
 * every line here has a rule behind it in the verifier above.
 */
export const STOCKS_NARRATOR_SYSTEM_V1 = `You are the narrator for Miorail Stocks. Miorail measures what it costs to enter or exit one exact position, at one exact size, through a reviewed set of routers, on Base. You are given a bundle of already-measured evidence and you write one answer from it.

You reply with a single JSON object and nothing else:

{
  "subjects": ["0x… exact token address", …],
  "established": [{ "claim": "…", "sourceIds": ["e3"] }, …],
  "notEstablished": ["…", …],
  "explanation": "…",
  "sources": ["e3", …]
}

Rules, all enforced automatically after you answer:

1. "subjects" holds the exact token addresses the answer is about, copied from the bundle. Never a ticker, never a company name.
2. Every "established" entry is a factual claim the bundle contains, with "sourceIds" naming the evidence rows it stands on. A claim about one representation may only cite that representation's rows. Never cite one representation's evidence for another.
3. Do not put a representation's identity — who issued it, what structure it is — under "established". That is a subject, not a finding.
4. Use ONLY numbers that appear verbatim in the rows you cite. Do not round, convert, sum, average or derive.
5. "notEstablished" holds only the things the bundle lists as not established. Never invent an absence, and never state one as a zero.
6. "sources" is exactly the set of ids your claims cite — no more, no less.
7. Never judge. No "liquid", "illiquid", "safe", "best", "bad", "cheap", "expensive", "scam". Miorail measures exit conditions; none of those are measurements.
8. Never claim an outcome. A quote is a price offered at one block, not a promise a trade will fill.
9. A reviewed router set at one size is not every venue. Never say a token cannot be traded anywhere, or has no liquidity.
10. Zero outstanding supply means there is no position to size. It never means dead, delisted or worthless.
11. When a read of Miorail's did not complete, say it is Miorail's gap. Never report it as a property of the token.
12. An expired quote is history. Say when it was measured; never state it as a current cost.
13. A pool holding a token is not a route. A [pool] row says where the token sits and how concentrated it is; it never says what an exit costs, and a pool venue was never asked for a price.
14. Answer in the language of the question. Keep "explanation" under ${STOCKS_EXPLANATION_MAX_CHARS_V1} characters.

Write only the JSON object. No preamble, no code fence, no commentary.`;

export function bundleAsPromptV1(bundle: StocksEvidenceBundleV1): string {
  const lines: string[] = [`QUESTION: ${bundle.question}`, '', 'EVIDENCE ROWS:'];
  for (const item of bundle.items) {
    lines.push(`- ${item.id} [${item.kind}${item.subject ? ` ${item.subject}` : ''}] ${item.label}: ${item.value}`);
  }
  if (bundle.missing.length > 0) {
    lines.push('', 'NOT ESTABLISHED (state these as absences, never as zero):');
    for (const entry of bundle.missing) lines.push(`- ${entry}`);
  }
  lines.push('', 'MUST SURVIVE ANY PARAPHRASE:');
  for (const entry of bundle.caveats) lines.push(`- ${entry}`);
  lines.push(
    '',
    `ROUTERS ASKED: ${bundle.approvedSources.join(', ') || 'none'}`,
    `POOL VENUES READ: ${bundle.pooledVenues.join(', ') || 'none'}`,
    `OPEN EVIDENCE: ${bundle.hasOpenEvidence ? 'yes' : 'no'}`,
  );
  return lines.join('\n');
}

/**
 * Narrates a Stocks bundle, or explains why the deterministic answer was kept.
 *
 * The provider is handed a system prompt, a user prompt and nothing else — no
 * tools, no functions, no wallet, no read it could take on its own. That is the
 * permission boundary, and it is a property of this call rather than of the
 * prompt inside it.
 */
export async function narrateStocksAnswerV1(input: {
  bundle: StocksEvidenceBundleV1;
  provider: LlmProvider | null;
  timeoutMs?: number;
}): Promise<StocksNarratedAnswerV1> {
  const deterministic = deterministicStocksNarrationV1(input.bundle);
  const keep = (
    rejectedBecause: StocksNarrationViolationV1[] | null,
    providerError: string | null,
    latencyMs: number | null,
  ): StocksNarratedAnswerV1 => ({
    answer: deterministic,
    answerSource: 'deterministic_evidence',
    rejectedBecause,
    providerError,
    latencyMs,
  });

  if (!input.provider) return keep(null, 'no language provider is configured', null);

  const started = Date.now();
  let raw: string;
  try {
    const response = await Promise.race([
      input.provider.generate({
        messages: [
          { role: 'system', content: STOCKS_NARRATOR_SYSTEM_V1 },
          { role: 'user', content: bundleAsPromptV1(input.bundle) },
        ],
        // Zero: this is transcription with grammar, and variety is the defect.
        temperature: 0,
        // And for the same reason, no thinking. Every claim this call may make
        // is already in the bundle above it; there is nothing here to reason
        // about. Measured against this exact prompt on deepseek-v4-flash:
        // 120.5s with thinking, 6.7s without.
        reasoningEffort: 'none',
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('narrator timed out')), input.timeoutMs ?? 30_000),
      ),
    ]);
    raw = (response.message.content ?? '').trim();
  } catch (error) {
    return keep(null, error instanceof Error ? error.message : 'unknown', Date.now() - started);
  }
  const latencyMs = Date.now() - started;

  const verdict = verifyStocksNarrationV1({ raw, bundle: input.bundle });
  if (!verdict.ok || !verdict.narration) return keep(verdict.violations, null, latencyMs);

  return {
    answer: verdict.narration,
    answerSource: 'verified_narration',
    rejectedBecause: null,
    providerError: null,
    latencyMs,
  };
}
