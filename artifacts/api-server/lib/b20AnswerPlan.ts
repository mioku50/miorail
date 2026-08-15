import { B20_EXIT_STANDING_KINDS_V1, B20_STANDING_GROUPS_V1 } from '@mioagent/opportunity-rail';

// ---------------------------------------------------------------------------
// The planner: which reads a question is allowed to cause.
//
// A model never chooses this. The plan is produced by a pure function from the
// question text, and the ONLY calls it can emit are the four below — each one
// a bounded read that already exists and is already guarded. There is no step
// that writes, no step that takes a wallet, and no step whose arguments come
// from anything but this file.
//
// That is not caution about today's model. It is the property that makes the
// rest of the pipeline reviewable: whatever a narrator does with the evidence,
// the set of things that could have been read to build it is fixed, small, and
// visible here.
//
// The alternative — letting a model emit tool calls — is how a read-only
// surface acquires an argument nobody validated. This server also answers to
// x402 buyers, so a plan is a spend as well as a read.
// ---------------------------------------------------------------------------

export type B20PlanStepV1 =
  /** The exact stored card for one token, plus its observation history. */
  | { tool: 'card'; tokenAddress: string; historyLimit: number }
  /** Counts across a launch-age window. Answers "how many", never "which". */
  | { tool: 'summary'; launchAgeHours: number }
  /** A bounded page of the feed, narrowed by the filters Stage 05 added. */
  | {
      tool: 'list';
      limit: number;
      standing?: (typeof B20_STANDING_GROUPS_V1)[number];
      standingKind?: (typeof B20_EXIT_STANDING_KINDS_V1)[number];
      minBuyers?: number;
      bothRoutes?: boolean;
    };

export interface B20AnswerPlanV1 {
  /** What the question was read as. Recorded so a wrong answer can be traced
   * to a wrong reading rather than blamed on the narrator. */
  intent: B20AnswerIntentV1;
  steps: B20PlanStepV1[];
  /** Present when the question asks for something this product does not
   * measure. The pipeline then answers with the refusal and reads nothing. */
  refusal: string | null;
}

export type B20AnswerIntentV1 =
  | 'card'
  | 'count_universe'
  | 'find_bought_not_sellable'
  | 'find_two_sided'
  | 'find_not_searched'
  | 'unsupported';

const HISTORY_LIMIT_V1 = 12;
const LIST_LIMIT_V1 = 10;
const DEFAULT_WINDOW_HOURS_V1 = 48;

