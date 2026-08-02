// ---------------------------------------------------------------------------
// T68C — turning router quotes into the measurements the verdict needs.
//
// `exitFirst.ts` decides what a set of measurements MEANS. This file decides
// what to measure and how to read the numbers a router gives back. It is pure:
// no network, no clock, no addresses. The reads happen one layer up.
//
// The one thing it must never do is produce a number nobody measured. A router
// answers exactly the question it is asked — "what comes out for THIS input" —
// and every figure here is that answer or a ratio of two of them.
// ---------------------------------------------------------------------------

const BPS_DENOMINATOR = 10_000n;

/**
 * The sizes to probe, smallest first.
 *
 * Geometric, halving down from the position, because depth falls off
 * multiplicatively: a linear ladder spends most of its probes in a range where
 * nothing changes and leaves the interesting part unmeasured.
 *
 * The POSITION ITSELF is always a rung. The verdict compares capacity against
 * the position, and a ladder that stopped short of it could only ever answer a
 * question the user did not ask.
 */
export function exitProbeLadderV1(positionAtomic: string, rungs: number): string[] {
  const position = BigInt(positionAtomic);
  if (position <= 0n) return [];
  const count = Math.max(1, Math.min(8, Math.trunc(rungs)));

  const sizes: bigint[] = [];
  let size = position;
  for (let index = 0; index < count && size > 0n; index += 1) {
    sizes.push(size);
    size /= 2n;
  }
  // Ascending, and de-duplicated: halving a small position can reach the same
  // integer twice, and a repeated rung would be a probe paid for twice that
  // measures nothing new.
  const ascending = [...new Set(sizes.map((value) => value.toString()))]
    .map((value) => BigInt(value))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return ascending.map((value) => value.toString());
}

export interface QuotedSizeV1 {
  sizeAtomic: string;
  /** What the router said comes out. Null when it had no route at this size —
   * which is a different answer from a bad price. */
  outputAtomic: string | null;
}

/**
 * Price impact of each probe, measured against the SMALLEST probe that
 * answered.
 *
 * This is not slippage against a mid price, and the difference matters: the
 * reference quote has price impact of its own, so every figure here
 * UNDERSTATES the true impact by whatever the reference cost. The reference
 * size is returned so a surface can say what the numbers are relative to
 * instead of implying they are absolute.
 *
 * A size the router could not price stays null all the way through. Reading it
 * as "very bad slippage" would turn the absence of a pool into a number.
 */
export function priceImpactLadderV1(quotes: readonly QuotedSizeV1[]): {
  referenceSizeAtomic: string | null;
  probes: { sizeAtomic: string; slippageBps: number | null }[];
} {
  const ascending = [...quotes].sort((left, right) =>
    BigInt(left.sizeAtomic) < BigInt(right.sizeAtomic) ? -1 : 1,
  );
  const reference = ascending.find(
    (quote) => quote.outputAtomic !== null && BigInt(quote.outputAtomic) > 0n,
  );
  if (!reference || reference.outputAtomic === null) {
    // Nothing priced at any size. Every probe is null, not zero: no reference
    // exists, so no impact was measured for any of them.
    return {
      referenceSizeAtomic: null,
      probes: ascending.map((quote) => ({ sizeAtomic: quote.sizeAtomic, slippageBps: null })),
    };
  }

  const referenceIn = BigInt(reference.sizeAtomic);
  const referenceOut = BigInt(reference.outputAtomic);
  return {
    referenceSizeAtomic: reference.sizeAtomic,
    probes: ascending.map((quote) => ({
      sizeAtomic: quote.sizeAtomic,
      slippageBps:
        quote.outputAtomic === null
          ? null
          : priceImpactBpsV1({
              referenceIn,
              referenceOut,
              probeIn: BigInt(quote.sizeAtomic),
              probeOut: BigInt(quote.outputAtomic),
            }),
    })),
  };
}

/**
 * One probe's impact in basis points, rounded AGAINST the user.
 *
 * Impact is measured on the RATE, not on the output: at twice the size you
 * expect twice the output, so comparing outputs directly would report a
 * perfectly deep pool as 100% slippage.
 */
export function priceImpactBpsV1(input: {
  referenceIn: bigint;
  referenceOut: bigint;
  probeIn: bigint;
  probeOut: bigint;
}): number | null {
  if (input.referenceIn <= 0n || input.referenceOut <= 0n || input.probeIn <= 0n) return null;
  // What the probe would return at the reference rate, in the probe's units.
  const expected = (input.referenceOut * input.probeIn) / input.referenceIn;
  if (expected <= 0n) return null;
  const shortfall = expected - input.probeOut;
  if (shortfall <= 0n) return 0;
  // Ceiling division: an impact of 6.301% is reported as 6.31%, never 6.30%.
  // The only defensible rounding direction when the number is a cost.
  return Number((shortfall * BPS_DENOMINATOR + expected - 1n) / expected);
}

/**
 * Whether an exit measurement is worth showing at all.
 *
 * A ladder whose reference is the same size as the position measured one
 * point, and a single point has no impact curve in it. The verdict may still
 * be sound — a rejection on a single probe is still a rejection — but a PASS
 * that rests on one measurement must not be presented as a depth finding.
 */
export function exitLadderIsInformativeV1(input: {
  referenceSizeAtomic: string | null;
  positionAtomic: string;
  pricedProbeCount: number;
}): boolean {
  if (input.referenceSizeAtomic === null) return false;
  if (input.pricedProbeCount < 2) return false;
  return BigInt(input.referenceSizeAtomic) < BigInt(input.positionAtomic);
}
