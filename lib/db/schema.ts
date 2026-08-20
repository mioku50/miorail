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

export const preparedTransactionIntents = pgTable(
  'prepared_transaction_intents',
  {
    actionId: text('action_id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    walletAddress: text('wallet_address').notNull(),
    normalizedIntentHash: text('normalized_intent_hash').notNull(),
    preparedPayloadHash: text('prepared_payload_hash').notNull(),
    normalizedIntent: jsonb('normalized_intent').notNull(),
    preparedPayload: jsonb('prepared_payload').notNull(),
    status: text('status').default('pending').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('prepared_transaction_intents_user_status_idx').on(table.userId, table.status, table.createdAt),
    index('prepared_transaction_intents_expires_idx').on(table.expiresAt),
  ],
);

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

/** Encrypted, user-scoped sessions for reviewed Base plugin runtimes.
 * Tokens and pending SIWE challenges never enter Action Receipts or traces. */
export const baseMcpPluginSessions = pgTable(
  'base_mcp_plugin_sessions',
  {
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    provider: text('provider').notNull(),
    walletAddress: text('wallet_address').notNull(),
    encryptedSession: text('encrypted_session').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('base_mcp_plugin_sessions_user_provider_unique').on(table.userId, table.provider),
    index('base_mcp_plugin_sessions_expires_idx').on(table.expiresAt),
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
    // Null is reserved for global seller receipts and seller-smoke
    // diagnostics. Product buyer receipts always carry the authenticated
    // tenant id.
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

const restrictReference = { onDelete: 'restrict', onUpdate: 'restrict' } as const;

export const routeRuns = pgTable(
  'route_runs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    walletAddress: text('wallet_address').notNull(),
    chainId: integer('chain_id').notNull(),
    // T62: 'swap' (default) or 'earn'. Earn runs store an EarnRouteIntentV1
    // payload; the goal keeps the two isolated within this shared table.
    goal: text('goal').default('swap').notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    intentHash: text('intent_hash').notNull(),
    intentPayload: jsonb('intent_payload').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('route_runs_user_idempotency_unique').on(table.userId, table.idempotencyKey),
    index('route_runs_user_status_created_idx').on(table.userId, table.status, table.createdAt),
    index('route_runs_intent_hash_idx').on(table.intentHash),
    check('route_runs_chain_check', sql`${table.chainId} IN (8453, 84532)`),
    check('route_runs_goal_check', sql`${table.goal} IN ('swap', 'earn', 'commerce')`),
    check(
      'route_runs_status_check',
      sql`${table.status} IN ('draft', 'ready', 'needs_clarification', 'collecting_candidates', 'collecting_evidence', 'scoring', 'card_ready', 'blueprint_ready', 'awaiting_approval', 'executing', 'reconciling', 'completed', 'partial_failure', 'failed', 'cancelled', 'rejected')`,
    ),
  ],
);

export const routeCandidates = pgTable(
  'route_candidates',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    providerId: text('provider_id').notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    candidateHash: text('candidate_hash').notNull(),
    payload: jsonb('payload').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('route_candidates_run_hash_unique').on(table.routeRunId, table.candidateHash),
    index('route_candidates_run_status_idx').on(table.routeRunId, table.status),
    index('route_candidates_provider_idx').on(table.providerId),
    check(
      'route_candidates_status_check',
      sql`${table.status} IN ('quoted', 'selected', 'expired', 'invalid', 'rejected')`,
    ),
  ],
);

export const routeEvidence = pgTable(
  'route_evidence',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    candidateId: text('candidate_id').references(() => routeCandidates.id, restrictReference),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    evidenceType: text('evidence_type').notNull(),
    providerId: text('provider_id').notNull(),
    evidenceHash: text('evidence_hash').notNull(),
    payload: jsonb('payload').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    validationStatus: text('validation_status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('route_evidence_run_hash_unique').on(table.routeRunId, table.evidenceHash),
    index('route_evidence_candidate_idx').on(table.candidateId),
    index('route_evidence_provider_idx').on(table.providerId),
    index('route_evidence_type_idx').on(table.evidenceType),
    index('route_evidence_expires_idx').on(table.expiresAt),
    check(
      'route_evidence_status_check',
      sql`${table.status} IN ('observed', 'expired', 'rejected', 'unavailable')`,
    ),
    check(
      'route_evidence_validation_status_check',
      sql`${table.validationStatus} IN ('valid', 'stale', 'invalid', 'unavailable')`,
    ),
  ],
);

export const routeEvidenceSets = pgTable(
  'route_evidence_sets',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    candidateId: text('candidate_id')
      .references(() => routeCandidates.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    evidenceSetHash: text('evidence_set_hash').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('route_evidence_sets_run_hash_unique').on(table.routeRunId, table.evidenceSetHash),
    index('route_evidence_sets_run_status_idx').on(table.routeRunId, table.status),
    index('route_evidence_sets_candidate_idx').on(table.candidateId),
    check(
      'route_evidence_sets_status_check',
      sql`${table.status} IN ('collecting', 'complete', 'partial', 'stale', 'invalid')`,
    ),
  ],
);

export const routeScoreSnapshots = pgTable(
  'route_score_snapshots',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    candidateId: text('candidate_id')
      .references(() => routeCandidates.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    scoreHash: text('score_hash').notNull(),
    scoringVersion: text('scoring_version').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('route_score_snapshots_candidate_hash_unique').on(
      table.candidateId,
      table.scoreHash,
    ),
    index('route_score_snapshots_run_candidate_idx').on(table.routeRunId, table.candidateId),
    check(
      'route_score_snapshots_status_check',
      sql`${table.status} IN ('scored', 'partially_scored', 'not_scored')`,
    ),
  ],
);

export const routeCards = pgTable(
  'route_cards',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    routeCardHash: text('route_card_hash').notNull(),
    selectedCandidateId: text('selected_candidate_id').references(
      () => routeCandidates.id,
      restrictReference,
    ),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('route_cards_run_hash_unique').on(table.routeRunId, table.routeCardHash),
    index('route_cards_run_created_idx').on(table.routeRunId, table.createdAt),
    check(
      'route_cards_status_check',
      sql`${table.status} IN ('ready', 'selected', 'stale', 'invalid')`,
    ),
  ],
);

