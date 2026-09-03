import type { MarketRealityResponseV2 } from './contracts.js';

// ---------------------------------------------------------------------------
// Connected Intelligence 1 — Miorail's own reading of its own comparison.
//
// `market-reality/v2` is an excellent machine contract and a poor answer to a
// person. `establishedOutcomeCount: 0` is precise, and an external model asked
// to turn it into English will reach for "NVIDIA has no liquidity" — which is a
// claim about a market, from a field that describes OUR coverage.
//
// So the interpretation is written here, deterministically, from the same
// response. No model, no new facts, no arithmetic the comparison did not
// already do: every sentence below is a rearrangement of counts that are
// already in the payload. An assistant that repeats `summary` verbatim says
// something Miorail is willing to stand behind; one that improvises from the
// raw counts is on its own, and now has less reason to.
//
// It is deliberately NOT a recommendation. `nextSafeStep` names an action the
// evidence supports, never a representation to prefer.
// ---------------------------------------------------------------------------

export interface MarketRealityAgentSummaryV1 {
  /** Two or three sentences a person can be told, as they are. */
  summary: string;
  /**
   * Whether the representations can be read against each other RIGHT NOW.
   *
   * False is the ordinary state: a router quote lives about twenty seconds.
   * False means "no current comparison", never "no market".
   */
  currentComparisonAvailable: boolean;
  /** What the evidence supports doing next. Never which one to choose. */
  nextSafeStep: string;
  /** One line per reviewed representation, address first. */
  representations: {
    tokenAddress: string;
    issuerId: string;
    line: string;
    inCurrentComparison: boolean;
  }[];
  /** The sentence an assistant must not produce, said once so it can be shown
   * to a reader who asks why there is no verdict. */
  notEstablished: string;
}

const ISSUER_LABEL_V1: Readonly<Record<string, string>> = {
  coinbase: 'Coinbase',
  backed: 'Backed',
  dinari: 'Dinari',
};

const KIND_LABEL_V1: Readonly<Record<string, string>> = {
  b20_asset: 'B20 asset',
  rebasing_erc20: 'rebasing ERC-20',
  non_rebasing_erc4626_wrapper: 'ERC-4626 wrapper',
  dinari_dshare: 'Dinari dShare',
};

