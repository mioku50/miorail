import {
  B20_EXIT_STANDING_KINDS_V1,
  B20_PROJECT_FILTERS_V1,
  B20_STANDING_GROUPS_V1,
  type B20FundamentalPredicateV1,
} from '@mioagent/opportunity-rail';

import { b20UniverseIntentV1, b20UnsupportedRefusalV1 } from './b20AnswerPlan.js';

// ---------------------------------------------------------------------------
// Stage 07 — the global console's planner.
//
// Stage 06 answers about ONE card the reader is already looking at, so the
// subject is decided before a question is asked. A global console has no card,
// which means the question has to decide two things instead of one: what is
// being asked, and about what.
//
// The scope is the answer to the second. It is not a hint and it is not a
// ranking input — it selects which of four bounded reads may run, and each
// scope has a default read that is the honest answer to a question this
// planner did not recognise:
//
//   explore     the universe, counted            → summary
//   investigate one to five NAMED tokens         → cards
//   changes     the same token measured twice    → movers
//
// Everything Stage 06 established still holds and is deliberately not
// re-litigated here: a model never chooses a step, no step writes, no step
// takes a wallet, and every argument comes from this file.
// ---------------------------------------------------------------------------

export const B20_CONSOLE_SCOPES_V1 = ['explore', 'investigate', 'changes', 'portfolio'] as const;
export type B20ConsoleScopeV1 = (typeof B20_CONSOLE_SCOPES_V1)[number];

/**
 * The one scope whose subject belongs to the reader.
 *
 * Explore, Investigate and Changes are questions about a public corpus: every
 * figure in their answers is already published on a Discover card. Portfolio is
 * a question about which tokens a particular wallet is holding, and that list
 * is the reader's, not Miorail's.
 *
 * So this scope is answered deterministically and is never narrated. Narration
 * would send the bundle — the wallet's own token list — to a language provider
 * for a nicer sentence, and nobody agreed to that trade. It is enforced at the
 * route, and the reason is here so a later reader does not "enable" it.
 */
export function b20ScopeIsPrivateV1(scope: B20ConsoleScopeV1): boolean {
  return scope === 'portfolio';
}

export type B20ConsoleStepV1 =
  /** Counts across a launch-age window. Answers "how many", never "which". */
  | { tool: 'summary'; launchAgeHours: number }
  /** A bounded page of the feed, narrowed by the Stage 05 filters. */
  | {
      tool: 'list';
      limit: number;
      standing?: (typeof B20_STANDING_GROUPS_V1)[number];
      standingKind?: (typeof B20_EXIT_STANDING_KINDS_V1)[number];
      minBuyers?: number;
      bothRoutes?: boolean;
      /** Project context, a different axis from what was measured. */
      project?: (typeof B20_PROJECT_FILTERS_V1)[number];
    }
  /**
   * The CLAIMED corpus, matched on one fundamental predicate.
   *
   * A separate step from `list` and not a filter on it, because it reads a
   * different corpus. `list` pages the measured universe; this one starts from
   * the verified claims and only then looks for a launch row, which is what
   * lets a verified project be found before Discover has ingested its launch.
   * Folding it into `list` would put the measurement window between a reader
   * and an answer that has nothing to do with measurement.
   */
  | { tool: 'projects'; predicate: B20FundamentalPredicateV1; limit: number }
  /** The exact stored cards for named tokens, with bounded history. */
  | { tool: 'cards'; tokenAddresses: readonly string[]; historyLimit: number }
  /** The measured-movement rail: latest and ~24h baseline, already paired. */
  | { tool: 'changes'; limit: number }
  /** The same stored cards, read for a wallet's own holdings and ranked by
   * measured exit difficulty. Separate from `cards` because the ANSWER is
   * different — and because this step's arguments are the reader's position. */
  | { tool: 'positions'; tokenAddresses: readonly string[]; historyLimit: number };

export interface B20ConsolePlanV1 {
  /** The scope that actually answered. Not always the one the client asked
   * for — see `planB20ConsoleAnswerV1`. On the wire, so a surface can move its
   * own tab to where the answer came from rather than mislabelling it. */
  scope: B20ConsoleScopeV1;
  intent: B20ConsoleIntentV1;
  steps: B20ConsoleStepV1[];
  /** The addresses this plan is about, in the order they will be read. */
  tokenAddresses: string[];
  refusal: string | null;
}