export const executionBlueprints = pgTable(
  'execution_blueprints',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    walletAddress: text('wallet_address').notNull(),
    chainId: integer('chain_id').notNull(),
    // T62: which Safety Kernel re-validates this Blueprint at approve time.
    goal: text('goal').default('swap').notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    blueprintHash: text('blueprint_hash').notNull(),
    intentHash: text('intent_hash').notNull(),
    selectedCandidateHash: text('selected_candidate_hash').notNull(),
    evidenceSetHash: text('evidence_set_hash').notNull(),
    callsHash: text('calls_hash').notNull(),
    approvedCallsHash: text('approved_calls_hash'),
    preparedTransactionActionId: text('prepared_transaction_action_id').references(
      () => preparedTransactionIntents.actionId,
      restrictReference,
    ),
    payload: jsonb('payload').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('execution_blueprints_run_hash_unique').on(table.routeRunId, table.blueprintHash),
    index('execution_blueprints_wallet_status_expiry_idx').on(
      table.walletAddress,
      table.status,
      table.expiresAt,
    ),
    check('execution_blueprints_chain_check', sql`${table.chainId} IN (8453, 84532)`),
    check('execution_blueprints_goal_check', sql`${table.goal} IN ('swap', 'earn')`),
    check(
      'execution_blueprints_status_check',
      sql`${table.status} IN ('draft', 'ready_for_review', 'approved', 'expired', 'invalid')`,
    ),
  ],
);

// --- T62: earn persistence tables (additive; earn payload shapes) ------------

