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

function inferredDisposition(
  message: string,
  provider: BaseMcpProviderIntentSpecV1,
): BaseMcpProviderExampleDispositionV1 {
  const lower = normalized(message);
  const avantisWrite = /\b(open|close|long|short|take profit|stop loss|tp|sl|margin|leverage|открой|закрой|лонг|шорт|плеч)\b/iu;
  if (provider.pluginId === 'avantis' && avantisWrite.test(lower)) return 'handoff_to_provider_ui';

  const routable = /\b(swap|trade|buy|sell|quote|yield|apy|supply|borrow|deposit|withdraw|liquidity|route|обмен|свап|куп|прод|доходност|депозит|заем|ликвидност)\b/iu;
  if (provider.productSurface === 'routes' || routable.test(lower)) return 'handoff_to_routes';

  if (/\bx402\b/iu.test(lower) || /\b(top up|register my agent|agent nft)\b/iu.test(lower)) {
    return 'typed_x402_required';
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