function moneyV1(atomic: string, decimals = 6): string {
  const digits = atomic.padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${whole}`;
}

function pluralV1(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * How long ago, in words, measured against when the comparison was assembled.
 *
 * Never against wall-clock now: the summary is a reading of one response, and
 * an age taken from a different clock would drift from the payload it
 * describes.
 */
function agoV1(observedAt: string, assembledAt: string): string | null {
  const then = Date.parse(observedAt);
  const now = Date.parse(assembledAt);
  if (!Number.isFinite(then) || !Number.isFinite(now) || now < then) return null;
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 90) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** What the last look found, in the words a person would use for it. */
const LAST_LOOK_LABEL_V1: Readonly<Record<string, string>> = {
  quoted: 'priced',
  no_route: 'no route',
  unsized: 'could not be sized',
  measurement_failed: 'measurement failed',
};

/**
 * Miorail's reading of one comparison.
 *
 * Reads only counts and per-representation state that the response already
 * carries. It never quotes a cash figure: an agent-facing summary that named a
 * price would put the number back into conversational prose, which is the one
 * place Miorail cannot keep it honest.
 */
export function marketRealityAgentSummaryV1(
  response: MarketRealityResponseV2,
): MarketRealityAgentSummaryV1 {
  const universe = response.universe;
  const coverage = response.marketOutcomeCoverage;
  const size = moneyV1(response.question.requestedCashAtomic, response.question.cashDecimals);
  const question = `${size} ${response.question.direction.toUpperCase()} → ${response.question.destination}`;

  const zero = universe.zeroSupplyRepresentationCount;
  const unresolved = universe.unresolvedSupplyRepresentationCount;
  const positive = universe.positiveSupplyRepresentationCount;
  const answered = coverage.establishedOutcomeCount;
  const eligible = coverage.eligibleRepresentationCount;
  const currentComparisonAvailable = eligible > 0 && answered === eligible;

  const first = `Miorail reviewed ${pluralV1(universe.reviewedRepresentationCount, 'representation', 'representations')} on Base. ${pluralV1(positive, 'has', 'have')} positive supply${
    zero > 0 ? `; ${pluralV1(zero, 'has', 'have')} zero observed supply` : ''
  }${unresolved > 0 ? `; supply is unresolved for ${unresolved}` : ''}.`;

  // The second sentence is the one an external model would otherwise invent.
  const second =
    eligible === 0
      ? `No representation is currently eligible for a market comparison at ${question}, so there is nothing to compare.`
      : currentComparisonAvailable
        ? `Miorail has a current market answer for all ${eligible} at ${question}.`
        : // "either" takes a singular noun, so the plural suffix belongs only to
          // the counted branch. The first version read "either active
          // representations" in production.
          `Miorail does not currently hold a fresh established market answer for ${
            answered === 0 && eligible === 2
              ? 'either active representation'
              : answered === 0
                ? `any of the ${eligible} active representations`
                : `${eligible - answered} of ${eligible} active representation${
                    eligible - answered === 1 ? '' : 's'
                  }`
          } at ${question}, so there is nothing reliable to compare right now.`;

  // The third sentence — and the reason the second one is not the whole answer.
  //
  // "No fresh answer for any of the 4" is true and nearly contentless: it is
  // equally what a market that just priced two minutes ago and a market nobody
  // has ever reached look like from here. The response already carries what the
  // last look found, per representation, and a reader who is told only about
  // freshness cannot tell those apart. So the durable reading is stated too,
  // labelled with its age and never as a current answer.
  //
  // Lapsed is not unmeasured. That distinction was made on the web card and
  // never reached this surface, which is the one an external model reads.
  const lastLooks = response.representations
    .filter((row) => row.supply.state === 'positive_supply')
    .map((row) => row.lastObservation)
    .filter((observation): observation is NonNullable<typeof observation> => observation !== null);
  const byOutcome = new Map<string, number>();
  for (const observation of lastLooks) {
    byOutcome.set(observation.status, (byOutcome.get(observation.status) ?? 0) + 1);
  }
  const neverMeasured = eligible - lastLooks.length;
  const newest = lastLooks
    .map((observation) => observation.observedAt)
    .sort()
    .at(-1);
  const age = newest ? agoV1(newest, response.assembledAt) : null;
  const looks = [
    ...[...byOutcome.entries()].map(
      ([status, count]) => `${count} ${LAST_LOOK_LABEL_V1[status] ?? status}`,
    ),
    ...(neverMeasured > 0 ? [`${neverMeasured} never measured`] : []),
  ];
  const third =
    currentComparisonAvailable || looks.length === 0
      ? ''
      : lastLooks.length === 0
        ? ` Miorail has never completed a look at ${
            eligible === 1 ? 'this representation' : `any of these ${eligible}`
          }, so there is no history here either.`
        : ` The last completed look at these ${eligible}${
            age ? `, ${age}` : ''
          }: ${looks.join(', ')}. That is history, not a current answer — and it is what separates a quote that has since lapsed from a representation Miorail has never measured.`;

  // Said in Miorail's words so it does not have to be reconstructed from a
  // count. A router quote lives about twenty seconds; the absence of one is
  // about freshness, not about whether the asset trades.
  const notEstablished =
    'A missing current answer is a statement about Miorail’s freshness at this exact size and direction — not about whether the security trades. Do not describe any representation as illiquid, untradeable, cheaper or better on this evidence.';

  const nextSafeStep = currentComparisonAvailable
    ? 'Read the per-representation state below, or inspect one exact address further. Miorail does not choose a winner from these facts.'
    : 'Measure the exact market again in Miorail, or pick one reviewed representation by its exact address to inspect. Do not infer an outcome from the absence of one.';

  return {
    summary: `${first} ${second}${third}`,
    currentComparisonAvailable,
    nextSafeStep,
    notEstablished,
    representations: response.representations.map((representation) => {
      const issuer = ISSUER_LABEL_V1[representation.issuerId] ?? representation.issuerId;
      const kind = KIND_LABEL_V1[representation.representationKind] ?? representation.representationKind;
      const supply = representation.supply.state;
      const inCurrentComparison = supply === 'positive_supply';
      const state =
        supply === 'zero_supply'
          ? 'zero observed supply, outside the current comparison'
          : supply === 'positive_supply'
            ? 'positive supply'
            : 'supply not established';
      // The last look belongs on the row, not only in the total: which of the
      // four priced and which could not be sized is exactly what a reader needs
      // to pick one address to look at next, and a count cannot say it.
      const observation = representation.lastObservation;
      const lastLook =
        observation === null
          ? supply === 'positive_supply'
            ? '; never measured'
            : ''
          : `; last look ${LAST_LOOK_LABEL_V1[observation.status] ?? observation.status}${
              agoV1(observation.observedAt, response.assembledAt)
                ? `, ${agoV1(observation.observedAt, response.assembledAt)}`
                : ''
            }`;
      return {
        tokenAddress: representation.tokenAddress,
        issuerId: representation.issuerId,
        line: `${issuer} ${kind} ${representation.tokenAddress} — ${state}${lastLook}`,
        inCurrentComparison,
      };
    }),
  };
}
