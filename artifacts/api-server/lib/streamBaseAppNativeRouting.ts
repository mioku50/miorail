import crypto from 'node:crypto';
import { db, actions } from '@mioagent/db';
import type { AutonomyPolicy, AutonomyPolicyRepository } from '@mioagent/autonomy';
import { evaluateExecutableAction } from '@mioagent/security';
import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';
import { partnerFetch } from '@mioagent/security/httpAllowlist';
import type { UniswapSwapContext } from '@mioagent/security/uniswapGuard';
import { getAutonomyPolicyRepository } from './autonomyGateway.js';
import { buildActionPlan } from './actionPlan.js';
import { loadTokenSecurityContext } from './executionSecurity.js';
import { detectBaseMcpSendIntent, type BaseMcpSendIntent } from './streamBaseMcpSendRouting.js';
import { detectSwapIntent } from './streamBaseMcpSwapRouting.js';
import type { StreamToolTrace } from './streamReadRouting.js';

type NativeResultKind = 'baseapp_native_send' | 'baseapp_native_swap';

export interface DirectBaseAppNativeResult {
  kind: NativeResultKind;
  content: string;
  toolCalls: StreamToolTrace[];
  errorCode?: string;
  actionId?: string;
  actionExpiresAt?: string;
  preparedPayload?: Record<string, unknown>;
}

type SwapIntent = { amount: string; tokenIn: string; tokenOut: string };
type Call = { to: string; value?: string; data?: string };

