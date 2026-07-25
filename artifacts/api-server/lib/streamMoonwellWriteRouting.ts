// T44: BaseApp-native Moonwell write flow. Detects an explicit Moonwell
// supply/withdraw/borrow/repay command, applies the SAME production gates as
// the Base MCP send/swap routes (execution capability, autonomy policy,
// GoPlus screening), reads the health factor before borrow/withdraw, fetches
// unsigned ordered calldata from api.moonwell.fi via the server-side
// moonwell_prepare_* tool (partnerFetch allowlist + timeout), and records an
// action with the unsigned EIP-5792 payload — the same mechanism the
// revoke-approval flow uses. Execution is NEVER Base MCP send_calls and never
// an external approvalUrl: the client confirms via the existing
// WalletConfirmButton → wagmi useSendCalls → Base Account.
//
// NOTE (T44 known gap, reported): the existing /actions/:id/prepare execution
// guard whitelists only revoke_approval|limited_transfer with canonical-USDC
// calldata. Moonwell protocol calls fail that guard closed, so the recorded
// action stays honestly non-confirmable until the guard learns Moonwell
// semantics in a follow-up task. No gate is weakened here.

import crypto from 'node:crypto';
import type { AutonomyPolicyRepository } from '@mioagent/autonomy';
import type { ToolAggregator } from '@mioagent/tools';
import { evaluateExecutableAction, screenAction } from '@mioagent/security';
import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';
import { db, actions } from '@mioagent/db';
import { getAutonomyPolicyRepository } from './autonomyGateway.js';
import { loadTokenSecurityContext } from './executionSecurity.js';
import { sanitizeStreamToolArgs, sanitizedToolErrorCode, type StreamToolTrace } from './streamReadRouting.js';

export type MoonwellWriteVerb = 'supply' | 'withdraw' | 'borrow' | 'repay';

export interface MoonwellWriteIntent {
  verb: MoonwellWriteVerb;
  amount: number;
  amountText: string;
  asset: string;
}

export interface DirectMoonwellWriteResult {
  kind: 'moonwell_write';
  content: string;
  toolCalls: StreamToolTrace[];
  errorCode?: string;
  actionId?: string;
}

interface MoonwellActionRow {
  id: string;
  userId: string;
  kind: string;
  status: string;
  suggestedPrompt: string;
  executionPayload: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export const moonwellWriteRuntime: {
  getRepository: () => AutonomyPolicyRepository;
  insertAction: (row: MoonwellActionRow) => Promise<void>;
} = {
  getRepository: getAutonomyPolicyRepository,
  insertAction: async (row) => {
    await db.insert(actions).values(row as never).onConflictDoNothing();
  },
};

const VERB_ALIASES: Record<string, MoonwellWriteVerb> = {
  supply: 'supply',
  lend: 'supply',
  deposit: 'supply',
  withdraw: 'withdraw',
  borrow: 'borrow',
  repay: 'repay',
};

export function detectMoonwellWriteIntent(message: string): MoonwellWriteIntent | null {
  if (!/\bmoonwell\b/i.test(message)) return null;
  const match = message.match(/\b(supply|lend|deposit|withdraw|borrow|repay)\s+(\d+(?:[.,]\d+)?)\s*(USDC|ETH|WETH)\b/i);
  if (!match) return null;
  const amountText = match[2].replace(',', '.');
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    verb: VERB_ALIASES[match[1].toLowerCase()],
    amount,
    amountText,
    asset: match[3].toUpperCase(),
  };
}

function blocked(content: string, errorCode: string): DirectMoonwellWriteResult {
  return { kind: 'moonwell_write', content, toolCalls: [], errorCode };
}

function parseHealthFactor(content: string): number | null | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, any>;
    const value = parsed.healthFactor ?? parsed.data?.healthFactor ?? parsed.health ?? parsed.data?.health;
    if (value === null) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  } catch {
    return undefined;
  }
}

function healthLabel(health: number | null): string {
  if (health === null) return 'no borrows';
  if (health > 1.5) return 'healthy';
  if (health >= 1.1) return 'caution';
  return 'liquidation risk';
}

