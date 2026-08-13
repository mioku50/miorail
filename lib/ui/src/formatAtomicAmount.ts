// T58: pure atomic -> decimal formatter shared by the proof/history views.
// BigInt string math only — no floats, and BigInt(...) calls instead of
// bigint literals because the miniapp build targets ES2017 — so 18-decimal
// amounts never lose precision.

export function formatAtomicAmount(amountAtomic: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amountAtomic) || !Number.isInteger(decimals) || decimals < 0) {
    return amountAtomic;
  }
  const value = BigInt(amountAtomic);
  if (decimals === 0) return value.toString();
  const base = BigInt(10) ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  if (frac === BigInt(0)) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

/** Exact, width-bounded display for market rails. Values below one million
 * stay untouched; larger values are truncated (never rounded up) to four
 * significant digits so an at-least bound remains conservative. */
export function formatCompactAtomicAmount(amountAtomic: string, decimals: number): string {
  const decimal = formatAtomicAmount(amountAtomic, decimals);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!match) return decimal;
  const whole = match[1]!;
  if (decimal.length <= 10) return decimal;

  const units = [
    { digits: 13, suffix: 'T' },
    { digits: 10, suffix: 'B' },
    { digits: 7, suffix: 'M' },
    { digits: 4, suffix: 'K' },
  ] as const;
  const unit = units.find((entry) => whole.length >= entry.digits);
  if (!unit) return decimal;

  const integerDigits = whole.length - (unit.digits - 1);
  const fractionalDigits = Math.max(0, 4 - integerDigits);
  const fractionalSource = whole.slice(integerDigits) + (match[2] ?? '');
  const fraction = fractionalSource.slice(0, fractionalDigits).replace(/0+$/, '');
  return whole.slice(0, integerDigits) + (fraction ? '.' + fraction : '') + unit.suffix;
}
