import type { FoundToken } from './found-report.js';

/** Preserve every decimal digit of the published quote, including scientific notation. */
export function decimalPrice(value: unknown): { raw: bigint; decimals: number } | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e15) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  if (!match) return null;
  const fraction = match[2] ?? '';
  const power = Number(match[3] ?? 0) - fraction.length;
  const digits = BigInt(match[1]! + fraction);
  return power >= 0 ? { raw: digits * 10n ** BigInt(power), decimals: 0 } : { raw: digits, decimals: -power };
}

/** Add exact quoted token fractions first; per-row cent truncation can erase a real total. */
export function sumFoundCents(tokens: readonly FoundToken[]): bigint {
  const priced = tokens.flatMap((t) => {
    const price = t.quote ? decimalPrice(Number(t.quote.usd)) : null;
    return t.valueCents !== null && t.decimals !== null && price !== null ? [{ coefficient: BigInt(t.raw) * price.raw, decimals: t.decimals + price.decimals }] : [];
  });
  const decimals = priced.reduce((max, t) => Math.max(max, t.decimals), 0);
  const numerator = priced.reduce((sum, t) => sum + t.coefficient * 10n ** BigInt(decimals - t.decimals), 0n);
  return numerator * 100n / 10n ** BigInt(decimals);
}

/** Quotes are estimates at their own clock, never part of the borrowing line or onchain proof. */
export async function priceFoundTokens(tokens: FoundToken[], fetcher: typeof fetch = fetch, now = new Date(), budgetMs = 10_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  for (let offset = 0; offset < tokens.length; offset += 40) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    const part = tokens.slice(offset, offset + 40);
    try {
      const url = `https://coins.llama.fi/prices/current/${part.map((t) => `base:${t.token.toLowerCase()}`).join(',')}`;
      const response = await fetcher(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, Math.floor(remaining)))) });
      if (!response.ok) continue;
      const body = await response.json() as { coins?: Record<string, { price?: unknown; timestamp?: number; confidence?: number; decimals?: number }> };
      for (const token of part) {
        const q = body.coins?.[`base:${token.token.toLowerCase()}`];
        if (!q || token.decimals === null || q.decimals !== token.decimals || typeof q.timestamp !== 'number' || !Number.isFinite(q.timestamp)) continue;
        const age = now.getTime() / 1_000 - q.timestamp;
        if (age > 15 * 60 || age < -300 || typeof q.confidence !== 'number' || !Number.isFinite(q.confidence) || q.confidence < 0.8 || q.confidence > 1) continue;
        const price = decimalPrice(q.price);
        if (price === null) continue;
        token.valueCents = (BigInt(token.raw) * price.raw * 100n / 10n ** BigInt(token.decimals + price.decimals)).toString();
        token.quote = { source: 'DefiLlama', usd: String(q.price), at: new Date(q.timestamp * 1_000).toISOString(), confidence: q.confidence };
      }
    } catch { /* An unavailable quote leaves the measured token amount unpriced. */ }
  }
}