export const earnRouteCandidates = pgTable(
  'earn_route_candidates',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    providerId: text('provider_id').notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    candidateHash: text('candidate_hash').notNull(),
    payload: jsonb('payload').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('earn_route_candidates_run_hash_unique').on(table.routeRunId, table.candidateHash),
    index('earn_route_candidates_run_status_idx').on(table.routeRunId, table.status),
    check(
      'earn_route_candidates_status_check',
      sql`${table.status} IN ('quoted', 'selected', 'expired', 'invalid', 'rejected')`,
    ),
  ],
);

export const earnRouteEvidence = pgTable(
  'earn_route_evidence',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    candidateId: text('candidate_id').references(() => earnRouteCandidates.id, restrictReference),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    evidenceHash: text('evidence_hash').notNull(),
    providerId: text('provider_id').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('earn_route_evidence_run_hash_unique').on(table.routeRunId, table.evidenceHash),
    index('earn_route_evidence_candidate_idx').on(table.candidateId),
    check(
      'earn_route_evidence_status_check',
      sql`${table.status} IN ('fresh', 'stale', 'invalid')`,
    ),
  ],
);

export const earnScoreSnapshots = pgTable(
  'earn_score_snapshots',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    candidateId: text('candidate_id')
      .references(() => earnRouteCandidates.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    scoreHash: text('score_hash').notNull(),
    scoringVersion: text('scoring_version').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('earn_score_snapshots_candidate_hash_unique').on(table.candidateId, table.scoreHash),
    index('earn_score_snapshots_run_candidate_idx').on(table.routeRunId, table.candidateId),
    check(
      'earn_score_snapshots_status_check',
      sql`${table.status} IN ('scored', 'partially_scored', 'not_scored')`,
    ),
  ],
);

export const earnRouteCards = pgTable(
  'earn_route_cards',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    routeCardHash: text('route_card_hash').notNull(),
    selectedCandidateId: text('selected_candidate_id').references(
      () => earnRouteCandidates.id,
      restrictReference,
    ),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('earn_route_cards_run_hash_unique').on(table.routeRunId, table.routeCardHash),
    index('earn_route_cards_run_created_idx').on(table.routeRunId, table.createdAt),
    check(
      'earn_route_cards_status_check',
      sql`${table.status} IN ('ready', 'degraded', 'selected', 'stale', 'invalid')`,
    ),
  ],
);

export const routeProofs = pgTable(
  'route_proofs',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    blueprintId: text('blueprint_id')
      .references(() => executionBlueprints.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    proofHash: text('proof_hash').notNull(),
    approvedCallsHash: text('approved_calls_hash').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('route_proofs_run_hash_unique').on(table.routeRunId, table.proofHash),
    index('route_proofs_run_status_idx').on(table.routeRunId, table.status),
    check(
      'route_proofs_status_check',
      sql`${table.status} IN ('pending', 'completed', 'partial_failure', 'failed', 'cancelled', 'reconciliation_required')`,
    ),
  ],
);