function matchesV1(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

/**
 * Every pattern present, in any order.
 *
 * Russian puts the negation where English puts it least: «купили, а продать
 * нельзя» is verb-object-negation, and a single ordered regex written from the
 * English phrasing matches nothing. A conjunction is order-free and reads as
 * what it is — three ideas that must all be in the sentence.
 */
function allOfV1(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.every((pattern) => pattern.test(value));
}

/**
 * Questions this product will not answer, refused BEFORE any read.
 *
 * Not a safety filter — a scope one. Miorail measures exit conditions at a
 * moment. It does not measure price, intent, identity or the future, and a
 * pipeline that read evidence first and then declined would burn a metered
 * call to say so. Russian is first-class here: the console is used in it.
 */
export const B20_UNSUPPORTED_QUESTIONS_V1: readonly { patterns: readonly RegExp[]; refusal: string }[] = [
  {
    patterns: [/\bprice\b.*\b(predict|forecast|will|target)/i, /\bmoon\b/i, /прогноз/iu, /предскаж/iu, /вырастет/iu],
    refusal: 'Miorail does not measure price or predict it. It measures what it cost to get in and out of a pool at one block.',
  },
  {
    patterns: [/\bshould i (buy|sell|ape|invest)/i, /\bis it (a )?(good|bad) (buy|investment)/i, /стоит ли (покупать|брать)/iu],
    refusal: 'Miorail does not recommend buying or selling anything. It reports measurements, and the decision is not one it can take for you.',
  },
  {
    patterns: [/\bwho (is|are) (the )?(dev|team|owner|founder)/i, /\bsniper/i, /\binsider/i, /кто (стоит|владелец|разработ)/iu],
    refusal: 'Miorail does not identify wallets, teams or intent. It counts unique buying wallets inside a completed launch window and nothing about who they are.',
  },
  {
    patterns: [/\brug\b/i, /\bscam\b/i, /\bhoneypot\b/i, /скам/iu, /обман/iu],
    refusal: 'Miorail does not label tokens as scams. It measures whether a sale priced, and a sale that did not price has several causes — most of them are not fraud.',
  },
];

/**
 * The refusal a question earns, or null.
 *
 * Shared by both planners on purpose. "Is it a scam" is out of scope whether it
 * is asked about one card or about the whole universe, and a scope that answered
 * it would be the only place in the product where it is answerable.
 */
export function b20UnsupportedRefusalV1(question: string): string | null {
  for (const rule of B20_UNSUPPORTED_QUESTIONS_V1) {
    if (matchesV1(question, rule.patterns)) return rule.refusal;
  }
  return null;
}

/**
 * Reads a question into a plan.
 *
 * The order matters and is the same reasoning as everywhere else in this rail:
 * refuse what is out of scope first, then answer about a NAMED token if there
 * is one, then treat the question as being about the universe. A question with
 * a token in front of it is almost always about that token.
 */
export function planB20AnswerV1(input: {
  question: string;
  /** Set when the question arrived attached to a card. */
  tokenAddress: string | null;
}): B20AnswerPlanV1 {
  const question = input.question.trim();
  const value = question.toLowerCase();

  const unsupported = b20UnsupportedRefusalV1(question);
  if (unsupported) return { intent: 'unsupported', steps: [], refusal: unsupported };

  if (input.tokenAddress) {
    return {
      intent: 'card',
      steps: [{ tool: 'card', tokenAddress: input.tokenAddress, historyLimit: HISTORY_LIMIT_V1 }],
      refusal: null,
    };
  }

  const universe = b20UniverseIntentV1(value);
  return {
    intent: universe.intent,
    steps: [
      { tool: 'summary', launchAgeHours: DEFAULT_WINDOW_HOURS_V1 },
      ...(universe.list ? [{ tool: 'list' as const, limit: LIST_LIMIT_V1, ...universe.list }] : []),
    ],
    refusal: null,
  };
}

/**
 * What a question about the WHOLE universe is asking for.
 *
 * Shared by both planners, and shared because the copies drifted the moment
 * there were two: this matcher missed "buy but cannot sell" — the most natural
 * English phrasing of the product's own headline finding — and fixing it in one
 * file would have left the other console answering the same sentence with the
 * counts.
 *
 * `value` must already be lowercased. `\b` is ASCII-only, so the Russian
 * patterns carry no word boundaries — a Cyrillic regex written with `\b`
 * matches nothing, silently.
 */
export function b20UniverseIntentV1(value: string): {
  intent: 'count_universe' | 'find_bought_not_sellable' | 'find_two_sided' | 'find_not_searched';
  /** The narrowing to apply to the feed page, when the intent names one. */
  list: { standingKind?: (typeof B20_EXIT_STANDING_KINDS_V1)[number]; bothRoutes?: boolean } | null;
} {
  // "How many" is the question Stage 05 exists for, and the one that used to
  // cost 46 pages.
  if (matchesV1(value, [/how many/, /how much of/, /count/, /breakdown/, /сколько/u, /распределен/u, /статистик/u])) {
    return { intent: 'count_universe', list: null };
  }

  // The product's own finding, asked for in words. The summary comes with it
  // so the answer can say how many there are as well as naming a few.
  const boughtNotSellable =
    matchesV1(value, [
      /(bought|buy|bought into|got in).*(not|can.?t|cannot|could not|unable).*(sell|sold|sell out|exit|get out)/,
      /trapped/,
      /stuck/,
      /не выйти/u,
    ])
    || allOfV1(value, [/купил/u, /(продать|продаж|выйти)/u, /(нельзя|невозможно|не\s|без)/u]);
  if (boughtNotSellable) {
    return { intent: 'find_bought_not_sellable', list: { standingKind: 'bought_not_sellable' } };
  }

  if (matchesV1(value, [/both (directions|routes|legs)/, /round trip/, /priced both/, /оба маршрута/u, /туда и обратно/u])) {
    return { intent: 'find_two_sided', list: { bothRoutes: true } };
  }

  if (matchesV1(value, [/not (searched|looked)/, /never looked/, /coverage/, /не искал/u, /не смотрел/u, /покрыти/u])) {
    return { intent: 'find_not_searched', list: { standingKind: 'venue_not_searched' } };
  }

  // Anything else about the universe gets the counts. They are cheap, cached,
  // and they are the honest answer to a question this planner did not
  // recognise: here is the shape of what Miorail has measured.
  return { intent: 'count_universe', list: null };
}