export async function runDirectMoonwellWrite(input: {
  message: string;
  normalizedIntent?: MoonwellWriteIntent;
  walletAddress?: string;
  tools: ToolAggregator;
  userConfirmedEnabled: boolean;
  userId: string;
}): Promise<DirectMoonwellWriteResult | null> {
  const intent = input.normalizedIntent ?? detectMoonwellWriteIntent(input.message);
  if (!intent) return null;

  // 1) Execution gate — identical to the Base MCP send route.
  if (!input.userConfirmedEnabled) {
    return blocked('Mainnet is read-only. No Moonwell transaction was requested.', 'mainnet_readonly');
  }
  if (!input.walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(input.walletAddress)) {
    return blocked('Connect Base Account before requesting a Moonwell action.', 'moonwell_wallet_required');
  }
  const walletAddress = input.walletAddress.toLowerCase();

  // 2) Autonomy policy — same readiness and per-action limit checks as
  // send/swap. The policy accounts spending in USDC, so only USDC amounts are
  // supported (same restriction the swap route applies).
  const repository = moonwellWriteRuntime.getRepository();
  const policy = await repository.getByUser(input.userId, 8453);
  if (!policy || !policy.isActive || policy.killSwitch || !policy.mainnetOptIn
    || policy.expiresAt <= Date.now() || policy.walletAddress !== walletAddress) {
    return blocked('Connect your wallet to prepare this deposit. Miorail can compare Earn routes without it.', 'mainnet_policy_not_ready');
  }
  if (intent.asset !== 'USDC') {
    return blocked('Moonwell actions are blocked because the active policy accounts spending in USDC only.', 'moonwell_policy_asset_unsupported');
  }
  if (intent.amount > policy.maxPerAction) {
    return blocked('Moonwell action blocked: the amount exceeds the policy maximum per action.', 'moonwell_max_per_action_exceeded');
  }

  // 3) Security screening — same GoPlus context as send (canonical Base USDC).
  const canonicalUsdc = canonicalUsdcForBaseChain(8453).toLowerCase();
  const security = await loadTokenSecurityContext(8453, [canonicalUsdc]);
  const verdict = security.tokenSecurity.find((item) => item.address.toLowerCase() === canonicalUsdc);
  const screening = screenAction({
    instruction: input.message,
    providerContext: { ...security.providerContext, requiresTokenSecurity: true },
  });
  if (!screening.allowed || !verdict || verdict.provider !== 'goplus' || !['ok', 'warning'].includes(verdict.status)) {
    return blocked('Moonwell action blocked: no fresh usable GoPlus verdict exists for canonical Base USDC.', 'moonwell_token_security_unavailable');
  }

  const traces: StreamToolTrace[] = [];
  const callTool = async (name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean; errorCode?: string }> => {
    let called: { content: string; isError: boolean };
    try {
      called = await input.tools.callTool(name, args);
    } catch {
      called = { content: JSON.stringify({ errorCode: 'moonwell_tool_unavailable' }), isError: true };
    }
    const errorCode = called.isError ? sanitizedToolErrorCode(called.content, 'moonwell_tool_failed') : undefined;
    traces.push({
      toolName: name,
      args: sanitizeStreamToolArgs(args) as Record<string, unknown>,
      result: { status: called.isError ? 'error' : 'success', ...(errorCode ? { errorCode } : {}) },
      isError: called.isError,
    });
    return { ...called, errorCode };
  };

  // 4) Health factor before borrow/withdraw — official plugin rule.
  let healthNote = '';
  if (intent.verb === 'borrow' || intent.verb === 'withdraw') {
    const health = await callTool('moonwell_get_health', { chain: 'base', address: walletAddress });
    if (health.errorCode) {
      return {
        kind: 'moonwell_write',
        content: `Moonwell health factor is unavailable (${health.errorCode}); ${intent.verb} is blocked until it can be read.`,
        toolCalls: traces,
        errorCode: 'moonwell_health_unavailable',
      };
    }
    const healthFactor = parseHealthFactor(health.content);
    if (healthFactor === undefined) {
      return {
        kind: 'moonwell_write',
        content: `Moonwell returned an unreadable health factor; ${intent.verb} is blocked until it can be read.`,
        toolCalls: traces,
        errorCode: 'moonwell_health_unavailable',
      };
    }
    healthNote = ` Current health factor: ${healthFactor === null ? 'null (no borrows)' : healthFactor} (${healthLabel(healthFactor)}).`;
  }

  // 5) Prepare — server-side HTTP via the moonwell_prepare_* tool (partnerFetch).
  const prepare = await callTool(`moonwell_prepare_${intent.verb}`, {
    chain: 'base',
    asset: intent.asset,
    amountDecimal: intent.amountText,
    from: walletAddress,
  });
  if (prepare.errorCode) {
    return {
      kind: 'moonwell_write',
      content: `Moonwell could not prepare the ${intent.verb} (${prepare.errorCode}). No transaction was created.`,
      toolCalls: traces,
      errorCode: prepare.errorCode,
    };
  }
  let transactions: Array<{ to: string; data?: string; value?: string; chainId?: number }>;
  try {
    const parsed = JSON.parse(prepare.content) as { transactions?: Array<{ to: string; data?: string; value?: string; chainId?: number }> };
    transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];
  } catch {
    transactions = [];
  }
  if (transactions.length === 0) {
    return {
      kind: 'moonwell_write',
      content: 'Moonwell returned no executable transaction steps. No transaction was created.',
      toolCalls: traces,
      errorCode: 'moonwell_prepare_invalid_response',
    };
  }
  if (transactions.some((tx) => tx.chainId !== undefined && tx.chainId !== 8453)) {
    return {
      kind: 'moonwell_write',
      content: 'Moonwell returned transaction steps for a chain other than Base mainnet. No transaction was created.',
      toolCalls: traces,
      errorCode: 'moonwell_prepare_wrong_chain',
    };
  }

  // 6) Record the action with the unsigned EIP-5792 payload — same mechanism
  // as revoke-approval: DB action row → Action Inbox → WalletConfirmButton →
  // wagmi useSendCalls → Base Account confirmation. T44b: the unified guard
  // now validates Moonwell batches through the strict moonwellGuard; it
  // re-evaluates the STORED payload again at /prepare before any wallet sees
  // the calls, and the gateway reserves the amount against the policy limits.
  const payload = {
    chain: 'eip155:8453',
    actionType: `moonwell_${intent.verb}` as const,
    calls: transactions.map((tx) => ({ to: tx.to, value: tx.value || '0', data: tx.data || '0x' })),
  };
  const guard = await evaluateExecutableAction({
    chain: 'eip155:8453',
    actionType: payload.actionType,
    calls: payload.calls,
    instruction: input.message,
    providerContext: security.providerContext,
    tokenSecurity: security.tokenSecurity,
    moonwell: { amountDecimal: intent.amountText },
  });
  const simulation = guard.simulation || {
    success: false,
    allowed: false,
    riskLevel: 'blocked' as const,
    checks: ['Unified execution guard: Blocked'],
    reason: guard.reason || 'Moonwell preflight validation failed',
  };

  const actionId = crypto.randomUUID();
  const metadata: Record<string, unknown> = {
    type: 'recommendation',
    title: `Moonwell ${intent.verb} ${intent.amountText} ${intent.asset}`,
    instruction: input.message,
    reason: `User-confirmed Moonwell ${intent.verb} prepared from api.moonwell.fi ordered transactions.`,
    actionType: payload.actionType,
    chainMode: 'mainnet',
    walletAddress,
    userConfirmable: guard.allowed === true,
    executable: false,
    executionStatus: guard.allowed === true ? 'user-confirmable' : 'read-only',
    safetyState: guard.allowed === true ? 'user-confirmable' : 'blocked',
    createdBy: 'moonwell-write-routing',
    securityScreening: {
      screenedAt: new Date().toISOString(),
      allowed: screening.allowed,
      verdict: 'PASSED',
      reason: 'Action-security heuristics and GoPlus canonical USDC verdict evaluated.',
      checks: screening.checks || [],
    },
    simulationResult: simulation,
    moonwell: {
      verb: intent.verb,
      asset: intent.asset,
      amountDecimal: intent.amountText,
      stepCount: transactions.length,
    },
  };
  try {
    await moonwellWriteRuntime.insertAction({
      id: actionId,
      userId: input.userId,
      kind: 'transaction',
      status: 'pending',
      suggestedPrompt: input.message,
      executionPayload: JSON.stringify(payload),
      metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch {
    return {
      kind: 'moonwell_write',
      content: 'Moonwell prepared the transaction, but the action record could not be stored. Retry.',
      toolCalls: traces,
      errorCode: 'moonwell_action_store_failed',
    };
  }

  const content = guard.allowed === true
    ? `I prepared a Moonwell ${intent.verb} of ${intent.amountText} ${intent.asset} as ${transactions.length} ordered step(s) executed as one atomic batch.${healthNote} Review and confirm it in your Action Inbox — nothing moves without your Base Account approval.`
    : `I prepared a Moonwell ${intent.verb} of ${intent.amountText} ${intent.asset} (${transactions.length} ordered step(s)).${healthNote} The action was recorded in Action Inbox, but it failed strict preflight validation (${guard.code}), so confirmation stays locked (fail-closed). No transaction was signed or broadcast.`;

  return {
    kind: 'moonwell_write',
    content,
    toolCalls: traces,
    actionId,
    ...(guard.allowed === true ? {} : { errorCode: 'moonwell_preflight_blocked' }),
  };
}
