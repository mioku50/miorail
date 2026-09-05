/** Inputs for reviewed reads. Values come from the request, never a demo budget. */
export function moonwellAssetV1(message: string): string | null {
  const candidates = message.match(/\b(?:[A-Z][A-Z0-9]{1,11}[a-z]?|cbETH|wstETH)\b/g) ?? [];
  const symbols = [...new Set(candidates.filter(value => !['BASE', 'API', 'APY', 'APR', 'USD'].includes(value)))];
  if (symbols.length === 1) return symbols[0]!;
  const named = message.match(/\bmoonwell\s+([a-z][a-z0-9]{1,15})\s+(?:supply\s+)?markets?\b/i)?.[1];
  return symbols.length === 0 && named && !['supply', 'borrow', 'all', 'the'].includes(named.toLowerCase()) ? named.toUpperCase() : null;
}

const PRINTR_CHAINS = [
  ['base', 'eip155:8453'], ['arbitrum', 'eip155:42161'], ['optimism', 'eip155:10'],
  ['polygon', 'eip155:137'], ['bsc', 'eip155:56'], ['avalanche', 'eip155:43114'], ['ethereum', 'eip155:1'],
] as const;

export function printrQuoteInputV1(message: string) {
  const chainText = message.match(/\b(?:on|for)\s+(.+?)[,;]\s*initial\s+buy\b/i)?.[1];
  const names = chainText?.toLowerCase().split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean) ?? [];
  const selected = names.map(name => PRINTR_CHAINS.find(([label, id]) => name === label || name === id)?.[1]);
  if (!selected.length || selected.some(id => !id)) return null;
  const chains = [...new Set(selected as Array<typeof PRINTR_CHAINS[number][1]>)];
  const initial = message.match(/initial\s+buy\s*(?:of\s*)?\$?([0-9]+(?:\.[0-9]+)?)\s+USD\b/i)?.[1];
  const graduation = message.match(/graduation\s+(?:target|threshold)\s*(?:of\s*)?\$?([0-9]+)\s+USD\b/i)?.[1];
  if (!chains.length || !initial || !graduation) return null;
  const spend = Number(initial);
  const target = Number(graduation);
  if (!Number.isFinite(spend) || spend < 0 || !Number.isSafeInteger(target) || target < 15000 || target > 1000000) return null;
  return { chains, initial_buy: { spend_usd: spend }, graduation_threshold_per_chain_usd: target };
}
