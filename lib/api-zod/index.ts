import { z } from 'zod';

// Shared
export const PaginationParamsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().optional(),
});

// Auth
export const LoginRequestSchema = z.object({
  message: z.string(),
  signature: z.string(),
});

export const LoginResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    address: z.string(),
  }),
});

export const SessionResponseSchema = z.object({
  user: z
    .object({
      id: z.string(),
      address: z.string(),
    })
    .nullable(),
});

// Chat
export const ChatMessageRequestSchema = z.object({
  message: z.string().min(1),
  chatId: z.string().optional(),
  walletAddress: z.string().optional(),
  chainEnv: z.string().optional(),
});

export const ChatMessageResponseSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
  content: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  createdAt: z.string(),
  actionId: z.string().optional(),
  toolCalls: z.array(z.record(z.any())).optional(),
  metadata: z.record(z.any()).optional(),
});

export const ChatHistoryResponseSchema = z.object({
  messages: z.array(ChatMessageResponseSchema),
  nextCursor: z.string().optional(),
});

export const ChatListResponseSchema = z.object({
  chats: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  nextCursor: z.string().optional(),
});

// Actions
// T19.1: the only onchain action types the user-confirmed flow may surface in
// production. `revoke_approval` (ERC-20 approve(spender,0)) is the preferred
// first mainnet action — no funds move. `limited_transfer` is a bounded USDC
// transfer (capped server-side by MAX_LIMITED_TRANSFER_USDC). Anything else
// stays a read-only recommendation with no confirm button.
export const ProductionActionTypeSchema = z.enum(['revoke_approval', 'limited_transfer']);
export const PRODUCTION_ACTION_TYPES = ProductionActionTypeSchema.options as readonly [
  'revoke_approval',
  'limited_transfer',
];
export function isProductionActionType(t?: string | null): boolean {
  return t === 'revoke_approval' || t === 'limited_transfer';
}

export const ExecutionPayloadSchema = z.object({
  chain: z.string(),
  // T19.1: present only for whitelisted production action types; absent on
  // read-only plans. The UI gates the confirm button on isProductionActionType.
  actionType: ProductionActionTypeSchema.optional(),
  calls: z.array(
    z.object({
      to: z.string(),
      value: z.string().optional(),
      data: z.string().optional(),
    })
  ),
});

export const ActionResponseSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.enum(['pending', 'pending_confirmation', 'submitted_unknown', 'executed', 'dismissed', 'failed', 'cancelled']),
  suggestedPrompt: z.string().nullable(),
  tokens: z.array(z.string()).optional(),
  executionPayload: ExecutionPayloadSchema.optional().nullable(),
  metadata: z.record(z.any()).optional().nullable(),
  txHash: z.string().optional(),
  batchId: z.string().optional(),
  receipts: z.array(z.record(z.any())).optional(),
  createdAt: z.string(),
  executedAt: z.string().nullable(),
});

export const ActionsFeedResponseSchema = z.object({
  actions: z.array(ActionResponseSchema),
  nextCursor: z.string().optional(),
});

export const ExecuteActionRequestSchema = z.object({
  actionId: z.string(),
});

export const ExecuteActionResponseSchema = z.object({
  success: z.boolean(),
  txHash: z.string().optional(),
  requestId: z.string().optional(),
  approvalUrl: z.string().optional(),
  error: z.string().optional(),
});

// T19: user-confirmed flow. `prepare` returns an UNSIGNED EIP-5792 payload the
// client submits via Base Account `wallet_sendCalls`. The server never
// broadcasts and never reads MAINNET_EXECUTION_ENABLED for these routes.
export const SecurityScreeningSchema = z.object({
  screenedAt: z.string(),
  allowed: z.boolean(),
  verdict: z.string(),
  reason: z.string().optional(),
  checks: z.array(z.object({ name: z.string(), status: z.string() })).optional(),
});

export const SimulationResultSchema = z.object({
  success: z.boolean(),
  allowed: z.boolean(),
  riskLevel: z.string(),
  reason: z.string().optional(),
  error: z.string().optional(),
  estimatedGas: z.string().optional(),
  expectedOutput: z.string().optional(),
  checks: z.array(z.string()),
  method: z.string().optional(),
  projections: z.array(z.object({
    kind: z.string(),
    token: z.string(),
    spender: z.string().optional(),
    recipient: z.string().optional(),
    amountRaw: z.string().optional(),
    allowanceAfter: z.string().optional(),
    balanceDelta: z.string().optional(),
  })).optional(),
});

