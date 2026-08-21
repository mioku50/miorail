import {
  BASE_MCP_PLUGIN_CATALOGUE_V1,
  BASE_MCP_PROVIDER_INTENTS_V1,
  type BaseMcpProviderExampleDispositionV1,
  type BaseMcpProviderIntentSpecV1,
} from '@mioagent/security';

export interface BaseMcpProviderIntentMatchV1 {
  pluginId: string;
  productSurface: 'routes' | 'extensions';
  lifecycleStage: BaseMcpProviderIntentSpecV1['lifecycleStage'];
  disposition: BaseMcpProviderExampleDispositionV1;
  exampleId: string | null;
  providerPrompt: string;
}

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё.]+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsAlias(message: string, alias: string): boolean {
  const cleanAlias = normalized(alias);
  return cleanAlias.length > 0 && (` ${message} `).includes(` ${cleanAlias} `);
}

function overlapScore(message: string, prompt: string): number {
  const words = new Set(normalized(message).split(' ').filter((word) => word.length > 2));
  return normalized(prompt).split(' ').reduce((score, word) => score + (words.has(word) ? 1 : 0), 0);
}

type ReviewedRouteFamilyV1 = 'swap' | 'earn' | 'commerce' | 'nft';

const RELEASED_PROVIDER_ROUTES_V1: Readonly<Record<ReviewedRouteFamilyV1, ReadonlySet<string>>> = {
  swap: new Set(['uniswap', 'kyberswap', 'aerodrome', 'o1-exchange', 'hydrex', 'balancer']),
  earn: new Set(['moonwell', 'morpho', 'yo']),
  commerce: new Set(['bitrefill']),
  nft: new Set(['opensea']),
};

/** Provider ownership is not execution capability. A named provider may hand
 * off only when the corresponding route family has a released adapter. */
export function hasReleasedProviderRouteV1(providerId: string, family: ReviewedRouteFamilyV1): boolean {
  return RELEASED_PROVIDER_ROUTES_V1[family].has(providerId);
}

function inferredDisposition(
  message: string,
  provider: BaseMcpProviderIntentSpecV1,
): BaseMcpProviderExampleDispositionV1 {
  const lower = normalized(message);
  const avantisWrite = /\b(open|close|long|short|take profit|stop loss|tp|sl|margin|leverage|открой|закрой|лонг|шорт|плеч)\b/iu;
  if (provider.pluginId === 'avantis' && avantisWrite.test(lower)) return 'handoff_to_provider_ui';

  if (/\bx402\b/iu.test(lower) || /\b(top up|register my agent|agent nft)\b/iu.test(lower)) {
    return 'typed_x402_required';
  }

  if (provider.pluginId === 'virtuals' && /\bcreate\b.{0,40}\bagent\b/iu.test(lower)) {
    return 'action_in_extensions';
  }

  const readVerb = /\b(show|list|find|browse|inspect|check|what|which|latest|best)\b|\b(покажи|найди|список|проверь)\b/iu;
  const swap = /\b(swap|trade|buy|sell|quote|route|exchange|обмен|свап|куп|прод)\b/iu;
  const earn = /\b(yield|apy|supply|borrow|deposit|withdraw|vault|lending|liquidity|доходност|депозит|заем|ликвидност)\b/iu;
  const commerce = /\b(gift card|esim|top up|bitrefill|voucher)\b/iu;
  const nft = /\b(nft|listing|collection|opensea)\b/iu;

  // These provider reads are released in Extensions even though adjacent
  // transaction construction remains owned by Routes or an unreleased SDK.
  if (provider.pluginId === 'balancer' && readVerb.test(lower) && /\b(pool|yield|apy|liquidity)\b/iu.test(lower)) {
    return 'read_in_extensions';
  }
  if (provider.pluginId === 'bitrefill' && readVerb.test(lower)) return 'read_in_extensions';

  if (commerce.test(lower)) {
    return hasReleasedProviderRouteV1(provider.pluginId, 'commerce') ? 'handoff_to_routes' : 'adapter_required';
  }
  if (swap.test(lower)) {
    return hasReleasedProviderRouteV1(provider.pluginId, 'swap') ? 'handoff_to_routes' : 'adapter_required';
  }
  if (earn.test(lower)) {
    return hasReleasedProviderRouteV1(provider.pluginId, 'earn') ? 'handoff_to_routes' : 'adapter_required';
  }
  if (nft.test(lower)) {
    return hasReleasedProviderRouteV1(provider.pluginId, 'nft') ? 'handoff_to_routes' : 'adapter_required';
  }

  const write = /\b(launch|create|claim|set|send|register|mint|approve|cancel|запусти|создай|отправ|установ|зарегистр)\b/iu;
  return write.test(lower) ? 'adapter_required' : 'read_in_extensions';
}

