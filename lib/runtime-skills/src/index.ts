export type RuntimeSkillIntent = 'quote' | 'read' | 'write';

export interface RuntimeSkillToolRequirement {
  intent: RuntimeSkillIntent;
  anyOf: string[];
}

export interface RuntimeSkillDefinition {
  namespace: string;
  displayName: string;
  allowedIntents: RuntimeSkillIntent[];
  requiredTools: RuntimeSkillToolRequirement[];
  argumentMapper: (intent: RuntimeSkillIntent, input: Record<string, unknown>) => Record<string, unknown>;
  resultScreener: string;
  instructions: string[];
}

const identityMapper = (_intent: RuntimeSkillIntent, input: Record<string, unknown>) => ({ ...input });

const SKILLS: RuntimeSkillDefinition[] = [
  {
    namespace: 'uniswap',
    displayName: 'Uniswap',
    allowedIntents: ['quote', 'read', 'write'],
    requiredTools: [
      { intent: 'quote', anyOf: ['uniswap_quote'] },
      { intent: 'read', anyOf: ['uniswap_get_*', 'uniswap_query_*', 'uniswap_list_*'] },
      { intent: 'write', anyOf: ['uniswap_prepare_*'] },
    ],
    argumentMapper: (intent, input) => intent === 'quote'
      ? { chain: 'base', ...input, quoteOnly: true }
      : { chain: 'base', ...input },
    resultScreener: 'uniswap_quote_or_protocol',
    instructions: [
      'Use only Uniswap-namespaced tools.',
      'Quote intent is read-only: never request calldata, approval, permit, signature, or transaction preparation.',
      'Report route, token decimals, slippage, price impact, and gas only from screened tool output.',
    ],
  },
  {
    namespace: 'moonwell',
    displayName: 'Moonwell',
    allowedIntents: ['read', 'write'],
    requiredTools: [
      { intent: 'read', anyOf: ['moonwell_get_*', 'moonwell_query_*', 'moonwell_list_*'] },
      { intent: 'write', anyOf: ['moonwell_prepare_*'] },
    ],
    argumentMapper: identityMapper,
    resultScreener: 'moonwell',
    instructions: [
      'Use only Moonwell-namespaced tools and never substitute Morpho or another lending protocol.',
      'Treat supply markets, APY, rates, positions, and health as reads unless an amount/funds command is explicit.',
    ],
  },
  {
    namespace: 'morpho',
    displayName: 'Morpho',
    allowedIntents: ['read', 'write'],
    requiredTools: [
      { intent: 'read', anyOf: ['morpho_get_*', 'morpho_query_*', 'morpho_list_*'] },
      { intent: 'write', anyOf: ['morpho_prepare_*'] },
    ],
    argumentMapper: (intent, input) => ({ chain: 'base', ...input, ...(intent === 'read' ? { readOnly: true } : {}) }),
    resultScreener: 'morpho',
    instructions: [
      'Use only Morpho-namespaced tools and Base mainnet data.',
      'Never present unscreened APY, liquidity, vault, or market data as an opportunity.',
    ],
  },
  ...['aerodrome', 'avantis', 'virtuals', 'bankr'].map((namespace): RuntimeSkillDefinition => ({
    namespace,
    displayName: namespace.charAt(0).toUpperCase() + namespace.slice(1),
    allowedIntents: ['read'],
    requiredTools: [{ intent: 'read', anyOf: [`${namespace}_get_*`, `${namespace}_query_*`, `${namespace}_list_*`] }],
    argumentMapper: identityMapper,
    resultScreener: `${namespace}_required`,
    instructions: [`Use only ${namespace}-namespaced read tools. No transaction preparation is allowed in Agent Stream.`],
  })),
];

function toolMatches(pattern: string, toolName: string): boolean {
  if (!pattern.includes('*')) return pattern === toolName;
  const prefix = pattern.slice(0, pattern.indexOf('*'));
  return toolName.startsWith(prefix);
}

export function listRuntimeSkills(): RuntimeSkillDefinition[] {
  return [...SKILLS];
}

export function getRuntimeSkill(namespace: string): RuntimeSkillDefinition | undefined {
  return SKILLS.find((skill) => skill.namespace === namespace.toLowerCase());
}

export function detectRuntimeSkill(message: string): RuntimeSkillDefinition | undefined {
  const lower = message.toLowerCase();
  const explicit = SKILLS.find((skill) => new RegExp(`\\b${skill.namespace}\\b`, 'i').test(lower));
  if (explicit) return explicit;
  if (/\bquote\b|\b(?:route|slippage|gas)\b.*\b(?:usdc|eth|weth)\b/i.test(message)) {
    return getRuntimeSkill('uniswap');
  }
  return undefined;
}

export function runtimeSkillAvailability(input: {
  skill: RuntimeSkillDefinition;
  intent: RuntimeSkillIntent;
  toolNames: string[];
}): { available: boolean; code?: string; matchingTools: string[] } {
  if (!input.skill.allowedIntents.includes(input.intent)) {
    return { available: false, code: `${input.skill.namespace}_intent_not_allowed`, matchingTools: [] };
  }
  const requirement = input.skill.requiredTools.find((item) => item.intent === input.intent);
  if (!requirement) return { available: false, code: `${input.skill.namespace}_intent_unavailable`, matchingTools: [] };
  const matchingTools = input.toolNames.filter((name) => requirement.anyOf.some((pattern) => toolMatches(pattern, name)));
  return matchingTools.length > 0
    ? { available: true, matchingTools }
    : { available: false, code: `${input.skill.namespace}_tools_unavailable`, matchingTools: [] };
}
