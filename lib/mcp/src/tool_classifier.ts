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
  // A JSON-RPC dispatcher, and the one read tool whose capability lives in an
  // argument rather than in its name. Base accepts read methods only; we do
  // not take that on trust — see `baseMcpReadOnlyArgumentGuardV1`.
  'chainrpcrequest',
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
  // Returns guidance text about which plugin covers a task. It is also how the
  // catalogue is discovered — `web_request` tells the model to call it when it
  // does not know which skill applies.
  'help',
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
  // The fetch primitive every HTTP plugin is built on: without it the twenty
  // plugins on the Extensions page are a catalogue of things we cannot reach.
  // Base allowlists the hostname and strips Authorization/Cookie; we add the
  // method restriction, because a POST is not a read.
  'webrequest',
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
  // Returns an EIP-681 payment link and a QR code for topping the wallet up.
  // Nothing is signed and no approval screen appears — which is exactly why it
  // does not belong with the reads. The artefact it produces is a payment
  // instruction the user acts on with their own money, and an AI that renders
  // one has done something a read never does.
  'fund',
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
  // The x402 pair and `fund` move the authorized account's USDC or top it up;
  // `sign` produces a signature from it. All four are meaningless — and must
  // not run — when Base MCP is bound to a different wallet than the one the
  // user is looking at.
  'completex402request',
  'fund',
  'getwallets',
  'getportfolio',
  'gettransactionhistory',
  'initiatex402request',
  'send',
  'sign',
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
// The markers below are substrings, and none of them is a substring of the one
// name Base MCP actually publishes: `sign`. So the rule above described a tool
// it never reached, and `sign` fell through to `unknown` — uncallable, and
// filed under "we do not know what this is" rather than "this needs your
// approval". Exact names are matched first for that reason; a bare `sign`
// cannot be a substring rule without also catching `design` and `assign`.
const DEFAULT_SIGNATURE_TOOLS = new Set([
  'personalsign',
  'sign',
  'signmessage',
  'signtypeddata',
  'walletsign',
]);

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
  // x402 is a payment protocol; `initiate_x402_request` and
  // `complete_x402_request` spend the user's USDC behind a Base Account
  // approval. Matching the protocol rather than the two current names means a
  // third x402 tool arrives already classified instead of arriving as unknown.
  'x402',
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

  if (
    DEFAULT_SIGNATURE_TOOLS.has(normalized) ||
    SIGNATURE_MARKERS.some((marker) => normalized.includes(marker))
  ) {
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

// ---------------------------------------------------------------------------
// Two read tools carry their capability in an argument, not in their name.
//
// `chain_rpc_request` dispatches a JSON-RPC method and `web_request` dispatches
// an HTTP verb. Base states that the first accepts read methods only, and that
// is very likely true — but a boundary we describe as structural cannot rest on
// somebody else's enforcement of it. Everything a name-based classifier can say
// about these two is "it depends on the call".
//
// So the classifier calls them read-only and this decides, per call, whether
// the call is one. Fail closed: an unrecognised method is refused, because the
// alternative is a denylist that is wrong the day a new method ships.
// ---------------------------------------------------------------------------

/** Read namespaces. `eth_get*` is a family with no writing member; everything
 * outside this pattern — `eth_sendRawTransaction`, `eth_sign`, `personal_*`,
 * `debug_*`, `admin_*`, `miner_*`, `txpool_*` — is refused. */
const CHAIN_RPC_READ_METHOD_V1 =
  /^(?:eth_(?:call|chainId|blockNumber|estimateGas|feeHistory|gasPrice|maxPriorityFeePerGas|syncing|get[A-Za-z]+)|net_(?:version|listening|peerCount)|web3_clientVersion)$/;

export interface BaseMcpArgumentVerdictV1 {
  allowed: boolean;
  /** Typed, so a refusal reads as a rule rather than as a broken tool. */
  errorCode?: string;
  reason?: string;
}

const ALLOWED_V1: BaseMcpArgumentVerdictV1 = { allowed: true };

export function baseMcpReadOnlyArgumentGuardV1(
  toolName: string,
  args: Record<string, unknown> | undefined,
): BaseMcpArgumentVerdictV1 {
  const normalized = normalizeToolName(toolName);
  const input = args ?? {};

  if (normalized === 'chainrpcrequest') {
    const method = typeof input.method === 'string' ? input.method.trim() : '';
    if (!method) {
      return {
        allowed: false,
        errorCode: 'base_mcp_rpc_method_missing',
        reason: 'chain_rpc_request needs an explicit read method.',
      };
    }
    if (!CHAIN_RPC_READ_METHOD_V1.test(method)) {
      return {
        allowed: false,
        errorCode: 'base_mcp_rpc_method_not_read_only',
        reason: `${method} is not a read method. This surface calls read methods only; writes go through the Routes flow.`,
      };
    }
    return ALLOWED_V1;
  }

  if (normalized === 'webrequest') {
    const method = typeof input.method === 'string' ? input.method.trim().toUpperCase() : 'GET';
    if (method !== 'GET') {
      return {
        allowed: false,
        errorCode: 'base_mcp_web_request_not_get',
        reason: `web_request is limited to GET here; ${method} can change state on the partner API.`,
      };
    }
    return ALLOWED_V1;
  }

  return ALLOWED_V1;
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
