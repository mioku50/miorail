import {
  BASE_MCP_PLUGIN_CATALOGUE_V1,
  BASE_MCP_PROVIDER_INTENTS_V1,
  mayHandOffToRoutesV1,
  providerRouteCapabilityV1,
  type BaseMcpCapabilityCellV1,
  type BaseMcpProviderExampleDispositionV1,
  type BaseMcpProviderIntentSpecV1,
  type BaseMcpRuntimeSnapshotV1,
} from '@mioagent/security';
import { baseMcpRuntimeSnapshotV1 } from './baseMcpRuntimeSnapshot.js';

export interface BaseMcpProviderIntentMatchV1 {
  pluginId: string;
  productSurface: 'routes' | 'extensions';
  lifecycleStage: BaseMcpProviderIntentSpecV1['lifecycleStage'];
  disposition: BaseMcpProviderExampleDispositionV1;
  /** Why the runtime refused a declared handoff, when it did. */
  routeCapability: BaseMcpCapabilityCellV1 | null;
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

function overlapScore(message: string, prompt: string, aliases: readonly string[] = []): number {
  const ignored = new Set(['show', 'list', 'get', 'check', 'find', 'inspect', 'the', 'my', 'this', 'that', 'for', 'from', 'and', 'with', 'base',
    ...aliases.flatMap(alias => normalized(alias).split(' '))]);
  const meaningful = (text: string) => normalized(text).split(' ')
    .filter(word => word.length > 2 && !ignored.has(word)).map(word => word.replace(/s$/, ''));
  const words = new Set(meaningful(message));
  return meaningful(prompt).reduce((score, word) => score + (words.has(word) ? 1 : 0), 0);
}

type ReviewedRouteFamilyV1 = 'swap' | 'earn' | 'commerce' | 'nft';

const RELEASED_PROVIDER_ROUTES_V1: Readonly<Record<ReviewedRouteFamilyV1, ReadonlySet<string>>> = {
  swap: new Set(['uniswap', 'kyberswap', 'aerodrome', 'o1-exchange', 'hydrex', 'balancer']),
  earn: new Set(['moonwell', 'morpho', 'yo']),
  commerce: new Set(['bitrefill']),
  nft: new Set(['opensea']),
};

/**
 * Provider ownership is not execution capability, and a released QUOTE adapter
 * is not a released ROUTE.
 *
 * This predicate answers only the first question: is there an adapter for this
 * provider in this route family at all. It used to be the whole gate, and that
 * is how a user asking for an Aerodrome swap was sent into Routes AI to reach
 * a Safety Kernel refusal nobody could clear. The second question — can this
 * runtime carry the intent to a signature — is `handoffToRoutesReleasedV1`
 * below, and both must pass before anything hands off.
 */
export function hasReleasedProviderRouteV1(providerId: string, family: ReviewedRouteFamilyV1): boolean {
  return RELEASED_PROVIDER_ROUTES_V1[family].has(providerId);
}

/** Every provider with a released adapter in any route family. */
export const ROUTE_ADAPTER_PROVIDERS_V1: readonly string[] = [
  ...new Set(Object.values(RELEASED_PROVIDER_ROUTES_V1).flatMap((set) => [...set])),
];

/**
 * The end-to-end gate. A provider-specific intent may be sent to Routes AI
 * only when the runtime can carry THIS operation to its honest end point, and
 * the reason is returned alongside so a refusal can name what is missing
 * instead of stranding the user on a Review screen.
 */
export function handoffToRoutesReleasedV1(
  providerId: string,
  runtime: BaseMcpRuntimeSnapshotV1 = baseMcpRuntimeSnapshotV1(),
): { released: boolean; capability: BaseMcpCapabilityCellV1 } {
  return {
    released: mayHandOffToRoutesV1(providerId, runtime),
    capability: providerRouteCapabilityV1(providerId, runtime),
  };
}

function inferredDisposition(
  message: string,
  provider: BaseMcpProviderIntentSpecV1,
  runtime: BaseMcpRuntimeSnapshotV1,
): BaseMcpProviderExampleDispositionV1 {
  const lower = normalized(message);
  // Cyrillic words are not bounded by JavaScript's ASCII \b.
  if (provider.pluginId === 'avantis' && /(?:^|\s)(?:откр|закр|лонг|шорт|плеч)\p{L}*/iu.test(lower)) return 'handoff_to_provider_ui';
  if (/(?:^|\s)(?:созда|запуст|отправ|установ|зарегистр|одобр)\p{L}*/iu.test(lower)) return 'adapter_required';
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

  if (provider.pluginId === 'printr' && /\b(cost|quote|status|deployments?)\b/i.test(lower) &&
      !/^(?:please\s+)?(?:launch|create|deploy)\b/i.test(lower)) return 'read_in_extensions';
  if (provider.pluginId === 'moonwell' && readVerb.test(lower) && /\b(markets?|positions?|health)\b/i.test(lower)) return 'read_in_extensions';

  // These provider reads are released in Extensions even though adjacent
  // transaction construction remains owned by Routes or an unreleased SDK.
  if (provider.pluginId === 'balancer' && readVerb.test(lower) && /\b(pool|yield|apy|liquidity)\b/iu.test(lower)) {
    return 'read_in_extensions';
  }
  if (provider.pluginId === 'bitrefill' && readVerb.test(lower)) return 'read_in_extensions';

  // `route_unavailable_here` rather than `adapter_required`: an adapter that
  // exists and cannot finish is a different fact from one that was never
  // written, and only the first one is fixable by an operator.
  const routableDisposition = (family: ReviewedRouteFamilyV1): BaseMcpProviderExampleDispositionV1 => {
    if (!hasReleasedProviderRouteV1(provider.pluginId, family)) return 'adapter_required';
    return handoffToRoutesReleasedV1(provider.pluginId, runtime).released ? 'handoff_to_routes' : 'route_unavailable_here';
  };
  if (commerce.test(lower)) return routableDisposition('commerce');
  if (swap.test(lower)) return routableDisposition('swap');
  if (earn.test(lower)) return routableDisposition('earn');
  if (nft.test(lower)) return routableDisposition('nft');

  const write = /\b(launch|create|claim|set|send|register|mint|approve|cancel|запусти|создай|отправ|установ|зарегистр)\b/iu;
  return write.test(lower) ? 'adapter_required' : 'read_in_extensions';
}

/**
 * `runtime` is injectable because the answer DEPENDS on the deployment, and a
 * function whose verdict changes with an environment variable is one no test
 * can pin. It defaults to the process snapshot, so production callers pass
 * nothing and a test states the world it means to describe.
 */
export function matchBaseMcpProviderIntentV1(
  message: string,
  runtime: BaseMcpRuntimeSnapshotV1 = baseMcpRuntimeSnapshotV1(),
): BaseMcpProviderIntentMatchV1 | null {
  const clean = normalized(message);
  if (!clean) return null;
  const provider = BASE_MCP_PROVIDER_INTENTS_V1.find((entry) =>
    entry.aliases.some((alias) => containsAlias(clean, alias)),
  );
  if (!provider) return null;

  const exact = provider.examples.find((example) => normalized(example.prompt) === clean);
  // An exact example match still passes the runtime gate. The registry records
  // the INTENT of an example; whether this deployment can keep it is a runtime
  // question, and answering it from the registry alone is what advertised a
  // dead end as a released capability.
  const declared = exact ? exact.disposition : inferredDisposition(clean, provider, runtime);
  // Never select a write example as the recipe for a paraphrased read.
  const candidates = [...provider.examples]
    .filter(example => example.disposition === declared)
    .map(example => ({ example, score: overlapScore(clean, example.prompt, provider.aliases) }))
    .sort((left, right) => right.score - left.score);
  const closest = exact || (candidates[0] && candidates[0].score > 0 && candidates[0].score !== candidates[1]?.score
    ? candidates[0].example : null);
  const routeGate = declared === 'handoff_to_routes' ? handoffToRoutesReleasedV1(provider.pluginId, runtime) : null;
  const disposition: BaseMcpProviderExampleDispositionV1 =
    routeGate && !routeGate.released ? 'route_unavailable_here' : declared;
  const plugin = BASE_MCP_PLUGIN_CATALOGUE_V1.find((entry) => entry.id === provider.pluginId);
  const hosts = plugin?.hosts.length ? plugin.hosts.join(', ') : 'Base MCP chain tools';

  return {
    pluginId: provider.pluginId,
    productSurface: provider.productSurface,
    lifecycleStage: provider.lifecycleStage,
    disposition,
    /** Present only when the runtime blocked a handoff the registry declared. */
    routeCapability: routeGate && !routeGate.released ? routeGate.capability : null,
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
