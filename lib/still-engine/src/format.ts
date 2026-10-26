// Plain-words formatting shared by the page and agent tools: money first, to the cent.

/** "$1,024.82" from integer cents. Negative amounts never appear in a report. */
export function formatCents(cents: string | bigint): string {
  const value = typeof cents === 'bigint' ? cents : BigInt(cents);
  const dollars = value / 100n;
  const rest = (value % 100n).toString().padStart(2, '0');
  return `$${dollars.toLocaleString('en-US')}.${rest}`;
}

/**
 * A token amount with a fixed number of decimals, truncated, never rounded up. An amount that
 * would read as zero at those decimals keeps two significant digits instead.
 */
export function formatTokenAmount(raw: string | bigint, decimals: number, shown = 4): string {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  if (shown === 0) return whole.toLocaleString('en-US');
  const fractionAt = (places: number) => ((value % scale) * 10n ** BigInt(places)) / scale;
  let places = shown;
  if (whole === 0n && value > 0n && fractionAt(shown) === 0n) {
    while (places < decimals && fractionAt(places) < 10n) places += 1;
  }
  return `${whole.toLocaleString('en-US')}.${fractionAt(places).toString().padStart(places, '0')}`;
}

/** "52%" or "3.66%" from basis points, truncated to the decimals asked. */
export function formatPercentBps(bps: number, decimals = 0): string {
  const factor = 10 ** decimals;
  return `${(Math.floor((bps / 100) * factor) / factor).toFixed(decimals)}%`;
}
