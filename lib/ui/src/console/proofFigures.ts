// ---------------------------------------------------------------------------
// The proof's figures in words a person reads at a glance.
//
// Seen on the operator's own trade of 2026-10-19: the route card priced the
// fee as "$0.00481378030088898", the proof's "Actual gas" was the whole
// bundle's (a stranger's operation included), "Difference" was a hard-coded
// dash, and the signing step printed a 128-character batch id. What the screen
// promises to show — what Miorail quoted next to what the chain did — has to
// be readable to be shown at all.
// ---------------------------------------------------------------------------

export type ProofFigureToneV1 = 'good' | 'warn' | 'none';

export interface ProofFigureRowV1 {
  expected: string;
  actual: string;
  difference: string;
  tone: ProofFigureToneV1;
}

/** Two significant digits, never in exponent form: `0.0048`, `0.00000014`. */
function significantV1(value: number): string {
  return value.toLocaleString('en-US', { maximumSignificantDigits: 2 });
}

/** A network fee in dollars, rounded for reading: `$0.0048`, `$0.12`. */
export function feeUsdLabelV1(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (amount === 0) return '$0';
  if (amount < 0.0001) return '<$0.0001';
  if (amount < 0.01) return `$${significantV1(amount)}`;
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Base units to a decimal, exactly. */
function atomicDecimalV1(value: bigint, decimals: number): string {
  const digits = value.toString();
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** A share in percent with two significant digits: `0.0015%`, `1.99%`. */
function percentLabelV1(fraction: number): string {
  const percent = Math.abs(fraction * 100);
  if (percent >= 1) return `${percent.toFixed(2)}%`;
  if (percent < 0.000001) return '<0.000001%';
  return `${significantV1(percent)}%`;
}

/**
 * What arrived against what was quoted, in the token's own units.
 *
 * Exact (BigInt) for the amount, two significant digits for the share. Less
 * than quoted but within the person's own minimum is the slippage they
 * accepted, said as such; below the minimum is a warning.
 */
export function proofOutputDifferenceV1(input: {
  expectedAtomic: string | null;
  actualAtomic: string | null;
  decimals: number;
  symbol: string;
  minimumSatisfied: boolean | null;
}): Pick<ProofFigureRowV1, 'difference' | 'tone'> {
  const { expectedAtomic, actualAtomic, decimals, symbol } = input;
  if (!expectedAtomic || !actualAtomic || !/^\d+$/.test(expectedAtomic) || !/^\d+$/.test(actualAtomic)) {
    return { difference: '—', tone: 'none' };
  }
  if (!Number.isInteger(decimals) || decimals < 0) return { difference: '—', tone: 'none' };
  const expected = BigInt(expectedAtomic);
  const actual = BigInt(actualAtomic);
  const diff = actual - expected;
  if (diff === BigInt(0)) return { difference: 'exactly as quoted', tone: 'good' };
  const sign = diff < BigInt(0) ? '−' : '+';
  const amount = atomicDecimalV1(diff < BigInt(0) ? -diff : diff, decimals);
  const share = expected > BigInt(0) ? ` (${sign}${percentLabelV1(Number(diff) / Number(expected))})` : '';
  const head = `${sign}${amount} ${symbol}`.trim() + share;
  if (diff > BigInt(0)) return { difference: head, tone: 'good' };
  if (input.minimumSatisfied === false) return { difference: `${head} · below your minimum`, tone: 'warn' };
  if (input.minimumSatisfied === true) return { difference: `${head} · within your slippage`, tone: 'none' };
  return { difference: head, tone: 'none' };
}

export type FeePaidByV1 = 'wallet' | 'sponsor' | 'mixed';

export interface ProofFeeV1 {
  /** The proof's headline figure for the fee. */
  value: string;
  detail: string;
  row: ProofFigureRowV1;
}

/** `0.000003101358` ETH, shortened to what a reader can compare. */
function ethLabelV1(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${value} ETH`;
  if (amount === 0) return '0 ETH';
  return `${significantV1(amount)} ETH`;
}

/**
 * The network fee: what was estimated, what the person's own operation cost,
 * and who paid it.
 *
 * `feePaidBy` is undefined on proofs written before 2026-10-19. Those recorded
 * the gas of the whole bundle, which can include strangers' operations, so
 * they are shown as gas units "from the receipt" and never priced as if they
 * were the person's fee. The dollar figure uses today's ETH price and says so
 * with "≈"; the ETH amount is the chain's own.
 */
export function proofFeeV1(input: {
  estimatedUsd: string | null;
  actualGasUnits: string | null;
  actualNative: string | null;
  feePaidBy: FeePaidByV1 | null | undefined;
  ethUsd: string | number | null;
}): ProofFeeV1 {
  const estimate = feeUsdLabelV1(input.estimatedUsd);
  const expected = estimate ? `≈ ${estimate}` : 'Not provided';
  if (input.feePaidBy === undefined) {
    const units = input.actualGasUnits ? `${input.actualGasUnits} gas` : '—';
    return {
      value: input.actualGasUnits ?? '—',
      detail: 'gas, from the receipt',
      row: { expected, actual: units, difference: '—', tone: 'none' },
    };
  }
  const price = input.ethUsd === null ? NaN : Number(input.ethUsd);
  const native = input.actualNative !== null && Number.isFinite(Number(input.actualNative)) ? Number(input.actualNative) : null;
  const usd = native !== null && Number.isFinite(price) && price > 0 ? native * price : null;
  const cost = usd !== null ? `≈ ${feeUsdLabelV1(usd)}` : input.actualNative !== null ? ethLabelV1(input.actualNative) : null;

  if (input.feePaidBy === 'sponsor') {
    return {
      value: '$0',
      detail: cost ? `sponsored · ${cost} paid for you` : 'sponsored · paid for you',
      row: { expected, actual: 'sponsored', difference: 'you paid $0', tone: 'good' },
    };
  }
  const who = input.feePaidBy === 'wallet' ? 'paid by you' : input.feePaidBy === 'mixed' ? 'partly sponsored' : 'payer not established';
  const estimateUsd = input.estimatedUsd === null ? null : Number(input.estimatedUsd);
  const difference =
    usd !== null && estimateUsd !== null && Number.isFinite(estimateUsd) && input.feePaidBy === 'wallet'
      ? `${usd >= estimateUsd ? '+' : '−'}${feeUsdLabelV1(Math.abs(usd - estimateUsd))}`
      : '—';
  return {
    value: cost ?? '—',
    detail: native !== null && usd !== null ? `${who} · ${ethLabelV1(input.actualNative!)}` : who,
    row: { expected, actual: cost ? `${cost} · ${who}` : who, difference, tone: 'none' },
  };
}
