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

  // Said in Miorail's words so it does not have to be reconstructed from a
  // count. A router quote lives about twenty seconds; the absence of one is
  // about freshness, not about whether the asset trades.
  const notEstablished =
    'A missing current answer is a statement about Miorail’s freshness at this exact size and direction — not about whether the security trades. Do not describe any representation as illiquid, untradeable, cheaper or better on this evidence.';

  const nextSafeStep = currentComparisonAvailable
    ? 'Read the per-representation state below, or inspect one exact address further. Miorail does not choose a winner from these facts.'
    : 'Measure the exact market again in Miorail, or pick one reviewed representation by its exact address to inspect. Do not infer an outcome from the absence of one.';

  return {
    summary: `${first} ${second}`,
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
      return {
        tokenAddress: representation.tokenAddress,
        issuerId: representation.issuerId,
        line: `${issuer} ${kind} ${representation.tokenAddress} — ${state}`,
        inCurrentComparison,
      };
    }),
  };
}
