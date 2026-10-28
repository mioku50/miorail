interface DecimalV1 { whole: string; fraction: string; positive: boolean }

function decimalV1(value: string | null | undefined): DecimalV1 | null {
  if (typeof value !== 'string' || value.length > 256 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return { whole: whole!.replace(/^0+(?=\d)/, ''), fraction, positive: /[1-9]/.test(value) };
}

/** Display only: preserve a positive fraction of a cent instead of rounding
 * it into a claim of zero. Missing or malformed readings stay unknown. */
export function dividendMoneyV1(value: string | null | undefined): string | null {
  const decimal = decimalV1(value);
  if (!decimal) return null;
  const fraction = decimal.fraction.padEnd(3, '0');
  if (decimal.positive && decimal.whole === '0' && fraction.slice(0, 2) === '00') return '<$0.01';
  const cents = BigInt(decimal.whole) * BigInt(100) + BigInt(fraction.slice(0, 2)) + (fraction[2]! >= '5' ? BigInt(1) : BigInt(0));
  return `$${cents / BigInt(100)}.${(cents % BigInt(100)).toString().padStart(2, '0')}`;
}

export function positiveDividendMoneyV1(value: string | null | undefined): string | null {
  return decimalV1(value)?.positive ? dividendMoneyV1(value) : null;
}

/** Received amounts may include unknown values. Do not silently treat those
 * as zero, and do not lose a subcent total through floating point addition. */
export function sumDividendMoneyV1(values: readonly (string | null)[]): string | null {
  const decimals = values.map(decimalV1);
  if (decimals.some(value => value === null)) return null;
  const known = decimals as DecimalV1[];
  const places = known.reduce((max, value) => Math.max(max, value.fraction.length), 0);
  const scale = BigInt(10) ** BigInt(places);
  const total = known.reduce((sum, value) => sum + BigInt(value.whole) * scale + BigInt(value.fraction.padEnd(places, '0') || '0'), BigInt(0));
  const digits = total.toString().padStart(places + 1, '0');
  return dividendMoneyV1(places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`);
}