export const PrepareActionRequestSchema = z.object({
  actionId: z.string(),
});

export const PrepareActionResponseSchema = z.object({
  success: z.boolean(),
  actionId: z.string(),
  // EIP-5792 batch target. Base Mainnet = '0x2105'.
  chainId: z.string(),
  from: z.string().nullable().optional(),
  calls: z.array(z.object({
    to: z.string(),
    value: z.string().optional(),
    data: z.string().optional(),
  })),
  atomicRequired: z.boolean(),
  // T19.1: the whitelisted action type this batch encodes (revoke_approval |
  // limited_transfer). The client gates the confirm button on this.
  actionType: ProductionActionTypeSchema.optional(),
  // Live-rederived verdicts (advisory echo; the route re-runs both and gates on them).
  screening: SecurityScreeningSchema,
  simulation: SimulationResultSchema,
  // True when a Builder Code dataSuffix will be attached client-side.
  builderCodeAttached: z.boolean(),
  error: z.string().optional(),
});

export const ConfirmActionRequestSchema = z.object({
  actionId: z.string(),
  // EIP-5792 batch id returned by wallet_sendCalls. Can be empty string/null if failed/cancelled before batch id assignment.
  batchId: z.string().nullable().optional().default(''),
  // EIP-5792 status code (200 = success, 400/500/600 = failure, 4001 = cancelled, 102 = pending_confirmation).
  status: z.number(),
  txHash: z.string().nullable().optional(),
  receipts: z.array(z.record(z.any())).nullable().optional(),
  proof: z.record(z.any()).nullable().optional(),
  error: z.string().nullable().optional(),
});

export const ConfirmActionResponseSchema = z.object({
  success: z.boolean(),
  status: z.enum(['executed', 'failed', 'pending_confirmation', 'submitted_unknown', 'cancelled']),
  txHash: z.string().nullable().optional(),
  error: z.string().optional(),
});

export const BaseMcpToolProbeResponseSchema = z.object({
  status: z.enum(['connected', 'needs_reauth', 'unreachable', 'degraded']),
  endpointHost: z.string().optional(),
  toolsCount: z.number(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
  })),
  checkedAt: z.string(),
  errorCode: z.string().optional(),
});

export const DismissActionRequestSchema = z.object({
  actionId: z.string(),
});

export const DismissActionResponseSchema = z.object({
  success: z.boolean(),
});

export const DismissAllRecommendationsResponseSchema = z.object({
  success: z.boolean(),
  count: z.number().optional(),
});

export const DeleteRecommendationsResponseSchema = z.object({
  success: z.boolean(),
  count: z.number().optional(),
});

export const DeleteSingleActionResponseSchema = z.object({
  success: z.boolean(),
});

export const RegenerateRecommendationResponseSchema = z.object({
  success: z.boolean(),
  actionId: z.string().optional(),
  error: z.string().optional(),
});

// Memory
export const MemoryResponseSchema = z.object({
  memoryMd: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const UpdateMemoryRequestSchema = z.object({
  memoryMd: z.string(),
});

export const UpdateMemoryResponseSchema = MemoryResponseSchema;

// Settings
export const SettingsResponseSchema = z.object({
  chosenModel: z.string().nullable(),
  protocolToggles: z.record(z.string(), z.boolean()).nullable(),
  updatedAt: z.string().nullable(),
});

export const UpdateSettingsRequestSchema = z.object({
  chosenModel: z.string().optional(),
  protocolToggles: z.record(z.string(), z.boolean()).optional(),
});

export const UpdateSettingsResponseSchema = SettingsResponseSchema;

// Protocols
export const ProtocolSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  status: z.string().optional(),
});

export const ProtocolsListResponseSchema = z.object({
  protocols: z.array(ProtocolSchema),
});

export const ToggleProtocolRequestSchema = z.object({
  protocolId: z.string(),
  enabled: z.boolean(),
});

export const ToggleProtocolResponseSchema = z.object({
  success: z.boolean(),
});

// Portfolio
export const PortfolioTokenSecuritySchema = z.object({
  provider: z.enum(["goplus", "none"]),
  status: z.enum(["ok", "warning", "high-risk", "unknown", "failed"]),
  summary: z.string().optional(),
  riskLabels: z.array(z.string()).optional(),
  flags: z.object({
    isHoneypot: z.boolean().optional(),
    isMintable: z.boolean().optional(),
    isProxy: z.boolean().optional(),
    isOpenSource: z.boolean().optional(),
    hiddenOwner: z.boolean().optional(),
    canTakeBackOwnership: z.boolean().optional(),
    ownerCanChangeBalance: z.boolean().optional(),
    hasBlacklist: z.boolean().optional(),
    hasWhitelist: z.boolean().optional(),
    tradingCooldown: z.boolean().optional(),
    selfdestruct: z.boolean().optional(),
    externalCall: z.boolean().optional(),
    buyTax: z.string().optional(),
    sellTax: z.string().optional(),
    cannotSellAll: z.boolean().optional(),
    isInDex: z.boolean().optional(),
    holderCount: z.string().optional(),
  }).optional(),
});