export type B20ConsoleIntentV1 =
  | 'universe_counts'
  | 'find_verified_projects'
  | 'find_bought_not_sellable'
  | 'find_two_sided'
  | 'find_not_searched'
  | 'compare_tokens'
  | 'measured_changes'
  | 'rank_positions'
  | 'unsupported';

/** Five, because the comparison is read by a person. Past that a console is
 * printing a table nobody asked for, and each token is its own read. */
export const B20_CONSOLE_MAX_TOKENS_V1 = 5;

/** A wallet holds what it holds, so this is not a display limit — it is the
 * same bound the watchlist and the watch endpoint already use, because each
 * position is its own read. */
export const B20_CONSOLE_MAX_POSITIONS_V1 = 25;
const CARD_HISTORY_LIMIT_V1 = 12;
const LIST_LIMIT_V1 = 10;
const CHANGES_LIMIT_V1 = 10;
const DEFAULT_WINDOW_HOURS_V1 = 48;

/**
 * Addresses come from the reader's own words. Never from a model, and never
 * from a name.
 *
 * The same rule the token-by-address work settled: a symbol is not an
 * identifier on Base — several tokens answer to any given one — so a console
 * that resolved "the WORM one" to an address would be guessing which token the
 * reader meant and then measuring the guess.
 */
export function b20AddressesInV1(text: string): string[] {
  // Case-insensitive on the whole token, prefix included. A checksummed address
  // copied from a block explorer has a mixed-case BODY, which is the case that
  // matters — but a reader who upper-cases what they pasted has still named a
  // token, and refusing it would look like Miorail not knowing the address.
  const found = text.match(/0[xX][0-9a-fA-F]{40}/g) ?? [];
  return [...new Set(found.map((address) => address.toLowerCase()))];
}

function matchesV1(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

/**
 * Questions about PROJECT context rather than about a measurement.
 *
 * Kept narrow on purpose. "Which launches have a real project" is a question
 * this product can now answer; "which project is good" is not, and no pattern
 * here reaches for the second. Russian is first-class — the console has always
 * been asked in it, and `\b` is ASCII-only so Cyrillic patterns carry no word
 * boundary.
 */
const PROJECT_QUESTION_V1 = [
  /verified project/,
  /real project/,
  /project-backed/,
  /product-backed/,
  /connected to (a )?project/,
  /which .*(launch|token)s? .*(have|has|with) .*(project|product)/,
  // `\w` is ASCII-only even under the `u` flag, exactly as `\b` is — a
  // Cyrillic pattern written with it matches nothing and fails silently.
  // `\p{L}` is the one that works.
  /проверенн\p{L}* проект/u,
  /реальн\p{L}* проект/u,
  /есть .*проект/u,
  /связан\p{L}* с проект/u,
] as const;

/**
 * Questions that ask for the ABSENCE of a fundamental.
 *
 * Refused, and refused loudly rather than answered with an empty list. Miorail
 * probes only what a project itself declared, so it can show that a declared
 * product answered — and can never show that a project has none. "Which B20
 * have no product" would be answered from the same rows as "which have one",
 * and every launch outside the claimed corpus would arrive in the reader's
 * hands as a token that failed a check nobody ran.
 *
 * This is the same distinction the measurement layer already draws between a
 * finding and a gap, moved onto the fundamental corpus.
 */
const FUNDAMENTAL_ABSENCE_QUESTION_V1 = [
  /\b(no|without|missing|lacks?|lacking)\b[^?]{0,40}\b(product|website|site|repositor|github|docs|documentation|project)/,
  /\b(don'?t|do not|does ?n[o']t) have\b[^?]{0,40}\b(product|website|site|repositor|github|docs|documentation|project)/,
  /\b(product|website|site|repositor|github|docs|documentation|project)s?\b[^?]{0,30}\b(is |are )?(missing|absent|unverified|not verified)/,
  /без (продукт|сайт|репозитор|проект|документац|github)/u,
  /(нет|отсутству\p{L}*) (продукт|сайт|репозитор|проект|документац|github)/u,
  /у котор\p{L}* нет/u,
  /не проверен\p{L}* (сайт|продукт|проект)/u,
] as const;

/**
 * The predicate a question asks for, in priority order.
 *
 * Ordered, first match wins, and the order is load-bearing: the generic
 * project patterns below would swallow "which launches have a live product",
 * so every specific predicate is tried before them. Russian is first-class
 * throughout — the console is asked in it, and these patterns are written with
 * `\p{L}` for the same reason the ones above are.
 */