export function matchBaseMcpProviderIntentV1(message: string): BaseMcpProviderIntentMatchV1 | null {
  const clean = normalized(message);
  if (!clean) return null;
  const provider = BASE_MCP_PROVIDER_INTENTS_V1.find((entry) =>
    entry.aliases.some((alias) => containsAlias(clean, alias)),
  );
  if (!provider) return null;

  const exact = provider.examples.find((example) => normalized(example.prompt) === clean);
  const closest = exact || [...provider.examples]
    .map((example) => ({ example, score: overlapScore(clean, example.prompt) }))
    .sort((left, right) => right.score - left.score)[0]?.example;
  const disposition = exact
    ? exact.disposition
    : inferredDisposition(clean, provider);
  const plugin = BASE_MCP_PLUGIN_CATALOGUE_V1.find((entry) => entry.id === provider.pluginId);
  const hosts = plugin?.hosts.length ? plugin.hosts.join(', ') : 'Base MCP chain tools';

  return {
    pluginId: provider.pluginId,
    productSurface: provider.productSurface,
    lifecycleStage: provider.lifecycleStage,
    disposition,
    exampleId: closest?.id ?? null,
    providerPrompt: [
      `The user explicitly selected the ${provider.pluginId} plugin. Do not substitute another provider.`,
      `Its reviewed product owner is ${provider.productSurface === 'routes' ? 'Routes AI' : 'Base MCP Extensions'} and its current lifecycle stage is ${provider.lifecycleStage}.`,
      `For a read, use Base MCP help for ${provider.pluginId} and then at most one GET request to its declared scope (${hosts}). Never invent an endpoint or a result.`,
    ].join(' '),
  };
}

export interface AvantisProviderHandoffV1 {
  target: 'provider';
  provider: 'avantis';
  path: string;
  reason: 'provider_ui_required';
  originalMessage: string;
  summary: string;
  risk: 'liquidation';
}

/** Build only the official Avantis deep link; no URL component comes from user input. */
export function buildAvantisProviderHandoffV1(message: string): AvantisProviderHandoffV1 | null {
  const upper = message.toUpperCase();
  const pair = upper.match(/\b(BTC|ETH|SNDK|SOL|ARB|OP)\s*[/-]\s*USD\b/u)?.[1];
  const market = pair || upper.match(/\b(BTC|ETH|SNDK|SOL|ARB|OP)\b/u)?.[1] || null;
  if (!market) return null;
  const side = /\b(short|шорт)\b/iu.test(message) ? 'short' : /\b(long|лонг)\b/iu.test(message) ? 'long' : null;
  const leverage = message.match(/\b(\d+(?:[.,]\d+)?)\s*x\b/iu)?.[1]?.replace(',', '.') ?? null;
  const collateral = message.match(/\b(\d+(?:[.,]\d+)?)\s*USDC\b/iu)?.[1]?.replace(',', '.') ?? null;
  const facts = [
    `${market}/USD`,
    side,
    leverage ? `${leverage}x` : null,
    collateral ? `${collateral} USDC collateral` : null,
  ].filter(Boolean);
  return {
    target: 'provider',
    provider: 'avantis',
    path: `https://www.avantisfi.com/trade?asset=${encodeURIComponent(`${market}-USD`)}`,
    reason: 'provider_ui_required',
    originalMessage: message,
    summary: `Avantis intent: ${facts.join(' · ')}. Recheck live market, leverage, liquidity and liquidation terms in Avantis before approval.`,
    risk: 'liquidation',
  };
}