export const PortfolioTokenSchema = z.object({
  symbol: z.string(),
  name: z.string().optional(),
  address: z.string(),
  balance: z.string(),
  balanceFormatted: z.string(),
  decimals: z.number().optional(),
  usdValue: z.string().optional(),
  usdPrice: z.string().optional(),
  priceConfidence: z.enum(["high", "medium", "low", "unknown"]).optional(),
  logoUrl: z.string().optional(),
  verified: z.boolean().optional(),
  possibleSpam: z.boolean().optional(),
  security: PortfolioTokenSecuritySchema.optional(),
  dataFreshness: z.enum(["live", "cached"]).optional(),
});

export const PortfolioProvidersSchema = z.object({
  rpc: z.enum(["connected", "missing", "failed"]),
  tokenBalances: z.enum(["connected", "missing", "failed", "stale", "disabled", "rate_limited"]),
  tokenBalancesProvider: z.enum(["moralis", "alchemy", "mock", "none"]).optional(),
  prices: z.enum(["connected", "missing", "failed", "partial", "disabled"]),
  priceProvider: z.enum(["coingecko", "moralis", "mock", "none"]).optional(),
  risk: z.enum(["connected", "missing", "failed", "partial", "disabled"]),
  riskProvider: z.enum(["goplus", "none"]).optional(),
  approvals: z.enum(["connected", "missing", "failed", "partial", "disabled", "rate_limited", "budget_exhausted", "temporarily_unavailable"]).optional(),
  approvalProvider: z.enum(["moralis", "alchemy", "mock", "none"]).optional(),
});


export const ProviderCallSummaryItemSchema = z.object({
  provider: z.string(),
  status: z.string(),
  providerCalled: z.boolean(),
  budgetExhausted: z.boolean(),
  cacheAgeSeconds: z.number().optional(),
  requested: z.boolean().optional(),
  errorCode: z.string().optional(),
  note: z.string().optional(),
});

export const ApprovalScanSummarySchema = ProviderCallSummaryItemSchema.extend({
  requested: z.boolean(),
  totalApprovals: z.number(),
  tokenCount: z.number(),
  unlimitedCount: z.number(),
  riskySpenderCount: z.number(),
});

export const PortfolioResponseSchema = z.object({
  totalUsdValue: z.string().optional(),
  tokens: z.array(PortfolioTokenSchema),
  updatedAt: z.string(),
  providerStatus: z.string().optional(),
  dataFreshness: z.enum(["live", "cached", "stale", "partial", "failed"]).optional(),
  cacheAgeSeconds: z.number().optional(),
  providerBudgetStatus: z.object({
    exhausted: z.boolean(),
    providers: z.array(z.string()),
  }).optional(),
  providerCallsMade: z.number().optional(),
  providers: PortfolioProvidersSchema.optional(),
  providerCallSummary: z.record(ProviderCallSummaryItemSchema).optional(),
  providerContext: z.record(z.any()).optional(),
  approvalScan: ApprovalScanSummarySchema.optional(),
  approvalSummary: z.record(z.any()).optional(),
  approvalFindings: z.array(z.record(z.any())).optional(),
  approvals: z.array(z.record(z.any())).optional(),
  analysis: z.record(z.any()).optional(),
});

export const TokenApprovalSchema = z.object({
  tokenAddress: z.string(),
  tokenSymbol: z.string(),
  tokenName: z.string().optional(),
  spenderAddress: z.string(),
  spenderLabel: z.string().optional(),
  allowanceRaw: z.string(),
  allowanceFormatted: z.string(),
  allowanceUsd: z.number().optional(),
  isUnlimited: z.boolean(),
  lastUpdatedAt: z.string().optional(),
  source: z.enum(["moralis", "alchemy", "basescan", "none", "mock", "unknown"]),
});

export const ApprovalsResponseSchema = z.object({
  approvals: z.array(TokenApprovalSchema),
  status: z.enum(["connected", "missing", "failed", "partial", "disabled", "rate_limited", "budget_exhausted", "temporarily_unavailable"]),
  provider: z.string(),
  tokenCount: z.number(),
  unlimitedCount: z.number(),
  riskySpenderCount: z.number(),
});