const FUNDAMENTAL_PREDICATE_QUESTION_V1: readonly {
  predicate: B20FundamentalPredicateV1;
  patterns: readonly RegExp[];
}[] = [
  {
    predicate: 'live_product',
    patterns: [
      /live product/,
      /working product/,
      /real product/,
      /product that (works|runs)/,
      /product is (live|running)/,
      /which .*(launch|token|b20)\S* .*(have|has|with) .*product/,
      /работающ\p{L}* продукт/u,
      /рабочи\p{L}* продукт/u,
      /живо\p{L}* продукт/u,
      /реальн\p{L}* продукт/u,
      /есть .*продукт/u,
      /с продуктом/u,
    ],
  },
  {
    predicate: 'verified_website',
    patterns: [
      /verified (web ?)?site/,
      /confirmed (web ?)?site/,
      /(web ?)?site is verified/,
      /which .*(launch|token|b20)\S* .*(have|has|with) .*(web ?)?site/,
      /проверенн\p{L}* (веб-?)?сайт/u,
      /подтвержд\p{L}* (веб-?)?сайт/u,
      /есть .*сайт/u,
      /с сайтом/u,
    ],
  },
  {
    predicate: 'development_active',
    patterns: [
      /active(ly)? (development|developed|maintained)/,
      /still (being )?(built|developed|maintained)/,
      /development is active/,
      /активн\p{L}* (разработ|развива)/u,
      /разработка (идет|идёт|активна|ведется|ведётся)/u,
      /продолжа\p{L}* разрабат/u,
      /кто (еще|ещё) разрабат/u,
    ],
  },
  {
    predicate: 'project_before_token',
    patterns: [
      /before (its|the|their) (token|launch)/,
      /existed before/,
      /predates? (its|the) (token|launch)/,
      /pre-?dates/,
      /до (запуска )?токена/u,
      /существовал\p{L}* до/u,
      /раньше (своего )?токена/u,
      /старше токена/u,
    ],
  },
  {
    predicate: 'repository_found',
    patterns: [
      /repositor(y|ies)/,
      /github/,
      /open ?source/,
      /source code/,
      /репозитор/u,
      /исходн\p{L}* код/u,
      /открыт\p{L}* код/u,
    ],
  },
  {
    predicate: 'docs_found',
    patterns: [/documentation/, /\bdocs\b/, /документац/u, /с документац/u],
  },
  {
    predicate: 'verified_base_presence',
    patterns: [
      /base presence/,
      /present on base/,
      /(deployed|live) on base/,
      /on base mainnet/,
      /присутстви\p{L}* на base/u,
      /есть .*на base/u,
      /развернут\p{L}* на base/u,
    ],
  },
  { predicate: 'verified_project', patterns: PROJECT_QUESTION_V1 },
];

function fundamentalPredicateV1(value: string): B20FundamentalPredicateV1 | null {
  for (const entry of FUNDAMENTAL_PREDICATE_QUESTION_V1) {
    if (matchesV1(value, entry.patterns)) return entry.predicate;
  }
  return null;
}

/** Questions that are about movement in time however they are scoped. */
const CHANGE_QUESTION_V1 = [
  /what changed/,
  /\bmoved?\b/,
  /\bmovers?\b/,
  /since (yesterday|the last|previous)/,
  /over (the last|24)/,
  /что (из)?менил/u,
  /движени/u,
  /за сутки/u,
  /за последние/u,
] as const;

/**
 * Reads a question and a scope into a plan.
 *
 * Two rules decide the scope, and both are about not surprising the reader:
 *
 *   An address in the question always wins. Somebody who pastes a token
 *   address wants that token, whichever tab they happen to have open, and the
 *   plan says so in `scope` rather than quietly answering something else.
 *
 *   Otherwise the requested scope holds. A question the planner does not
 *   recognise gets that scope's default read — the counts, the tokens named,
 *   the measured moves — rather than being refused for not matching a pattern.
 */
