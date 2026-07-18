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
