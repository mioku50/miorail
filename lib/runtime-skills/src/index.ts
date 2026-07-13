export type RuntimeSkillIntent = 'quote' | 'read' | 'write';

export interface RuntimeSkillToolRequirement {
  intent: RuntimeSkillIntent;
  anyOf: string[];
}

// T48b: structured manifest for plugins that are reached through the
// server-side `plugin_http_request` gateway (artifacts/api-server/lib/
// pluginHttpGateway.ts) instead of (or in addition to) live MCP tools. This is
// the source of truth the gateway uses to enforce host/method/path/chain
// before any network call — never parsed from the vendored `.md` (no YAML
// dependency); the `.md` frontmatter remains human documentation only. Only
// plugins with an HTTP-reachable surface (Uniswap, Moonwell) carry a
// manifest; MCP-only read skills do not need one.
export interface RuntimeSkillManifest {
  integration: 'http-api' | 'mcp' | 'cli';
  chains: number[];
  allowlist: { hosts: string[]; methods: ('GET' | 'POST')[]; pathPrefixes: string[] };
  auth: 'none' | 'api-key';
  risk: string[];
}

export interface RuntimeSkillDefinition {
  namespace: string;
  displayName: string;
  allowedIntents: RuntimeSkillIntent[];
  requiredTools: RuntimeSkillToolRequirement[];
  argumentMapper: (intent: RuntimeSkillIntent, input: Record<string, unknown>) => Record<string, unknown>;
  resultScreener: string;
  instructions: string[];
  manifest?: RuntimeSkillManifest;
}

const identityMapper = (_intent: RuntimeSkillIntent, input: Record<string, unknown>) => ({ ...input });

const SKILLS: RuntimeSkillDefinition[] = [
  {
    namespace: 'uniswap',
    displayName: 'Uniswap',
    allowedIntents: ['quote', 'read'],
    requiredTools: [
      { intent: 'quote', anyOf: ['uniswap_quote'] },
      { intent: 'read', anyOf: ['uniswap_get_*', 'uniswap_query_*', 'uniswap_list_*'] },
    ],
    argumentMapper: (intent, input) => intent === 'quote'
      ? { chain: 'base', ...input, quoteOnly: true }
      : { chain: 'base', ...input },
    resultScreener: 'uniswap_quote_or_protocol',
    // source: lib/runtime-skills/plugins/uniswap.md (base/skills)
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: {
        hosts: ['trade-api.gateway.uniswap.org', 'liquidity.api.uniswap.org'],
        methods: ['GET', 'POST'],
        pathPrefixes: ['/v1/check_approval', '/v1/quote', '/v1/swap', '/lp/'],
      },
      auth: 'api-key',
      risk: ['slippage'],
    },
    instructions: [
      'Use only Uniswap-namespaced tools on Base mainnet (chainId 8453).',
      'Quote intent is read-only for the LLM: never request calldata, approval, permit, signature, or transaction preparation.',
      'Token amounts are base units: USDC = 1e6, ETH/WETH = 1e18; report decimals only from screened tool output.',
      'Slippage thresholds: <=1% proceed; >1% to 5% ask the user to confirm; >5% to 20% warn about worse fills and sandwich/MEV risk and require explicit confirmation; >20% strongly warn and require the exact number to be re-confirmed.',
      'If the user did not specify slippage, prefer default auto slippage rather than picking a high number.',
      'Normal swap execution uses the Base MCP swap tool and Base Account approval flow; the Uniswap API key is server-side env only and never appears in the repo, tool arguments, or output.',
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
    // source: lib/runtime-skills/plugins/moonwell.md (base/skills)
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: {
        hosts: ['api.moonwell.fi'],
        methods: ['GET', 'POST'],
        pathPrefixes: ['/v1/markets', '/v1/rates', '/v1/positions', '/v1/health', '/v1/rewards', '/v1/token-balance', '/v1/prepare'],
      },
      auth: 'none',
      risk: ['liquidation'],
    },
    instructions: [
      'Use only Moonwell-namespaced tools and never substitute Morpho or another lending protocol.',
      'Treat supply markets, APY, rates, positions, and health as reads unless an amount/funds command is explicit.',
      'Health factor rules: >1.5 healthy, 1.1-1.5 caution, <1.1 liquidation risk, null means no borrows; always read health before a borrow or withdraw and surface the value to the user.',
      'Prepared transactions[] are ordered (approve and enter-market before the protocol action) and must execute as ONE atomic wallet batch, never one by one.',
      'Asset ETH is an alias for WETH: both resolve to the same mWETH market; borrow/withdraw deliver native ETH while supply/repay use ERC-20 WETH.',
      'Base has two mUSDC entries: the current market and a deprecated bridged-USDC market marked deprecated: true — never use the deprecated market.',
      'Use amountDecimal (human-readable string) OR amount (base units), never both, when preparing an action.',
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