export function planB20ConsoleAnswerV1(input: {
  question: string;
  scope: B20ConsoleScopeV1;
  /** Tokens the reader selected in the interface. Merged with any address in
   * the question text; the union is capped and deduplicated. */
  tokenAddresses?: readonly string[];
}): B20ConsolePlanV1 {
  const question = input.question.trim();
  const value = question.toLowerCase();

  const refusal = b20UnsupportedRefusalV1(question);
  if (refusal) {
    return { scope: input.scope, intent: 'unsupported', steps: [], tokenAddresses: [], refusal };
  }

  const named = b20AddressesInV1(question);
  const selected = (input.tokenAddresses ?? []).map((address) => address.toLowerCase());

  // An address in the question moves the answer to the token, whatever tab is
  // open. The scope on the plan then reports where the answer actually came
  // from — a surface that showed "Explore" above a token answer would be
  // labelling it wrongly.
  const scope: B20ConsoleScopeV1 = named.length > 0 ? 'investigate' : input.scope;

  // Portfolio's bound is not a display limit: a wallet holds what it holds, and
  // the cap is the same one the watch endpoint already applies because each
  // position is its own read.
  const tokenAddresses = [...new Set([...named, ...selected])].slice(
    0,
    scope === 'portfolio' ? B20_CONSOLE_MAX_POSITIONS_V1 : B20_CONSOLE_MAX_TOKENS_V1,
  );

  if (scope === 'portfolio') {
    if (tokenAddresses.length === 0) {
      return {
        scope,
        intent: 'unsupported',
        steps: [],
        tokenAddresses: [],
        refusal:
          'Portfolio ranks the B20 tokens this wallet holds. Miorail does not enumerate a wallet — connect one and open the B20 tab so the tokens are read there first.',
      };
    }
    return {
      scope,
      intent: 'rank_positions',
      steps: [{ tool: 'positions', tokenAddresses, historyLimit: CARD_HISTORY_LIMIT_V1 }],
      tokenAddresses,
      refusal: null,
    };
  }

  if (scope === 'investigate') {
    if (tokenAddresses.length === 0) {
      return {
        scope,
        intent: 'unsupported',
        steps: [],
        tokenAddresses: [],
        refusal:
          'Investigate answers about named tokens. Paste one or more Base token addresses, or open a card from Discover — Miorail will not guess which token a symbol means.',
      };
    }
    return {
      scope,
      intent: 'compare_tokens',
      steps: [{ tool: 'cards', tokenAddresses, historyLimit: CARD_HISTORY_LIMIT_V1 }],
      tokenAddresses,
      refusal: null,
    };
  }

  if (scope === 'changes') {
    return {
      scope,
      intent: 'measured_changes',
      steps: [{ tool: 'changes', limit: CHANGES_LIMIT_V1 }],
      tokenAddresses: [],
      refusal: null,
    };
  }

  // Explore. A question about movement is answered by the movers read even
  // from this tab: the counts cannot see time, and answering "what changed"
  // with a snapshot would be answering a different question.
  if (matchesV1(value, CHANGE_QUESTION_V1)) {
    return {
      scope: 'changes',
      intent: 'measured_changes',
      steps: [{ tool: 'changes', limit: CHANGES_LIMIT_V1 }],
      tokenAddresses: [],
      refusal: null,
    };
  }

  // A question for the ABSENCE of a fundamental is refused before it can be
  // answered from the same rows as its positive twin. Checked first, so that
  // "which B20 have no product" cannot fall through to the product predicate
  // and come back as a list of the ones that do.
  if (matchesV1(value, FUNDAMENTAL_ABSENCE_QUESTION_V1)) {
    return {
      scope,
      intent: 'unsupported',
      steps: [],
      tokenAddresses: [],
      refusal:
        'Miorail cannot answer which projects lack something. It probes only what a project itself published, so it can show that a declared product answered a request — never that a project has none. Ask for what a project HAS (a live product, a verified website, a repository), and everything outside that answer stays unknown rather than becoming a negative finding.',
    };
  }

  // A question about project context is answered from the CLAIMED corpus, not
  // from the measurement window. The counts cannot see a claim, and a launch
  // universe cannot be the denominator for a question none of it was asked.
  const predicate = fundamentalPredicateV1(value);
  if (predicate) {
    return {
      scope,
      intent: 'find_verified_projects',
      // One step, and deliberately no `summary`. A fundamental answer that
      // opened with 3,000 launches read would be quoting a number about a
      // different corpus, which is the shape of answer this console exists to
      // stop producing.
      steps: [{ tool: 'projects', predicate, limit: LIST_LIMIT_V1 }],
      tokenAddresses: [],
      refusal: null,
    };
  }

  // The same reading of a universe question the card console uses. One matcher,
  // because two drifted the first time they existed.
  const universe = b20UniverseIntentV1(value);
  return {
    scope,
    intent: universe.intent === 'count_universe' ? 'universe_counts' : universe.intent,
    steps: [
      { tool: 'summary', launchAgeHours: DEFAULT_WINDOW_HOURS_V1 },
      ...(universe.list ? [{ tool: 'list' as const, limit: LIST_LIMIT_V1, ...universe.list }] : []),
    ],
    tokenAddresses: [],
    refusal: null,
  };
}