interface NativeActionRow {
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

interface UniswapPreparation {
  calls: Call[];
  requestId: string;
  expiresAt: string;
  context: UniswapSwapContext;
}

export const baseAppNativeRuntime: {
  getRepository: () => AutonomyPolicyRepository;
  loadTokenSecurity: typeof loadTokenSecurityContext;
  evaluate: typeof evaluateExecutableAction;
  insertAction: (row: NativeActionRow) => Promise<void>;
  prepareUniswap5792: (intent: SwapIntent, walletAddress: string) => Promise<UniswapPreparation>;
} = {
  getRepository: getAutonomyPolicyRepository,
  loadTokenSecurity: loadTokenSecurityContext,
  evaluate: evaluateExecutableAction,
  insertAction: async (row) => {
    await db.insert(actions).values(row as never).onConflictDoNothing();
  },
  prepareUniswap5792,
};

function blocked(kind: NativeResultKind, content: string, errorCode: string): DirectBaseAppNativeResult {
  return { kind, content, toolCalls: [], errorCode };
}

function validPolicy(policy: AutonomyPolicy | null | undefined, userId: string, walletAddress: string): policy is AutonomyPolicy {
  return !!policy
    && policy.userId === userId
    && policy.isActive
    && !policy.killSwitch
    && policy.mainnetOptIn
    && policy.expiresAt > Date.now()
    && policy.walletAddress === walletAddress;
}

function actionExpiry(policy: AutonomyPolicy, maxTtlMs = 15 * 60_000): string {
  return new Date(Math.min(policy.expiresAt, Date.now() + maxTtlMs)).toISOString();
}

async function freshUsdcSecurity() {
  const usdc = canonicalUsdcForBaseChain(8453).toLowerCase();
  const security = await baseAppNativeRuntime.loadTokenSecurity(8453, [usdc]);
  const verdict = security.tokenSecurity.find((item) => item.address.toLowerCase() === usdc);
  return {
    security,
    usable: !!verdict && verdict.provider === 'goplus' && ['ok', 'warning'].includes(verdict.status),
  };
}

export async function runDirectBaseAppNativeSend(input: {
  message: string;
  normalizedIntent?: BaseMcpSendIntent;
  walletAddress?: string;
  userConfirmedEnabled: boolean;
  userId: string;
}): Promise<DirectBaseAppNativeResult | null> {
  const intent = input.normalizedIntent ?? detectBaseMcpSendIntent(input.message);
  if (!intent) return null;
  const kind: NativeResultKind = 'baseapp_native_send';
  if (!input.userConfirmedEnabled) return blocked(kind, 'Mainnet is read-only. No transfer was prepared.', 'mainnet_readonly');
  if (!input.walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(input.walletAddress)) {
    return blocked(kind, 'Authenticate the current BaseApp wallet before requesting a transfer.', 'send_wallet_required');
  }
  const walletAddress = input.walletAddress.toLowerCase();
  const policy = await baseAppNativeRuntime.getRepository().getByUser(input.userId, 8453);
  if (!validPolicy(policy, input.userId, walletAddress)) {
    return blocked(kind, 'Native transfer is blocked until the active mainnet policy matches the authenticated BaseApp wallet.', 'mainnet_policy_not_ready');
  }
  if (!policy.whitelist.some((address) => address.toLowerCase() === intent.recipient)) {
    return blocked(kind, 'Transfer blocked: the recipient is not in the active policy whitelist.', 'send_recipient_not_whitelisted');
  }
  if (intent.amount > policy.maxPerAction) {
    return blocked(kind, 'Transfer blocked: the amount exceeds the policy maximum per action.', 'send_max_per_action_exceeded');
  }
  const { security, usable } = await freshUsdcSecurity();
  if (!usable) return blocked(kind, 'Transfer blocked: no fresh usable GoPlus verdict exists for canonical Base USDC.', 'send_token_security_unavailable');

  const canonicalInstruction = `send ${intent.amountText} USDC to ${intent.recipient}`;
  const payload = buildActionPlan(canonicalInstruction, {
    chainEnv: 'mainnet',
    walletAddress,
    securityProviderContext: security.providerContext,
  });
  if (payload.actionType !== 'limited_transfer' || payload.calls.length !== 1) {
    return blocked(kind, 'Transfer could not be encoded as a bounded canonical-USDC action.', 'native_send_prepare_failed');
  }
  const guard = await baseAppNativeRuntime.evaluate({
    chain: 8453,
    actionType: 'limited_transfer',
    calls: payload.calls,
    instruction: input.message,
    providerContext: security.providerContext,
    tokenSecurity: security.tokenSecurity,
  });
  if (!guard.allowed) return blocked(kind, `Transfer preflight failed (${guard.code}).`, 'native_send_preflight_blocked');

  const actionId = crypto.randomUUID();
  const expiresAt = actionExpiry(policy);
  const metadata = {
    type: 'recommendation',
    title: `Send ${intent.amountText} USDC`,
    instruction: input.message,
    reason: 'Prepared for the authenticated BaseApp wallet; Base MCP wallet tools were not used.',
    actionType: 'limited_transfer',
    chainMode: 'mainnet',
    walletAddress,
    userConfirmable: true,
    executable: false,
    executionStatus: 'user-confirmable',
    safetyState: 'user-confirmable',
    createdBy: 'baseapp-native-routing',
    expiresAt,
  };
  await baseAppNativeRuntime.insertAction({
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
  return {
    kind,
    content: `I prepared a ${intent.amountText} USDC transfer for your current BaseApp wallet. Review it in Action Inbox and confirm with wallet_sendCalls; the server did not sign or broadcast anything.`,
    toolCalls: [],
    actionId,
    actionExpiresAt: expiresAt,
    preparedPayload: { executionPayload: payload, tenantId: input.userId, walletAddress, expiresAt },
  };
}

function uniswapTimeoutMs(): number {
  const value = Number(process.env.UNISWAP_SWAP_TIMEOUT_MS || 10_000);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 30_000) : 10_000;
}

function baseUnits(amount: string, decimals: number): string {
  if (!/^\d+(?:\.\d+)?$/.test(amount)) throw new Error('uniswap_invalid_amount');
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > decimals) throw new Error('uniswap_invalid_amount');
  const value = BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
  if (value <= 0n) throw new Error('uniswap_invalid_amount');
  return value.toString();
}

function uniswapToken(symbol: string): { address: string; decimals: number } {
  if (symbol === 'USDC') return { address: canonicalUsdcForBaseChain(8453), decimals: 6 };
  if (symbol === 'ETH') return { address: '0x0000000000000000000000000000000000000000', decimals: 18 };
  if (symbol === 'WETH') return { address: '0x4200000000000000000000000000000000000006', decimals: 18 };
  throw new Error('uniswap_token_unsupported');
}

async function postUniswap(path: '/quote' | '/swap_5792', body: unknown): Promise<Record<string, any>> {
  const key = process.env.UNISWAP_API_KEY?.trim();
  if (!key) throw new Error('uniswap_not_configured');
  const response = await partnerFetch(`https://trade-api.gateway.uniswap.org/v1${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-api-key': key,
      'x-universal-router-version': '2.0',
    },
    body: JSON.stringify(body),
  }, { timeoutMs: uniswapTimeoutMs() });
  if (!response.ok) throw new Error(`uniswap_http_${response.status}`);
  return response.json() as Promise<Record<string, any>>;
}

export async function prepareUniswap5792(intent: SwapIntent, walletAddress: string): Promise<UniswapPreparation> {
  if (intent.tokenIn !== 'USDC' || !['ETH', 'WETH'].includes(intent.tokenOut)) throw new Error('uniswap_pair_unsupported');
  const tokenIn = uniswapToken(intent.tokenIn);
  const tokenOut = uniswapToken(intent.tokenOut);
  const amount = baseUnits(intent.amount, tokenIn.decimals);
  const quotePayload = await postUniswap('/quote', {
    type: 'EXACT_INPUT',
    amount,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    tokenInChainId: 8453,
    tokenOutChainId: 8453,
    swapper: walletAddress,
    recipient: walletAddress,
    protocols: ['V2', 'V3', 'V4'],
    routingPreference: 'BEST_PRICE',
    autoSlippage: 'DEFAULT',
    generatePermitAsTransaction: true,
    permitAmount: 'EXACT',
  });
  const quote = quotePayload.quote;
  const routing = String(quotePayload.routing || quote?.routing || '').toUpperCase();
  if (!quote || typeof quote !== 'object' || !['CLASSIC', 'WRAP', 'UNWRAP'].includes(routing)) {
    throw new Error('uniswap_quote_invalid');
  }
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const prepared = await postUniswap('/swap_5792', {
    quote,
    ...(quotePayload.permitData ? { permitData: quotePayload.permitData } : {}),
    deadline: Math.floor(Date.parse(expiresAt) / 1000),
    urgency: 'normal',
  });
  if (String(prepared.from || '').toLowerCase() !== walletAddress
    || Number(prepared.chainId) !== 8453
    || typeof prepared.requestId !== 'string'
    || !Array.isArray(prepared.calls)) {
    throw new Error('uniswap_5792_invalid');
  }
  const calls = prepared.calls.map((call: Record<string, unknown>) => ({
    to: String(call.to || '').toLowerCase(),
    value: String(call.value || '0'),
    data: String(call.data || '').toLowerCase(),
  }));
  return {
    calls,
    requestId: prepared.requestId.slice(0, 200),
    expiresAt,
    context: {
      amountDecimal: intent.amount,
      inputToken: 'USDC',
      outputToken: intent.tokenOut as 'ETH' | 'WETH',
      swapper: walletAddress,
      routerVersion: '2.0',
      expiresAt,
    },
  };
}

export async function runDirectBaseAppNativeSwap(input: {
  message: string;
  normalizedIntent?: SwapIntent;
  walletAddress?: string;
  userConfirmedEnabled: boolean;
  userId: string;
}): Promise<DirectBaseAppNativeResult | null> {
  const intent = input.normalizedIntent ?? detectSwapIntent(input.message);
  if (!intent) return null;
  const kind: NativeResultKind = 'baseapp_native_swap';
  if (!input.userConfirmedEnabled) return blocked(kind, 'Mainnet is read-only. No swap was prepared.', 'mainnet_readonly');
  if (!input.walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(input.walletAddress)) {
    return blocked(kind, 'Authenticate the current BaseApp wallet before requesting a swap.', 'swap_wallet_required');
  }
  const walletAddress = input.walletAddress.toLowerCase();
  const policy = await baseAppNativeRuntime.getRepository().getByUser(input.userId, 8453);
  if (!validPolicy(policy, input.userId, walletAddress)) {
    return blocked(kind, 'Native swap is blocked until the active mainnet policy matches the authenticated BaseApp wallet.', 'mainnet_policy_not_ready');
  }
  const amount = Number(intent.amount);
  if (intent.tokenIn !== 'USDC' || !['ETH', 'WETH'].includes(intent.tokenOut)) {
    return blocked(kind, 'Native BaseApp swaps currently support canonical Base USDC to ETH or WETH only.', 'swap_policy_asset_unsupported');
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > policy.maxPerAction) {
    return blocked(kind, 'Swap blocked: the amount is invalid or exceeds the policy maximum per action.', 'swap_max_per_action_exceeded');
  }
  const { security, usable } = await freshUsdcSecurity();
  if (!usable) return blocked(kind, 'Swap blocked: no fresh usable GoPlus verdict exists for canonical Base USDC.', 'swap_token_security_unavailable');

  let prepared: UniswapPreparation;
  try {
    prepared = await baseAppNativeRuntime.prepareUniswap5792(intent, walletAddress);
  } catch (error) {
    const code = error instanceof Error ? error.message.replace(/[^a-z0-9_]+/gi, '_').toLowerCase() : 'uniswap_prepare_failed';
    return blocked(kind, `Uniswap could not prepare a native wallet batch (${code}).`, code);
  }
  const payload = { chain: 'eip155:8453', actionType: 'uniswap_swap' as const, calls: prepared.calls };
  const guard = await baseAppNativeRuntime.evaluate({
    chain: 8453,
    actionType: payload.actionType,
    calls: payload.calls,
    instruction: input.message,
    providerContext: security.providerContext,
    tokenSecurity: security.tokenSecurity,
    uniswap: prepared.context,
  });
  if (!guard.allowed) return blocked(kind, `Uniswap batch failed strict preflight (${guard.code}).`, 'uniswap_preflight_blocked');

  const actionId = crypto.randomUUID();
  const expiresAt = new Date(Math.min(policy.expiresAt, Date.parse(prepared.expiresAt))).toISOString();
  const context = { ...prepared.context, expiresAt };
  await baseAppNativeRuntime.insertAction({
    id: actionId,
    userId: input.userId,
    kind: 'transaction',
    status: 'pending',
    suggestedPrompt: input.message,
    executionPayload: JSON.stringify(payload),
    metadata: {
      type: 'recommendation',
      title: `Swap ${intent.amount} USDC to ${intent.tokenOut}`,
      instruction: input.message,
      reason: 'Official Uniswap 5792 calldata prepared for the authenticated BaseApp wallet.',
      actionType: payload.actionType,
      chainMode: 'mainnet',
      walletAddress,
      userConfirmable: true,
      executable: false,
      executionStatus: 'user-confirmable',
      safetyState: 'user-confirmable',
      createdBy: 'baseapp-native-routing',
      expiresAt,
      uniswap: { ...context, requestId: prepared.requestId },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return {
    kind,
    content: `I prepared a ${intent.amount} USDC → ${intent.tokenOut} Uniswap batch for your current BaseApp wallet. Review it in Action Inbox and confirm with wallet_sendCalls; no Base MCP approval URL was created.`,
    toolCalls: [],
    actionId,
    actionExpiresAt: expiresAt,
    preparedPayload: { executionPayload: payload, tenantId: input.userId, walletAddress, expiresAt },
  };
}
