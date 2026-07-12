import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, jsonb, index, uniqueIndex, check, integer, boolean, numeric } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const apiCache = pgTable('api_cache', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const providerCache = pgTable('provider_cache', {
  key: text('key').primaryKey(),
  provider: text('provider').notNull(),
  chainId: integer('chain_id').notNull(),
  payload: jsonb('payload'),
  status: text('status').notNull(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
});

export const appMeta = pgTable('app_meta', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const recommendationExecutions = pgTable('recommendation_executions', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const chats = pgTable('chats', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .references(() => users.id)
    .notNull(),
  messages: jsonb('messages'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const workflows = pgTable('workflows', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .references(() => users.id)
    .notNull(),
  instructions: text('instructions'),
  toolAllowlist: jsonb('tool_allowlist'),
  intervalMs: integer('interval_ms'),
  lastRun: timestamp('last_run'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const actions = pgTable(
  'actions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    suggestedPrompt: text('suggested_prompt'),
    tokens: jsonb('tokens'),
    executionPayload: jsonb('execution_payload'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    // T19: set when a user-confirmed action is recorded by /actions/:id/confirm.
    // Null until the wallet confirmation lands onchain (or is recorded as failed).
    executedAt: timestamp('executed_at'),
  },

  (table) => [
    index('actions_user_status_created_idx').on(table.userId, table.status, table.createdAt),
  ],
);

export const userSettings = pgTable('user_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  memoryMd: text('memory_md'),
  model: text('model'),
  protocolToggles: jsonb('protocol_toggles'),
  encryptedKeys: jsonb('encrypted_keys'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const baseMcpOauthTokens = pgTable(
  'base_mcp_oauth_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    provider: text('provider').notNull(),
    encryptedTokens: text('encrypted_tokens'),
    encryptedClientInfo: text('encrypted_client_info'),
    encryptedDiscoveryState: text('encrypted_discovery_state'),
    tokenExpiresAt: timestamp('token_expires_at'),
    status: text('status').notNull(),
    lastError: text('last_error'),
    connectedAt: timestamp('connected_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('base_mcp_oauth_tokens_user_provider_idx').on(table.userId, table.provider),
  ],
);

export const baseMcpOauthStates = pgTable(
  'base_mcp_oauth_states',
  {
    stateHash: text('state_hash').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    encryptedCodeVerifier: text('encrypted_code_verifier').notNull(),
    returnTo: text('return_to').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('base_mcp_oauth_states_user_expires_idx').on(table.userId, table.expiresAt),
  ],
);

export const spendPermissions = pgTable(
  'spend_permissions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    chainId: integer('chain_id').notNull(),
    asset: text('asset'),
    limit: numeric('limit', { precision: 18, scale: 6 }).notNull(),
    spent: numeric('spent', { precision: 18, scale: 6 }).default('0').notNull(),
    whitelist: jsonb('whitelist').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('spend_permissions_user_chain_active_idx').on(table.userId, table.chainId, table.isActive),
    index('spend_permissions_expires_idx').on(table.expiresAt),
  ],
);

export const spendPermissionProofs = pgTable(
  'spend_permission_proofs',
  {
    proof: text('proof').primaryKey(),
    permissionId: text('permission_id')
      .references(() => spendPermissions.id)
      .notNull(),
    amount: numeric('amount', { precision: 18, scale: 6 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('spend_permission_proofs_permission_idx').on(table.permissionId),
  ],
);

export const autonomyPolicies = pgTable(
  'autonomy_policies',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    chainId: integer('chain_id').notNull(),
    walletAddress: text('wallet_address').notNull(),
    dailyLimit: numeric('daily_limit', { precision: 18, scale: 6 }).notNull(),
    maxPerAction: numeric('max_per_action', { precision: 18, scale: 6 }).notNull(),
    spentToday: numeric('spent_today', { precision: 18, scale: 6 }).default('0').notNull(),
    reservedToday: numeric('reserved_today', { precision: 18, scale: 6 }).default('0').notNull(),
    periodStartedAt: timestamp('period_started_at').defaultNow().notNull(),
    whitelist: jsonb('whitelist').notNull(),
    scope: text('scope').default('bounded-approval').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    killSwitch: boolean('kill_switch').default(false).notNull(),
    mainnetOptIn: boolean('mainnet_opt_in').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('autonomy_policies_user_chain_unique').on(table.userId, table.chainId),
    index('autonomy_policies_active_idx').on(table.userId, table.chainId, table.isActive),
    index('autonomy_policies_expires_idx').on(table.expiresAt),
    check('autonomy_policies_limits_check', sql`${table.dailyLimit} > 0 AND ${table.maxPerAction} > 0 AND ${table.maxPerAction} <= ${table.dailyLimit}`),
    check('autonomy_policies_accounting_check', sql`${table.spentToday} >= 0 AND ${table.reservedToday} >= 0`),
  ],
);

export const autonomyExecutionReservations = pgTable(
  'autonomy_execution_reservations',
  {
    id: text('id').primaryKey(),
    policyId: text('policy_id')
      .references(() => autonomyPolicies.id)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    actionId: text('action_id').notNull(),
    amount: numeric('amount', { precision: 18, scale: 6 }).notNull(),
    status: text('status').default('reserved').notNull(),
    proof: jsonb('proof'),
    expiresAt: timestamp('expires_at').notNull(),
    settledAt: timestamp('settled_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('autonomy_execution_reservations_action_unique').on(table.actionId),
    index('autonomy_execution_reservations_policy_status_idx').on(table.policyId, table.status),
    index('autonomy_execution_reservations_expires_idx').on(table.expiresAt),
    check('autonomy_execution_reservations_amount_check', sql`${table.amount} >= 0`),
    check('autonomy_execution_reservations_status_check', sql`${table.status} IN ('reserved', 'settled', 'released', 'expired')`),
  ],
);

export const x402Receipts = pgTable(
  'x402_receipts',
  {
    id: text('id').primaryKey(),
    // Null is reserved for global seller-smoke diagnostics. Product buyer
    // receipts always carry the authenticated tenant id.
    userId: text('user_id').references(() => users.id),
    receipt: jsonb('receipt'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('x402_receipts_user_created_idx').on(table.userId, table.createdAt)],
);

export const auditLogs = pgTable('audit_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .references(() => users.id)
    .notNull(),
  actionId: text('action_id').notNull(),
  actionType: text('action_type').notNull(),
  details: jsonb('details'),
  cost: text('cost'),
  txHash: text('tx_hash'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
