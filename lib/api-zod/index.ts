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
export const ExecutionPayloadSchema = z.object({
  chain: z.string(),
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
  status: z.enum(['pending', 'executed', 'dismissed', 'failed']),
  suggestedPrompt: z.string().nullable(),
  tokens: z.array(z.string()).optional(),
  executionPayload: ExecutionPayloadSchema.optional().nullable(),
  metadata: z.record(z.any()).optional().nullable(),
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
  tokenBalances: z.enum(["connected", "missing", "failed", "stale", "disabled"]),
  tokenBalancesProvider: z.enum(["moralis", "alchemy", "mock", "none"]).optional(),
  prices: z.enum(["connected", "missing", "failed", "partial", "disabled"]),
  priceProvider: z.enum(["coingecko", "moralis", "mock", "none"]).optional(),
  risk: z.enum(["connected", "missing", "failed", "partial", "disabled"]),
  riskProvider: z.enum(["goplus", "none"]).optional(),
  approvals: z.enum(["connected", "missing", "failed", "partial", "disabled"]).optional(),
  approvalProvider: z.enum(["moralis", "alchemy", "mock", "none"]).optional(),
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
});

export const TokenApprovalSchema = z.object({
  tokenAddress: z.string(),
  tokenSymbol: z.string(),
  tokenName: z.string().optional(),
  spenderAddress: z.string(),
  spenderLabel: z.string().optional(),
  allowanceRaw: z.string(),
  allowanceFormatted: z.string(),
  isUnlimited: z.boolean(),
  lastUpdatedAt: z.string().optional(),
  source: z.enum(["moralis", "alchemy", "none", "mock", "unknown"]),
});

export const ApprovalsResponseSchema = z.object({
  approvals: z.array(TokenApprovalSchema),
  status: z.enum(["connected", "missing", "failed", "partial", "disabled"]),
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
    status: z.enum(["connected", "missing", "failed", "partial", "disabled"]),
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
    status: z.enum(["ok", "rate-limited", "disabled"]),
    callsLastMinute: z.number(),
    callsLastHour: z.number(),
  })).optional(),
  baseMcp: z.object({
    status: z.enum(["configured", "missing"]),
  }),
  x402: z.object({
    status: z.enum(["simulated", "configured", "missing"]),
  }),
  execution: z.object({
    mode: z.string(),
    enabled: z.boolean(),
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
  chainId: z.number().optional(),
  contractAddress: z.string().nullable().optional(),
  sessionKey: z.object({
    status: z.enum(['configured', 'unconfigured', 'inactive', 'revoked', 'expired', 'active']),
    source: z.enum(['memory', 'onchain', 'base-sepolia-contract', 'missing']).optional(),
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