export const StatusResponseSchema = z.object({
  chainEnv: z.string(),
  chainId: z.number(),
  rpc: z.object({
    status: z.enum(["connected", "missing", "failed"]),
    provider: z.string(),
  }),
  tokenBalances: z.object({
    status: z.enum(["connected", "missing", "failed", "stale", "disabled"]),
    provider: z.string(),
  }),
  prices: z.object({
    status: z.enum(["connected", "missing", "failed", "partial", "disabled"]),
    provider: z.string(),
  }),
  risk: z.object({
    status: z.enum(["connected", "missing", "failed", "partial", "disabled"]),
    provider: z.string(),
  }),
  approvals: z.object({
    status: z.enum(["connected", "missing", "failed", "partial", "disabled", "rate_limited", "budget_exhausted", "temporarily_unavailable", "auth_or_budget_issue"]),
    provider: z.string(),
  }),
  cache: z.object({
    enabled: z.boolean(),
    balancesTtlSeconds: z.number(),
    pricesTtlSeconds: z.number(),
    securityTtlSeconds: z.number(),
    approvalsTtlSeconds: z.number(),
  }).optional(),
  budgets: z.record(z.string(), z.object({
    provider: z.string().optional(),
    status: z.enum(["ok", "rate-limited", "disabled", "rate_limited", "budget_exhausted", "auth_or_budget_issue"]),
    callsLastMinute: z.number(),
    callsLastHour: z.number(),
    budgetExhausted: z.boolean().optional(),
    lastErrorCode: z.string().optional(),
    lastErrorAt: z.string().optional(),
    cooldownUntil: z.string().optional(),
  })).optional(),
  baseMcp: z.object({
    status: z.enum(["missing", "disabled", "connected", "needs_reauth", "unreachable", "degraded", "unsupported"]),
    provider: z.literal("base-mcp"),
    configured: z.boolean(),
    enabled: z.boolean(),
    endpointHost: z.string().optional(),
    lastCheckedAt: z.string().optional(),
    errorCode: z.string().optional(),
    capabilities: z.object({
      toolsCount: z.number().optional(),
      resourcesCount: z.number().optional(),
    }).optional(),
    toolsCount: z.number().optional(),
    lastToolProbeAt: z.string().optional(),
    auth: z.object({
      connected: z.boolean(),
      needsReauth: z.boolean(),
      userScoped: z.literal(true),
      expiresAt: z.string().optional(),
      connectedAt: z.string().optional(),
    }).optional(),
  }),
  x402: z.object({
    status: z.enum(["simulated", "configured", "missing"]),
  }),
  // T19.1: split into explicit flags. The UI may show "Confirm in Base Account"
  // ONLY when userConfirmedEnabled is true, and must never infer "Execute" from
  // a single generic flag. Legacy server-broadcast routes gate on
  // serverBroadcastEnabled / mainnetExecutionEnabled, never on userConfirmedEnabled.
  execution: z.object({
    mode: z.enum(['read-only', 'user-confirmed', 'server-execution']),
    // Base Account wallet_sendCalls flow is available.
    userConfirmedEnabled: z.boolean(),
    // Legacy /execute server-broadcast capability (testnet, or mainnet+flag).
    serverBroadcastEnabled: z.boolean(),
    // === MAINNET_EXECUTION_ENABLED === 'true'. Stays false in production.
    mainnetExecutionEnabled: z.boolean(),
    // Back-compat alias === serverBroadcastEnabled.
    broadcastEnabled: z.boolean().optional(),
    reason: z.string(),
  }),
});