export const routeProofEvents = pgTable(
  'route_proof_events',
  {
    id: text('id').primaryKey(),
    routeProofId: text('route_proof_id')
      .references(() => routeProofs.id, restrictReference)
      .notNull(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    eventType: text('event_type').notNull(),
    eventHash: text('event_hash').notNull(),
    sequence: integer('sequence').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('route_proof_events_proof_sequence_unique').on(table.routeProofId, table.sequence),
    uniqueIndex('route_proof_events_proof_hash_unique').on(table.routeProofId, table.eventHash),
    index('route_proof_events_run_created_idx').on(table.routeRunId, table.createdAt),
    check('route_proof_events_sequence_check', sql`${table.sequence} >= 0`),
    check('route_proof_events_status_check', sql`${table.status} = 'recorded'`),
  ],
);

export const intelligenceBudgets = pgTable(
  'intelligence_budgets',
  {
    id: text('id').primaryKey(),
    schemaVersion: text('schema_version').notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    walletAddress: text('wallet_address').notNull(),
    chainId: integer('chain_id').notNull(),
    spendPermissionId: text('spend_permission_id')
      .references(() => spendPermissions.id, restrictReference)
      .notNull(),
    status: text('status').notNull(),
    periodType: text('period_type').notNull(),
    periodLimitAtomic: numeric('period_limit_atomic', { precision: 78, scale: 0 }).notNull(),
    periodSpentAtomic: numeric('period_spent_atomic', { precision: 78, scale: 0 }).default('0').notNull(),
    reservedAtomic: numeric('reserved_atomic', { precision: 78, scale: 0 }).default('0').notNull(),
    maxPerCallAtomic: numeric('max_per_call_atomic', { precision: 78, scale: 0 }).notNull(),
    allowedCategories: jsonb('allowed_categories').notNull(),
    periodStartedAt: timestamp('period_started_at', { withTimezone: true }),
    periodEndsAt: timestamp('period_ends_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    budgetHash: text('budget_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('intelligence_budgets_active_permission_unique')
      .on(table.spendPermissionId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex('intelligence_budgets_active_wallet_unique')
      .on(table.userId, sql`lower(${table.walletAddress})`, table.chainId)
      .where(sql`${table.status} = 'active'`),
    index('intelligence_budgets_user_wallet_chain_idx').on(table.userId, table.walletAddress, table.chainId),
    check(
      'intelligence_budgets_status_check',
      sql`${table.status} IN ('active', 'paused', 'revoked', 'expired')`,
    ),
    check('intelligence_budgets_period_type_check', sql`${table.periodType} IN ('monthly')`),
    check(
      'intelligence_budgets_amounts_check',
      sql`${table.periodLimitAtomic} >= 0 AND ${table.periodSpentAtomic} >= 0 AND ${table.reservedAtomic} >= 0 AND ${table.maxPerCallAtomic} >= 0 AND ${table.maxPerCallAtomic} <= ${table.periodLimitAtomic}`,
    ),
  ],
);

export const intelligenceBudgetReservations = pgTable(
  'intelligence_budget_reservations',
  {
    id: text('id').primaryKey(),
    schemaVersion: text('schema_version').notNull(),
    budgetId: text('budget_id')
      .references(() => intelligenceBudgets.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    amountAtomic: numeric('amount_atomic', { precision: 78, scale: 0 }).notNull(),
    status: text('status').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('intelligence_budget_reservations_idempotency_key_unique').on(table.idempotencyKey),
    index('intelligence_budget_reservations_budget_status_idx').on(table.budgetId, table.status),
    check(
      'intelligence_budget_reservations_status_check',
      sql`${table.status} IN ('reserved', 'settled', 'released', 'expired')`,
    ),
    check('intelligence_budget_reservations_amount_check', sql`${table.amountAtomic} >= 0`),
  ],
);

export const intelligenceCharges = pgTable(
  'intelligence_charges',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    evidenceId: text('evidence_id').references(() => routeEvidence.id, restrictReference),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    chargeHash: text('charge_hash').notNull(),
    spendPermissionId: text('spend_permission_id').references(
      () => spendPermissions.id,
      restrictReference,
    ),
    x402ReceiptId: text('x402_receipt_id').references(() => x402Receipts.id, restrictReference),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('intelligence_charges_run_hash_unique').on(table.routeRunId, table.chargeHash),
    index('intelligence_charges_run_status_idx').on(table.routeRunId, table.status),
    check(
      'intelligence_charges_status_check',
      sql`${table.status} IN ('quoted', 'reserved', 'payment_pending', 'settled', 'failed', 'reconciliation_required', 'released')`,
    ),
  ],
);

export const intelligenceChargeAttempts = pgTable(
  'intelligence_charge_attempts',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    chargeId: text('charge_id')
      .references(() => intelligenceCharges.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    spendPermissionId: text('spend_permission_id')
      .references(() => spendPermissions.id, restrictReference)
      .notNull(),
    expectedPayer: text('expected_payer').notNull(),
    amountAtomic: numeric('amount_atomic', { precision: 78, scale: 0 }).notNull(),
    status: text('status').notNull(),
    proof: jsonb('proof'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('intelligence_charge_attempts_charge_unique').on(table.chargeId),
    index('intelligence_charge_attempts_user_status_idx').on(table.userId, table.status, table.updatedAt),
    check(
      'intelligence_charge_attempts_status_check',
      sql`${table.status} IN ('claimed', 'settled', 'outcome_unknown')`,
    ),
    check(
      'intelligence_charge_attempts_payer_check',
      sql`${table.expectedPayer} ~ '^0x[0-9a-f]{40}$'`,
    ),
    check('intelligence_charge_attempts_amount_check', sql`${table.amountAtomic} > 0`),
    check(
      'intelligence_charge_attempts_proof_check',
      sql`(${table.status} = 'settled' AND ${table.proof} IS NOT NULL AND ${table.settledAt} IS NOT NULL) OR (${table.status} <> 'settled' AND ${table.settledAt} IS NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// T64.2 — durable Commerce storage.
//
// Commerce runs live in route_runs (goal='commerce') so the run/intent shape is
// shared, but every commerce PAYLOAD gets its own versioned table: the family
// has no Blueprint and no swap-shaped proof, so reusing the execution tables
// would misrepresent it.
//
// Nothing here stores a redemption code, a PIN, an eSIM URL, or an API key.
// The order and event rows carry states, counts and provider ids only.
// ---------------------------------------------------------------------------

export const commerceCandidates = pgTable(
  'commerce_candidates',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    candidateHash: text('candidate_hash').notNull(),
    productId: text('product_id').notNull(),
    packageValue: text('package_value').notNull(),
    payload: jsonb('payload').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('commerce_candidates_run_hash_unique').on(table.routeRunId, table.candidateHash),
    index('commerce_candidates_run_product_idx').on(table.routeRunId, table.productId),
    check(
      'commerce_candidates_status_check',
      sql`${table.status} IN ('quoted', 'selected', 'expired', 'invalid', 'rejected')`,
    ),
  ],
);

export const commerceEvidence = pgTable(
  'commerce_evidence',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    candidateId: text('candidate_id').references(() => commerceCandidates.id, restrictReference),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    evidenceHash: text('evidence_hash').notNull(),
    providerId: text('provider_id').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('commerce_evidence_run_hash_unique').on(table.routeRunId, table.evidenceHash),
    index('commerce_evidence_candidate_idx').on(table.candidateId),
    check('commerce_evidence_status_check', sql`${table.status} IN ('fresh', 'stale', 'invalid')`),
  ],
);

export const commerceRouteCards = pgTable(
  'commerce_route_cards',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    routeCardHash: text('route_card_hash').notNull(),
    payload: jsonb('payload').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('commerce_route_cards_run_hash_unique').on(table.routeRunId, table.routeCardHash),
    index('commerce_route_cards_user_created_idx').on(table.userId, table.createdAt),
    check(
      'commerce_route_cards_status_check',
      sql`${table.status} IN ('ready', 'degraded', 'selected', 'stale', 'invalid')`,
    ),
  ],
);

export const commerceOrders = pgTable(
  'commerce_orders',
  {
    id: text('id').primaryKey(),
    routeRunId: text('route_run_id')
      .references(() => routeRuns.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    walletAddress: text('wallet_address').notNull(),
    routeCardHash: text('route_card_hash').notNull(),
    candidateHash: text('candidate_hash').notNull(),
    productId: text('product_id').notNull(),
    packageValue: text('package_value').notNull(),
    // tenant + wallet + routeCardHash + packageId + requestId. The unique index
    // below is what makes a repeated checkout return the SAME invoice instead
    // of opening a second one.
    idempotencyKey: text('idempotency_key').notNull(),
    // 'pending' exists before the provider is called, so an uncertain network
    // result is a durable fact rather than a lost request.
    status: text('status').notNull(),
    providerStatus: text('provider_status').notNull(),
    // NULL until the provider confirms an invoice.
    invoiceId: text('invoice_id'),
    exactAmountAtomic: text('exact_amount_atomic'),
    estimatedAmountAtomic: text('estimated_amount_atomic'),
    payTo: text('pay_to'),
    refundAddress: text('refund_address').notNull(),
    payload: jsonb('payload'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('commerce_orders_user_idempotency_unique').on(table.userId, table.idempotencyKey),
    uniqueIndex('commerce_orders_user_invoice_unique').on(table.userId, table.invoiceId),
    index('commerce_orders_user_created_idx').on(table.userId, table.createdAt),
    check(
      'commerce_orders_status_check',
      sql`${table.status} IN ('pending', 'created', 'payment_pending', 'payment_confirmed', 'fulfilling', 'delivered', 'failed', 'expired', 'creation_unknown')`,
    ),
    check(
      'commerce_orders_provider_status_check',
      sql`${table.providerStatus} IN ('invoice_created', 'payment_pending', 'payment_settled', 'order_confirmed', 'delivery_pending', 'delivered', 'expired', 'cancelled', 'unknown')`,
    ),
  ],
);

export const commerceOrderEvents = pgTable(
  'commerce_order_events',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .references(() => commerceOrders.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    paymentState: text('payment_state').notNull(),
    deliveryState: text('delivery_state').notNull(),
    detail: text('detail'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('commerce_order_events_order_observed_idx').on(table.orderId, table.observedAt),
    check(
      'commerce_order_events_status_check',
      sql`${table.status} IN ('invoice_created', 'payment_pending', 'payment_settled', 'order_confirmed', 'delivery_pending', 'delivered', 'expired', 'cancelled', 'unknown')`,
    ),
  ],
);

export const commerceProofs = pgTable(
  'commerce_proofs',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .references(() => commerceOrders.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    schemaVersion: text('schema_version').notNull(),
    finalStatus: text('final_status').notNull(),
    proofHash: text('proof_hash').notNull(),
    orderHash: text('order_hash').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('commerce_proofs_order_unique').on(table.orderId),
    index('commerce_proofs_user_status_idx').on(table.userId, table.finalStatus),
    check(
      'commerce_proofs_final_status_check',
      sql`${table.finalStatus} IN ('pending', 'delivered', 'partial_delivery', 'order_unconfirmed', 'payment_failed', 'failed', 'reconciliation_required')`,
    ),
  ],
);

/**
 * T64.3 — the commerce payment Blueprint.
 *
 * One row per order (unique index), because a second Blueprint for the same
 * order is a second wallet prompt for money that may already be moving.
 * `delivery_record` holds states and a REDACTED response hash only; no
 * redemption code, PIN or link is ever written here.
 */
export const commercePaymentBlueprints = pgTable(
  'commerce_payment_blueprints',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .references(() => commerceOrders.id, restrictReference)
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, restrictReference)
      .notNull(),
    walletAddress: text('wallet_address').notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status').notNull(),
    blueprintHash: text('blueprint_hash').notNull(),
    callsHash: text('calls_hash').notNull(),
    approvedCallsHash: text('approved_calls_hash'),
    invoiceId: text('invoice_id').notNull(),
    exactAmountAtomic: text('exact_amount_atomic').notNull(),
    recipient: text('recipient').notNull(),
    recipientPolicy: text('recipient_policy').notNull(),
    payload: jsonb('payload').notNull(),
    submissionBatchId: text('submission_batch_id'),
    transactionHash: text('transaction_hash'),
    onchainState: text('onchain_state'),
    providerProgress: text('provider_progress'),
    deliveryRecord: jsonb('delivery_record'),
    invoiceExpiresAt: timestamp('invoice_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('commerce_payment_blueprints_order_unique').on(table.orderId),
    uniqueIndex('commerce_payment_blueprints_user_hash_unique').on(table.userId, table.blueprintHash),
    index('commerce_payment_blueprints_user_status_idx').on(table.userId, table.status),
    check(
      'commerce_payment_blueprints_status_check',
      sql`${table.status} IN ('ready_for_review', 'approved', 'submitted', 'confirmed_onchain', 'provider_confirmed', 'delivered', 'failed', 'reconciliation_required')`,
    ),
    check(
      'commerce_payment_blueprints_recipient_policy_check',
      sql`${table.recipientPolicy} IN ('pinned', 'invoice_scoped')`,
    ),
  ],
);
