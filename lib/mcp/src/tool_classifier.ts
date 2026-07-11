export type BaseMcpToolCapability = 'read_only' | 'user_confirmed_transaction' | 'forbidden' | 'unknown';

export interface BaseMcpToolForClassification {
  name: string;
  description?: string;
}

export interface ClassifiedBaseMcpTool extends BaseMcpToolForClassification {
  capability: BaseMcpToolCapability;
  enabled: boolean;
  reason: string;
}

export interface BaseMcpToolCapabilityCounts {
  readOnly: number;
  userConfirmedTransaction: number;
  forbidden: number;
  unknown: number;
}

export interface BaseMcpToolClassificationResult {
  capabilities: BaseMcpToolCapabilityCounts;
  tools: ClassifiedBaseMcpTool[];
}

const DEFAULT_READ_ONLY_ALLOWLIST = new Set([
  'checkbalance',
  'checkbalances',
  'getaccount',
  'getaddress',
  'getbalance',
  'getbalances',
  'getbasestatus',
  'getchainid',
  'gethistory',
  'getportfolio',
  'getprice',
  'getprices',
  'gettoken',
  'gettokenbalance',
  'gettokenbalances',
  'gettokenprice',
  'gettransaction',
  'gettransactions',
  'getwallet',
  'getwallets',
  'listaccounts',
  'listbalances',
  'listhistory',
  'listportfolio',
  'listtokens',
  'listtransactions',
  'listwallets',
  'quote',
  'quoteprice',
  'quoteswap',
  'readcontract',
  'searchtokens',
  'simulatetrade',
]);

const READ_ONLY_PREFIXES = [
  'check',
  'describe',
  'estimate',
  'fetch',
  'get',
  'inspect',
  'list',
  'lookup',
  'quote',
  'query',
  'read',
  'resolve',
  'search',
  'simulate',
  'view',
];

const DEFAULT_USER_CONFIRMED_TRANSACTION_TOOLS = new Set([
  'send',
  'sendcalls',
  'sepoliasendcalls',
  'walletsendcalls',
  'walletsendcall',
]);

const DEFAULT_FORBIDDEN_DENYLIST = new Set([
  'broadcast',
  'broadcasttransaction',
  'deploycontract',
  'ethsendrawtransaction',
  'ethsendtransaction',
  'exportkey',
  'exportprivatekey',
  'importkey',
  'importprivatekey',
  'personal_sign',
  'personalsign',
  'sendrawtransaction',
  'sendtransaction',
  'sign',
  'signmessage',
  'signtransaction',
  'signtypeddata',
  'walletsign',
]);

const FORBIDDEN_MARKERS = [
  'broadcast',
  'deploycontract',
  'exportkey',
  'exportprivatekey',
  'importkey',
  'importprivatekey',
  'privatekey',
  'sendrawtransaction',
  'sendtransaction',
  'signtypeddata',
  'signtransaction',
];

const SIGNATURE_MARKERS = [
  'personalsign',
  'signmessage',
  'signature',
  'walletsign',
];

const TRANSACTION_MARKERS = [
  'approve',
  'bridge',
  'buy',
  'claim',
  'deposit',
  'mint',
  'pay',
  'purchase',
  'repay',
  'revoke',
  'sell',
  'sendcalls',
  'sepoliasendcalls',
  'stake',
  'swap',
  'transfer',
  'unstake',
  'walletsendcalls',
  'withdraw',
];

function parseConfiguredNames(value?: string): Set<string> {
  return new Set(
    (value || '')
      .split(/[,\s]+/)
      .map((entry) => normalizeToolName(entry))
      .filter(Boolean),
  );
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasNamespacedReadVerb(name: string): boolean {
  const segments = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return segments.some((segment, index) => index > 0 && READ_ONLY_PREFIXES.some(
    (prefix) => segment === prefix || segment.startsWith(prefix),
  ));
}

function capabilityCounts(): BaseMcpToolCapabilityCounts {
  return {
    readOnly: 0,
    userConfirmedTransaction: 0,
    forbidden: 0,
    unknown: 0,
  };
}

function classifyTool(tool: BaseMcpToolForClassification): ClassifiedBaseMcpTool {
  const normalized = normalizeToolName(tool.name);
  const configuredReadOnly = parseConfiguredNames(process.env.BASE_MCP_READ_ONLY_TOOLS_ALLOWLIST);
  const configuredForbidden = parseConfiguredNames(process.env.BASE_MCP_FORBIDDEN_TOOLS_DENYLIST);

  if (configuredForbidden.has(normalized) || DEFAULT_FORBIDDEN_DENYLIST.has(normalized)) {
    return {
      ...tool,
      capability: 'forbidden',
      enabled: false,
      reason: 'forbidden_by_denylist',
    };
  }

  if (FORBIDDEN_MARKERS.some((marker) => normalized.includes(marker))) {
    return {
      ...tool,
      capability: 'forbidden',
      enabled: false,
      reason: 'signature_or_broadcast_tool_forbidden',
    };
  }

  if (SIGNATURE_MARKERS.some((marker) => normalized.includes(marker))) {
    return {
      ...tool,
      capability: 'forbidden',
      enabled: false,
      reason: 'signature_tool_forbidden',
    };
  }

  if (
    DEFAULT_USER_CONFIRMED_TRANSACTION_TOOLS.has(normalized) ||
    TRANSACTION_MARKERS.some((marker) => normalized.includes(marker))
  ) {
    return {
      ...tool,
      capability: 'user_confirmed_transaction',
      enabled: false,
      reason: 'transaction_tool_user_confirmation_required',
    };
  }

  if (
    configuredReadOnly.has(normalized) ||
    DEFAULT_READ_ONLY_ALLOWLIST.has(normalized) ||
    READ_ONLY_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    hasNamespacedReadVerb(tool.name)
  ) {
    return {
      ...tool,
      capability: 'read_only',
      enabled: true,
      reason: configuredReadOnly.has(normalized) ? 'read_only_env_allowlist' : 'read_only_allowlist',
    };
  }

  return {
    ...tool,
    capability: 'unknown',
    enabled: false,
    reason: 'unknown_tool_disabled_by_default',
  };
}

export function emptyBaseMcpToolCapabilityCounts(): BaseMcpToolCapabilityCounts {
  return capabilityCounts();
}

export function classifyBaseMcpTools(tools: BaseMcpToolForClassification[]): BaseMcpToolClassificationResult {
  const capabilities = capabilityCounts();
  const classified = tools.map((tool) => {
    const item = classifyTool(tool);
    if (item.capability === 'read_only') capabilities.readOnly += 1;
    else if (item.capability === 'user_confirmed_transaction') capabilities.userConfirmedTransaction += 1;
    else if (item.capability === 'forbidden') capabilities.forbidden += 1;
    else capabilities.unknown += 1;
    return item;
  });

  return {
    capabilities,
    tools: classified,
  };
}
