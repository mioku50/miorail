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
 * Questions this product will not answer, refused BEFORE any read.
 *
 * Not a safety filter — a scope one. Miorail measures exit conditions at a
 * moment. It does not measure price, intent, identity or the future, and a
 * pipeline that read evidence first and then declined would burn a metered
 * call to say so. Russian is first-class here: the console is used in it.
 */
/**
 * Is this question written in Russian?
 *
 * One Cyrillic letter is enough: a question is asked in one language, and the
 * alternative — a bilingual reader typing an English word inside a Russian
 * sentence — still wants the Russian answer.
 */
export function questionIsRussianV1(asked: string): boolean {
  return /[\u0400-\u04FF]/.test(asked);
}

export const B20_UNSUPPORTED_QUESTIONS_V1: readonly {
  patterns: readonly RegExp[];
  refusal: string;
  /** The same refusal in Russian. The patterns above have always been
   * bilingual — every rule carries a Cyrillic alternative — but the refusals
   * were English only, so a Russian question was correctly identified as out
   * of scope and then answered in the wrong language. */
  refusalRu: string;
}[] = [
  {
    patterns: [/\bprice\b.*\b(predict|forecast|will|target)/i, /\bmoon\b/i, /прогноз/iu, /предскаж/iu, /вырастет/iu],
    refusal: 'Miorail does not measure price or predict it. It measures what it cost to get in and out of a pool at one block.',
    refusalRu:
      'Miorail не измеряет цену и не предсказывает её. Он измеряет, во сколько обошёлся вход в пул и выход из него на одном блоке.',
  },
  {
    patterns: [/\bshould i (buy|sell|ape|invest)/i, /\bis it (a )?(good|bad) (buy|investment)/i, /стоит ли (покупать|брать)/iu],
    refusal: 'Miorail does not recommend buying or selling anything. It reports measurements, and the decision is not one it can take for you.',
    refusalRu:
      'Miorail ничего не советует покупать или продавать. Он сообщает измерения, а решение — не то, что он может принять за вас.',
  },
  {
    patterns: [/\bwho (is|are) (the )?(dev|team|owner|founder)/i, /\bsniper/i, /\binsider/i, /кто (стоит|владелец|разработ)/iu],
    // Names what Miorail DOES have, because a refusal that understates its own
    // capabilities is a false statement in the other direction. Stage 09 reads
    // the launch transaction's sender; that is an address, and only when it
    // called the factory directly does it establish even that much.
    refusal:
      'Miorail does not identify people, teams or intent. It can show which address sent the launch transaction — and only when that address called the B20 factory directly, because a relayed launch names a bundler instead — and it counts unique buying wallets inside a completed launch window. Neither of those is a person.',
    refusalRu:
      'Miorail не устанавливает людей, команды и намерения. Он может показать, какой адрес отправил транзакцию запуска — и только если этот адрес вызвал фабрику B20 напрямую, потому что при запуске через релей в транзакции стоит бандлер, — и он считает уникальные кошельки, купившие внутри завершённого окна запуска. Ни то, ни другое не является человеком.',
  },
  {
    patterns: [/\brug\b/i, /\bscam\b/i, /\bhoneypot\b/i, /скам/iu, /обман/iu],
    refusal: 'Miorail does not label tokens as scams. It measures whether a sale priced, and a sale that did not price has several causes — most of them are not fraud.',
    refusalRu:
      'Miorail не помечает токены как скам. Он измеряет, оценилась ли продажа, а у неоценившейся продажи есть несколько причин — большинство из них не мошенничество.',
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
  const russian = questionIsRussianV1(question);
  for (const rule of B20_UNSUPPORTED_QUESTIONS_V1) {
    if (matchesV1(question, rule.patterns)) return russian ? rule.refusalRu : rule.refusal;
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
 * The three word groups a "bought but could not sell" question is built from.
 *
 * Written as three sets rather than as one ordered sentence, and that IS the
 * fix. The original pattern read `bought .* not .* sell`, which is one English
 * word order out of many: "were bought but a sale could not be priced" puts the
 * sale BEFORE the negation and matched nothing, so the product's own headline
 * finding — asked in the most natural phrasing there is — came back as the
 * universe counts. Measured in production 2026-08-19.
 *
 * A conjunction cannot have that bug. It says what the question actually is:
 * an entry word, an exit word, and a negation, in any order, in any of the two
 * languages this console is used in.
 */
// Deliberately without a bare `in`: it appears in almost every English
// sentence, and an entry word that is always present turns the conjunction
// below into a two-word rule.
const ENTRY_WORD_V1 = /\b(bought|buy|buys|buying|purchase[ds]?|got in|entry|entered|enter|entering)\b|(купи|покуп|приобре|вошл|вход|заход|зашл|зашёл|зашел)/u;
const EXIT_WORD_V1 = /\b(sell|sells|selling|sold|sale|sales|exit|exits|exiting|get out|got out|cash out|unload|dump)\b|(прода|выход|выйти|выйд|вышел|сбро)/u;
/**
 * Words that turn a question about entry and exit into a question about a
 * failure. Required by the bought-not-sellable matcher, and disqualifying for
 * the two-sided one, so a missing form silently sends a question to the
 * opposite intent.
 *
 * `не мо[гж]` was the missing one, and `невозможно` was written as one
 * inflection rather than a stem, so «невозможна» read as no negation at all. On prod «Какие запуски купили, но НЕ МОГУТ
 * продать?» classified as find_two_sided three runs out of three, while «…но
 * продать НЕ СМОГЛИ?» — one verb over, and `не смог` was listed — classified
 * correctly. The reader got a well-formed, verified answer to the opposite
 * question, with nothing on screen to say so.
 */
const NEGATION_WORD_V1 = /\b(not|cannot|can'?t|could ?n'?t|could not|would ?n'?t|would not|did ?n'?t|did not|does ?n'?t|does not|is ?n'?t|are ?n'?t|no|none|never|unable|without|fail|failed|fails|unpriced|impossible|stuck|trapped)\b|(нельзя|невозможн|не смог|не удал|не получ|не мо[гж]|не выйд|не продад|нет|без|застрял)/u;

/**
 * Whether the question asks for the product's headline finding.
 *
 * The negation is REQUIRED, and that requirement is what keeps this apart from
 * the two-sided question below: "both entry and exit were priced" carries an
 * entry word and an exit word and must not be answered with the tokens that
 * could not be sold.
 */
function boughtNotSellableQuestionV1(value: string): boolean {
  if (matchesV1(value, [/trapped/, /\bstuck\b/, /не выйти/u, /can.?t get out/, /one.?way/])) return true;
  return (
    ENTRY_WORD_V1.test(value) && EXIT_WORD_V1.test(value) && NEGATION_WORD_V1.test(value)
  );
}

/**
 * Whether the question asks which launches priced in BOTH directions.
 *
 * "both directions" and "round trip" are Miorail's own words for it, and a
 * reader has no way to know that. The general form is an entry word and an exit
 * word with no negation and something that joins them — which is how anyone
 * would phrase it who had never read the schema.
 */
function twoSidedQuestionV1(value: string): boolean {
  if (NEGATION_WORD_V1.test(value)) return false;
  if (
    matchesV1(value, [
      /both (directions|routes|legs|sides|ways|priced)/,
      /round.?trip/,
      /priced both/,
      /two.?sided/,
      /in and out/,
      /оба маршрута/u,
      /обе стороны/u,
      /туда и обратно/u,
      /и вход и выход/u,
    ])
  ) {
    return true;
  }
  // "where both entry and exit were priced", "which ones can be bought and
  // sold" — a join word and both legs, with no negation. The negation check at
  // the top of this function is what makes that safe: without it, "bought and
  // could not be sold" carries the same three parts.
  return (
    /\b(both|and|as well as)\b|(и |оба|обе)/u.test(value) &&
    ENTRY_WORD_V1.test(value) &&
    EXIT_WORD_V1.test(value)
  );
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
 * matches nothing, silently, which is why every Cyrillic alternative below is
 * written without one.
 */
export function b20UniverseIntentV1(value: string): {
  intent: 'count_universe' | 'find_bought_not_sellable' | 'find_two_sided' | 'find_not_searched';
  /** The narrowing to apply to the feed page, when the intent names one. */
  list: { standingKind?: (typeof B20_EXIT_STANDING_KINDS_V1)[number]; bothRoutes?: boolean } | null;
} {
  // The NAMED findings are read before "how many", and the order is the fix
  // rather than an accident of it. "How many tokens were bought but cannot be
  // sold" is a question about the finding that happens to open with a counting
  // word, and the finding answer leads with the count anyway — so nothing is
  // lost by preferring it, and a question that names the product's own
  // headline result is no longer answered with a table of section totals.
  if (boughtNotSellableQuestionV1(value)) {
    return { intent: 'find_bought_not_sellable', list: { standingKind: 'bought_not_sellable' } };
  }

  if (twoSidedQuestionV1(value)) {
    return { intent: 'find_two_sided', list: { bothRoutes: true } };
  }

  if (matchesV1(value, [/not (searched|looked)/, /never looked/, /coverage/, /не искал/u, /не смотрел/u, /покрыти/u])) {
    return { intent: 'find_not_searched', list: { standingKind: 'venue_not_searched' } };
  }

  // "How many" is the question Stage 05 exists for, and the one that used to
  // cost 46 pages.
  if (matchesV1(value, [/how many/, /how much of/, /count/, /breakdown/, /сколько/u, /распределен/u, /статистик/u])) {
    return { intent: 'count_universe', list: null };
  }

  // Anything else about the universe gets the counts. They are cheap, cached,
  // and they are the honest answer to a question this planner did not
  // recognise: here is the shape of what Miorail has measured.
  return { intent: 'count_universe', list: null };
}
