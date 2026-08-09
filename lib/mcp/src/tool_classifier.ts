export type BaseMcpToolCapability = 'read_only' | 'user_confirmed_transaction' | 'forbidden' | 'unknown';
export type BaseMcpToolScope = 'wallet' | 'protocol';

export interface BaseMcpToolForClassification {
  name: string;
  description?: string;
}

export interface ClassifiedBaseMcpTool extends BaseMcpToolForClassification {
  capability: BaseMcpToolCapability;
  /** Wallet tools operate on the OAuth account; protocol tools are account-independent reads. */
  scope: BaseMcpToolScope;
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

// T47: these capabilities are meaningful only for the wallet authorized by
// Base MCP OAuth. A protocol-prefixed market/read tool stays protocol-scoped
// even when its name happens to contain a generic word such as "transaction".
const WALLET_SCOPED_TOOLS = new Set([
  'getwallets',
  'getportfolio',
  'gettransactionhistory',
  'send',
  'swap',
  'sendcalls',
  'walletsendcalls',
]);

// What stays forbidden now that signing has been reclassified: key material
// leaving or entering the wallet, and anything that puts an ALREADY-SIGNED
// transaction on the wire. Neither has a Base Account approval step behind it
// — an exported key is gone the moment it is returned, and a raw broadcast has
// nothing left for anyone to approve.
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
  'sendrawtransaction',
  'sendtransaction',
  'signtransaction',
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
  // `signTransaction` is not `sign`. It hands back a signed transaction ready
  // to broadcast, which is the one artefact Miorail must never hold.
  'signtransaction',
];

// ---------------------------------------------------------------------------
// Signing is a user-confirmed action, not a forbidden one.
//
// This list used to route straight to `forbidden`. That rule was written
// against a server signing with a raw key, and then applied to a tool that
// cannot do it: Base MCP's `sign` returns `{ approvalUrl, requestId }` like
// every other write tool, and Base Account shows the user the full message
// content before they approve. The protection the rule was reaching for
// already exists a layer below us, outside our control — which makes it
// stronger than anything this classifier could impose.
//
// Blocking it cost real capability. Several native plugins use `sign` as their
// core tool — SIWE challenges, EIP-712 permits, protocol auth — and none of
// them could work here.
//
// `signtypeddata` moves with it. EIP-712 is what a permit looks like, and the
// approval screen renders structured data in full; if anything it is the more
// legible of the two.
// ---------------------------------------------------------------------------
const SIGNATURE_MARKERS = [
  'personalsign',
  'signmessage',
  'signtypeddata',
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
  const scope: BaseMcpToolScope = WALLET_SCOPED_TOOLS.has(normalized) ? 'wallet' : 'protocol';
  const configuredReadOnly = parseConfiguredNames(process.env.BASE_MCP_READ_ONLY_TOOLS_ALLOWLIST);
  const configuredForbidden = parseConfiguredNames(process.env.BASE_MCP_FORBIDDEN_TOOLS_DENYLIST);

  if (configuredForbidden.has(normalized) || DEFAULT_FORBIDDEN_DENYLIST.has(normalized)) {
    return {
      ...tool,
      scope,
      capability: 'forbidden',
      enabled: false,
      reason: 'forbidden_by_denylist',
    };
  }

  if (FORBIDDEN_MARKERS.some((marker) => normalized.includes(marker))) {
    return {
      ...tool,
      scope,
      capability: 'forbidden',
      enabled: false,
      reason: 'signature_or_broadcast_tool_forbidden',
    };
  }

  if (SIGNATURE_MARKERS.some((marker) => normalized.includes(marker))) {
    return {
      ...tool,
      scope,
      capability: 'user_confirmed_transaction',
      enabled: true,
      reason: 'signature_requires_base_account_approval',
    };
  }

  if (
    DEFAULT_USER_CONFIRMED_TRANSACTION_TOOLS.has(normalized) ||
    (normalized !== 'gettransactionhistory' && TRANSACTION_MARKERS.some((marker) => normalized.includes(marker)))
  ) {
    return {
      ...tool,
      scope,
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
      scope,
      capability: 'read_only',
      enabled: true,
      reason: configuredReadOnly.has(normalized) ? 'read_only_env_allowlist' : 'read_only_allowlist',
    };
  }

  return {
    ...tool,
    scope,
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
