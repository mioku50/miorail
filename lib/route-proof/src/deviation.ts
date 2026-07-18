// T58: deviation math. outputBps compares actual vs expected output amounts;
// minimumSatisfied compares actual against the expected credit change's
// minimumAmountAtomic. Both stay null unless every input they need is known —
// never a fabricated "0" or "true" standing in for missing data.

export interface RouteProofDeviationInputV1 {
  expectedOutputAtomic: string | null;
  actualOutputAtomic: string | null;
  minimumOutputAtomic: string | null;
}

export interface RouteProofDeviationResultV1 {
  outputBps: number | null;
  minimumSatisfied: boolean | null;
}

/** Rounds (numerator / denominator) to the nearest integer, half away from
 * zero, using BigInt arithmetic throughout so large atomic amounts never lose
 * precision through a float conversion. */
function roundedRatioBpsV1(diff: bigint, expected: bigint): number {
  const numerator = diff * BigInt(10_000);
  const sign = numerator < BigInt(0) ? -1 : 1;
  const absNumerator = numerator < BigInt(0) ? -numerator : numerator;
  const absExpected = expected < BigInt(0) ? -expected : expected;
  const quotient = absNumerator / absExpected;
  const remainder = absNumerator % absExpected;
  const rounded = remainder * BigInt(2) >= absExpected ? quotient + BigInt(1) : quotient;
  if (rounded === BigInt(0)) return 0; // avoid a signed -0 leaking out
  return sign * Number(rounded);
}

export function computeRouteProofDeviationV1(
  input: RouteProofDeviationInputV1,
): RouteProofDeviationResultV1 {
  const { expectedOutputAtomic, actualOutputAtomic, minimumOutputAtomic } = input;

  let outputBps: number | null = null;
  if (expectedOutputAtomic !== null && actualOutputAtomic !== null) {
    const expected = BigInt(expectedOutputAtomic);
    if (expected !== BigInt(0)) {
      const actual = BigInt(actualOutputAtomic);
      outputBps = roundedRatioBpsV1(actual - expected, expected);
    }
  }

  let minimumSatisfied: boolean | null = null;
  if (minimumOutputAtomic !== null && actualOutputAtomic !== null) {
    minimumSatisfied = BigInt(actualOutputAtomic) >= BigInt(minimumOutputAtomic);
  }

  return { outputBps, minimumSatisfied };
}