// Workflows
export const WorkflowSchema = z.object({
  id: z.string(),
  instructions: z.string().nullable(),
  toolAllowlist: z.array(z.string()).nullable().optional(),
  intervalMs: z.number().nullable(),
  lastRun: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const WorkflowsListResponseSchema = z.object({
  workflows: z.array(WorkflowSchema),
});

export const CreateWorkflowRequestSchema = z.object({
  instructions: z.string().min(1),
  intervalMs: z.number().int().min(60000), // Min 1 minute
});

export const CreateWorkflowResponseSchema = z.object({
  success: z.boolean(),
  workflow: WorkflowSchema,
});

export const DeleteWorkflowRequestSchema = z.object({
  workflowId: z.string(),
});

export const DeleteWorkflowResponseSchema = z.object({
  success: z.boolean(),
});

// Autonomy
export const AutonomyStateResponseSchema = z.object({
  status: z.enum(['active', 'inactive', 'unconfigured', 'configured', 'revoked', 'expired']),
  source: z.enum(['memory', 'onchain', 'base-sepolia-contract', 'missing']),
  isStaleTestMemory: z.boolean().optional(),
  isExpiredMemory: z.boolean().optional(),
  chainId: z.number().optional(),
  contractAddress: z.string().nullable().optional(),
  sessionKey: z.object({
    status: z.enum(['configured', 'unconfigured', 'inactive', 'revoked', 'expired', 'active']),
    source: z.enum(['memory', 'onchain', 'base-sepolia-contract', 'missing']).optional(),
    isStaleTestMemory: z.boolean().optional(),
    isExpiredMemory: z.boolean().optional(),
    dailyLimitUsdc: z.string().nullable(),
    spentTodayUsdc: z.string(),
    maxPerActionUsdc: z.string().nullable(),
    ttlSeconds: z.number().nullable(),
    expiresAt: z.string().nullable(),
    whitelist: z.array(z.string()),
    scope: z.string(),
    killSwitch: z.boolean(),
    owner: z.string().nullable().optional(),
    executor: z.string().nullable().optional(),
    token: z.string().nullable().optional(),
    validUntil: z.union([z.number(), z.string()]).nullable().optional(),
    txHashLastConfigured: z.string().nullable().optional(),
    txHashLastRevoked: z.string().nullable().optional(),
  }),
  autonomy: z.object({
    dailySpendLimit: z.string().nullable(),
    maxActionSpend: z.string().nullable(),
    whitelistedProtocolsCount: z.number(),
    mode: z.string(),
    source: z.enum(['memory', 'onchain', 'base-sepolia-contract', 'missing']),
    isStaleTestMemory: z.boolean().optional(),
    isExpiredMemory: z.boolean().optional(),
  }),
});

export const ConfigureAutonomyRequestSchema = z.object({
  dailyLimitUsdc: z.string(),
  maxPerActionUsdc: z.string(),
  whitelist: z.array(z.string()),
  scope: z.string().optional(),
  ttlSeconds: z.number(),
});

export const ConfigureAutonomyResponseSchema = z.object({
  success: z.boolean(),
  state: AutonomyStateResponseSchema,
  txHash: z.string().optional(),
});

export const KillAutonomyResponseSchema = z.object({
  success: z.boolean(),
  state: AutonomyStateResponseSchema,
  txHash: z.string().optional(),
});

export const TestnetConfigureAutonomyRequestSchema = z.object({
  dailyLimitUsdc: z.string(),
  maxPerActionUsdc: z.string(),
  whitelist: z.array(z.string()),
  ttlSeconds: z.number(),
  executor: z.string().optional(),
  token: z.string().optional(),
  owner: z.string().optional(),
});

export const TestnetRevokeAutonomyRequestSchema = z.object({
  executor: z.string().optional(),
  token: z.string().optional(),
  owner: z.string().optional(),
});

export const TestnetExecuteActionRequestSchema = z.object({
  target: z.string(),
  amountUsdc: z.string(),
  owner: z.string().optional(),
  token: z.string().optional(),
});

// x402 Ledger & Pricing
export const X402LedgerEntrySchema = z.object({
  id: z.string(),
  actionId: z.string(),
  actionType: z.string(),
  cost: z.string().nullable(),
  txHash: z.string().nullable(),
  createdAt: z.string(),
  settlement: z.string().optional(),
  details: z.record(z.any()).optional().nullable(),
});

export const X402LedgerResponseSchema = z.object({
  entries: z.array(X402LedgerEntrySchema),
  summary: z.object({
    totalSpentUsdc: z.string(),
    inferenceSpentUsdc: z.string(),
    toolsSpentUsdc: z.string(),
    inferenceCallsCount: z.number(),
    toolsCallsCount: z.number(),
    settlement: z.string().optional(),
  }),
});

export const X402PricingResponseSchema = z.object({
  pricing: z.array(
    z.object({
      actionType: z.string(),
      label: z.string(),
      priceUsdc: z.string(),
      description: z.string(),
    })
  ),
});

// Simulate Action
export const SimulateActionResponseSchema = z.object({
  success: z.boolean(),
  allowed: z.boolean(),
  riskLevel: z.string(),
  reason: z.string().optional(),
  error: z.string().optional(),
  estimatedGas: z.string().optional(),
  expectedOutput: z.string().optional(),
  checks: z.array(z.string()),
});
