import { Router, Request, Response, type RequestHandler } from 'express';
import { tenantUserId } from '../../middleware/tenantAuth';
import { createRequireOperatorAuth } from '../../middleware/operatorAuth.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { base } from '@base-org/account/node';
import {
  createX402MiddlewareFromEnv,
  x402MiddlewareDiagnosticsFromEnv,
  x402ConfigFromEnv,
  x402StatusFromEnv,
  classifyX402SettleFailureReason,
  getDefaultX402BuyerPayerRuntime,
  type X402BuyerPayerRuntime,
  type SupportedX402Network,
  type X402MiddlewareRuntimeMode,
  type X402SettlementRecord,
  X402BuyerUnavailableError,
} from '@mioagent/x402-gateway';
import {
  db,
  client as sql,
  auditLogs,
  spendPermissions,
  x402Receipts,
} from '@mioagent/db';
import {
  FuelChargeService,
  createDatabaseSpendPermissionRepository,
  listFuelReservations,
  type SpendPermissionRepository,
  type FuelCategory,
} from '@mioagent/autonomy';
import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';
import { eq, desc, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  X402FuelResponseSchema,
  X402FuelOwnerResponseSchema,
  X402FuelPermissionRequestSchema,
  X402FuelPermissionResponseSchema,
  X402LedgerResponseSchema,
  X402PricingResponseSchema,
} from '@mioagent/api-zod';

const smokeRunIdStorage = new AsyncLocalStorage<string | undefined>();

function extractRunId(req: Request): string | undefined {
  const q = req.query.runId || req.query.attemptId;
  if (typeof q === 'string' && q) return q;
  const h = req.headers['x-miorail-smoke-run-id'] || req.headers['x-idempotency-key'];
  if (typeof h === 'string' && h) return h;
  return undefined;
}

interface CreateX402RouterOptions {
  env?: NodeJS.ProcessEnv;
  runtimeMode?: X402MiddlewareRuntimeMode;
  middlewareFactory?: (routePath: string) => RequestHandler;
  buyerPaidFetch?: typeof fetch;
  buyerPayerRuntime?: X402BuyerPayerRuntime;
  subscriptionOwnerWalletResolver?: () => Promise<SubscriptionOwnerWallet>;
  subscriptionOwnerReadinessResolver?: (
    wallet: SubscriptionOwnerWallet,
    network: SupportedX402Network,
    env: NodeJS.ProcessEnv,
  ) => Promise<SubscriptionOwnerReadiness>;
  findActiveFuelPermission?: (userId: string, dbEnabled: boolean) => Promise<any>;
  spendPermissionRepository?: SpendPermissionRepository;
  fuelChargeServiceFactory?: (repository: SpendPermissionRepository) => Pick<FuelChargeService, 'reserve' | 'release' | 'preflightReserved' | 'chargeReserved'>;
  dbEnabled?: boolean;
}

interface SubscriptionOwnerWallet {
  address: string;
  walletName: string;
  eoaAddress?: string;
}

interface SubscriptionOwnerReadiness {
  ready: boolean;
  deployed: boolean;
  nativeBalancePresent: boolean;
  gasSponsored: boolean;
  errorCode?: 'subscription_owner_gas_unavailable' | 'subscription_owner_deploy_funding_required' | 'subscription_owner_rpc_unavailable';
}

class SubscriptionOwnerUnavailableError extends Error {
  constructor(
    message: string,
    readonly errorCode: string,
    readonly missingConfig: string[] = [],
  ) {
    super(message);
  }
}

const subscriptionOwnerWalletCache = new Map<string, { wallet: SubscriptionOwnerWallet; expiresAt: number }>();

function receiptId(record: X402SettlementRecord): string {
  if (record.txHash) return `x402:${record.network}:${record.txHash}`;
  return `x402:${randomUUID()}`;
}

let lastSmokeSettlement: {
  status: string;
  payer?: string;
  txHash?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  settledAt?: string;
  errorReason?: string;
  errorMessage?: string;
} | null = null;

let lastBrowserRun: {
  runId: string;
  status: string;
  txHash?: string;
  payer?: string;
  settledAt?: string;
  errorReason?: string;
} | null = null;

function sanitizedUrlHost(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

function subscriptionWalletName(env: NodeJS.ProcessEnv = process.env): string {
  return env.BASE_SUBSCRIPTION_WALLET_NAME ||
    env.CDP_SUBSCRIPTION_WALLET_NAME ||
    'miorail-fuel-subscription-owner';
}

function missingSubscriptionOwnerConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ['CDP_API_KEY_ID', env.CDP_API_KEY_ID],
    ['CDP_API_KEY_SECRET', env.CDP_API_KEY_SECRET],
    ['CDP_WALLET_SECRET', env.CDP_WALLET_SECRET],
  ].filter(([, value]) => !value).map(([name]) => String(name));
}

function isAddress(value?: string | null): boolean {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

async function getSubscriptionOwnerWallet(env: NodeJS.ProcessEnv = process.env): Promise<SubscriptionOwnerWallet> {
  const missingConfig = missingSubscriptionOwnerConfig(env);
  if (missingConfig.length > 0) {
    throw new SubscriptionOwnerUnavailableError(
      'CDP subscription owner wallet config is incomplete.',
      'subscription_owner_missing_config',
      missingConfig,
    );
  }

  const walletName = subscriptionWalletName(env);
  const cached = subscriptionOwnerWalletCache.get(walletName);
  if (cached && cached.expiresAt > Date.now()) return cached.wallet;

  try {
    const wallet = await base.subscription.getOrCreateSubscriptionOwnerWallet({ walletName });
    if (!isAddress(wallet.address)) {
      throw new SubscriptionOwnerUnavailableError(
        'CDP subscription owner wallet returned an invalid address.',
        'subscription_owner_invalid_address',
      );
    }
    const publicWallet = {
      address: wallet.address,
      walletName: wallet.walletName || walletName,
      eoaAddress: wallet.eoaAddress,
    };
    subscriptionOwnerWalletCache.set(walletName, {
      wallet: publicWallet,
      expiresAt: Date.now() + 5 * 60_000,
    });
    return publicWallet;
  } catch (error) {
    if (error instanceof SubscriptionOwnerUnavailableError) throw error;
    throw new SubscriptionOwnerUnavailableError(
      'CDP subscription owner wallet is unavailable.',
      'subscription_owner_unavailable',
    );
  }
}

function rpcUrlForNetwork(network?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (network === 'eip155:84532') {
    return env.BASE_SEPOLIA_RPC_URL || env.BASE_RPC_URL || 'https://sepolia.base.org';
  }
  if (network === 'eip155:8453' || !network) {
    return env.BASE_MAINNET_RPC_URL || env.BASE_RPC_URL || 'https://mainnet.base.org';
  }
  return undefined;
}

async function rpcHexResult(rpcUrl: string, method: 'eth_getCode' | 'eth_getBalance', address: string): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: method,
      method,
      params: [address, 'latest'],
    }),
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
  const body = await response.json() as { result?: unknown; error?: unknown };
  if (body.error || typeof body.result !== 'string') throw new Error(`RPC ${method} returned an invalid response`);
  return body.result;
}

async function checkSubscriptionOwnerReadiness(
  wallet: SubscriptionOwnerWallet,
  network: SupportedX402Network,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubscriptionOwnerReadiness> {
  const rpcUrl = rpcUrlForNetwork(network, env);
  if (!rpcUrl) {
    return {
      ready: false,
      deployed: false,
      nativeBalancePresent: false,
      gasSponsored: Boolean(env.PAYMASTER_URL),
      errorCode: 'subscription_owner_rpc_unavailable',
    };
  }

  try {
    const [code, balance] = await Promise.all([
      rpcHexResult(rpcUrl, 'eth_getCode', wallet.address),
      rpcHexResult(rpcUrl, 'eth_getBalance', wallet.address),
    ]);
    const deployed = code !== '0x' && code !== '0x0';
    const nativeBalancePresent = BigInt(balance) > 0n;
    const gasSponsored = Boolean(env.PAYMASTER_URL);
    const ready = gasSponsored || nativeBalancePresent;
    return {
      ready,
      deployed,
      nativeBalancePresent,
      gasSponsored,
      ...(!ready
        ? { errorCode: deployed ? 'subscription_owner_gas_unavailable' as const : 'subscription_owner_deploy_funding_required' as const }
        : {}),
    };
  } catch {
    return {
      ready: false,
      deployed: false,
      nativeBalancePresent: false,
      gasSponsored: Boolean(env.PAYMASTER_URL),
      errorCode: 'subscription_owner_rpc_unavailable',
    };
  }
}

async function detectPayerWalletType(
  payer?: string | null,
  network?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ addressPresent: boolean; walletType: 'eoa' | 'smart_wallet' | 'unknown'; eip1271Likely: boolean }> {
  if (!payer || !/^0x[a-fA-F0-9]{40}$/.test(payer)) {
    return { addressPresent: Boolean(payer), walletType: 'unknown', eip1271Likely: false };
  }
  const rpcUrl = rpcUrlForNetwork(network, env);
  if (!rpcUrl) return { addressPresent: true, walletType: 'unknown', eip1271Likely: false };
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [payer, 'latest'],
      }),
      signal: AbortSignal.timeout(1500),
    });
    const body = await response.json() as { result?: unknown };
    const code = typeof body.result === 'string' ? body.result : '0x';
    const smart = code !== '0x' && code !== '0x0';
    return {
      addressPresent: true,
      walletType: smart ? 'smart_wallet' : 'eoa',
      eip1271Likely: smart,
    };
  } catch {
    return { addressPresent: true, walletType: 'unknown', eip1271Likely: false };
  }
}

function mapDiagnosticFailureReason(
  reason?: string | null,
  message?: string | null,
  payer?: { walletType?: string; eip1271Likely?: boolean },
): string | null {
  const text = [reason, message].filter(Boolean).join(' ').toLowerCase();
  if (!text && !payer?.eip1271Likely) return null;
  if (payer?.eip1271Likely && /(settlement|revert|authorization|signature|eip-?3009|exact|smart|1271)/i.test(text || 'settlement')) {
    return 'smart_wallet_unsupported_by_exact';
  }
  if (/unauthori[sz]ed|forbidden|auth|jwt|401|403/.test(text)) return 'facilitator_auth';
  if (/insufficient|balance|funds?|allowance|usdc/.test(text)) return 'insufficient_usdc';
  if (/network|chain|unsupported|8453|84532/.test(text)) return 'network_mismatch';
  return reason || 'settlement_failed';
}

async function persistSettlement(record: X402SettlementRecord, persistDb = true): Promise<void> {
  const id = receiptId(record);
  const runId = smokeRunIdStorage.getStore() || (record as any).runId || undefined;
  lastSmokeSettlement = {
    status: record.status || 'settled',
    payer: record.payer || undefined,
    txHash: record.txHash || undefined,
    network: record.network,
    amount: record.amount,
    asset: record.asset,
    payTo: record.payTo,
    settledAt: new Date().toISOString(),
  };
  if (runId) {
    lastBrowserRun = {
      runId,
      status: record.status || 'settled',
      txHash: record.txHash || undefined,
      payer: record.payer || undefined,
      settledAt: new Date().toISOString(),
    };
  }
  if (record.txHash) {
    console.info('[x402] x402-browser-payment-settled', {
      status: 'settled',
      payer: record.payer || 'unknown',
      txHash: record.txHash,
      runId,
    });
  } else {
    console.info('[x402] x402-browser-payment-settled-degraded', {
      status: 'settled',
      payer: record.payer || 'unknown',
      proofStatus: 'state_only_tx_unavailable',
      runId,
    });
  }
  const detailsRecord = record.details && typeof record.details === 'object' ? record.details : {};
  const receipt = {
    ...record,
    id,
    runId,
    direction: (record as any).direction || 'incoming_seller_smoke',
    category: (record as any).category || 'dev_smoke',
    details: {
      ...detailsRecord,
      ...(runId ? { runId } : {}),
    },
    ...(record.userId ? { userId: record.userId } : {}),
  };
  if (!persistDb) return;
  try {
    await db.insert(x402Receipts).values({
      id,
      receipt,
      updatedAt: new Date(),
    });
  } catch (error) {
    // Duplicate tx hashes should not turn a successful paid response into a
    // user-visible failure. The facilitator remains source of truth.
    console.warn('[x402] failed to persist settlement record', {
      code: error instanceof Error ? error.name : 'unknown_error',
    });
  }
}

function recordSettlementFailure(failure: { errorReason?: string; errorMessage?: string; checkedAt: string }): void {
  const reason = classifyX402SettleFailureReason(failure.errorReason, failure.errorMessage);
  const runId = smokeRunIdStorage.getStore();
  lastSmokeSettlement = {
    status: 'failed',
    settledAt: failure.checkedAt,
    errorReason: reason,
    errorMessage: failure.errorMessage,
  };
  if (runId) {
    lastBrowserRun = {
      runId,
      status: 'failed',
      settledAt: failure.checkedAt,
      errorReason: reason,
    };
  }
  console.info('[x402] x402-browser-payment-settlement-failed', {
    status: 'failed',
    reason,
    runId,
  });
}

function receiptRecord(row: { id: string; receipt: unknown; createdAt: Date }): X402SettlementRecord & {
  id: string;
  createdAt: Date;
  userId?: string;
  runId?: string;
  direction?: 'incoming_seller_smoke' | 'outgoing_buyer_payment';
  category?: FuelCategory;
  fuelPermissionId?: string;
  fuelChargeId?: string;
  fuelChargeTxHash?: string;
} {
  const receipt = row.receipt && typeof row.receipt === 'object' ? row.receipt as Record<string, unknown> : {};
  const details = receipt.details && typeof receipt.details === 'object' ? receipt.details as Record<string, unknown> : {};
  const runId =
    typeof receipt.runId === 'string'
      ? receipt.runId
      : typeof details.runId === 'string'
        ? details.runId
        : undefined;
  return {
    id: String(receipt.id || row.id),
    userId: typeof receipt.userId === 'string' ? receipt.userId : undefined,
    runId,
    actionId: typeof receipt.actionId === 'string' ? receipt.actionId : undefined,
    actionType: typeof receipt.actionType === 'string' ? receipt.actionType : undefined,
    direction: receipt.direction === 'outgoing_buyer_payment' ? 'outgoing_buyer_payment' : 'incoming_seller_smoke',
    category: typeof receipt.category === 'string' ? receipt.category as FuelCategory : undefined,
    fuelPermissionId: typeof receipt.fuelPermissionId === 'string' ? receipt.fuelPermissionId : undefined,
    fuelChargeId: typeof receipt.fuelChargeId === 'string' ? receipt.fuelChargeId : undefined,
    fuelChargeTxHash: typeof receipt.fuelChargeTxHash === 'string' ? receipt.fuelChargeTxHash : undefined,
    cost: typeof receipt.cost === 'string' ? receipt.cost : null,
    txHash: typeof receipt.txHash === 'string' ? receipt.txHash : null,
    network: typeof receipt.network === 'string' ? receipt.network : '',
    asset: typeof receipt.asset === 'string' ? receipt.asset : '',
    amount: typeof receipt.amount === 'string' ? receipt.amount : '0',
    payTo: typeof receipt.payTo === 'string' ? receipt.payTo : '',
    payer: typeof receipt.payer === 'string' ? receipt.payer : undefined,
    status: receipt.status === 'pending' || receipt.status === 'failed' ? receipt.status : 'settled',
    attribution: receipt.attribution && typeof receipt.attribution === 'object' ? receipt.attribution as any : {},
    checkedAt: typeof receipt.checkedAt === 'string' ? receipt.checkedAt : row.createdAt.toISOString(),
    source: 'x402-facilitator',
    errorReason: typeof receipt.errorReason === 'string' ? receipt.errorReason : undefined,
    errorMessage: typeof receipt.errorMessage === 'string' ? receipt.errorMessage : undefined,
    createdAt: row.createdAt,
  };
}

function atomicUsdcToDecimal(amount: string): string {
  try {
    const value = BigInt(amount || '0');
    const units = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return fraction ? `${units}.${fraction}` : units.toString();
  } catch {
    return '0';
  }
}

function decimalString(value: unknown): string {
  const num = typeof value === 'number' ? value : Number(value || 0);
  if (!Number.isFinite(num)) return '0';
  return Number.isInteger(num) ? String(num) : num.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function ledgerCategory(actionType: string, explicit?: string): FuelCategory {
  if (explicit === 'inference' || explicit === 'premium_data' || explicit === 'mcp_tool' || explicit === 'execution' || explicit === 'dev_smoke') {
    return explicit;
  }
  if (actionType === 'inference_call') return 'inference';
  if (actionType === 'premium_security_scan' || actionType === 'security_screening') return 'premium_data';
  if (actionType === 'swap_execution' || actionType === 'execution') return 'execution';
  if (actionType === 'x402_smoke_paid' || actionType === 'x402_buyer_smoke') return 'dev_smoke';
  return 'mcp_tool';
}

function isReadOnlyActionType(actionType: string): boolean {
  return actionType === 'portfolio_scan' ||
    actionType === 'portfolio_review' ||
    actionType === 'risk_recommendation' ||
    actionType === 'read_only_recommendation';
}

type LedgerSummaryEntry = {
  direction?: 'incoming_seller_smoke' | 'outgoing_buyer_payment';
  category?: FuelCategory;
  cost?: string | null;
  status?: 'settled' | 'pending' | 'failed';
  txHash?: string | null;
  fuelChargeTxHash?: string;
};

export function summarizeX402LedgerEntries(entries: LedgerSummaryEntry[]) {
  let totalSpent = 0;
  let inferenceSpent = 0;
  let toolsSpent = 0;
  let premiumDataSpent = 0;
  let executionSpent = 0;
  let devSmokeSpent = 0;
  let inferenceCount = 0;
  let toolsCount = 0;
  let premiumDataCount = 0;
  let executionCount = 0;
  let devSmokeCount = 0;
  let failedBuyerAttempts = 0;
  let failedBuyerAttemptsAmount = 0;
  let unreimbursedBuyerAttempts = 0;
  let unreimbursedBuyerAttemptsAmount = 0;
  let pendingBuyerAttempts = 0;
  let sellerSmokeDiagnostics = 0;

  for (const entry of entries) {
    const isBuyer = entry.direction === 'outgoing_buyer_payment';
    if (!isBuyer) {
      sellerSmokeDiagnostics++;
      continue;
    }

    const cost = Number(entry.cost || 0);
    const costVal = Number.isFinite(cost) ? cost : 0;
    if (entry.status === 'failed') {
      failedBuyerAttempts++;
      failedBuyerAttemptsAmount += costVal;
      if (entry.txHash && !entry.fuelChargeTxHash) {
        unreimbursedBuyerAttempts++;
        unreimbursedBuyerAttemptsAmount += costVal;
      }
      continue;
    }
    if (entry.status === 'pending') {
      pendingBuyerAttempts++;
      continue;
    }
    if (entry.status !== 'settled') continue;

    totalSpent += costVal;
    switch (entry.category) {
      case 'inference':
        inferenceSpent += costVal;
        inferenceCount++;
        break;
      case 'premium_data':
        premiumDataSpent += costVal;
        premiumDataCount++;
        break;
      case 'execution':
        executionSpent += costVal;
        executionCount++;
        break;
      case 'dev_smoke':
        devSmokeSpent += costVal;
        devSmokeCount++;
        break;
      default:
        toolsSpent += costVal;
        toolsCount++;
        break;
    }
  }

  return {
    totalSpentUsdc: totalSpent.toFixed(4),
    inferenceSpentUsdc: inferenceSpent.toFixed(4),
    toolsSpentUsdc: toolsSpent.toFixed(4),
    premiumDataSpentUsdc: premiumDataSpent.toFixed(4),
    executionSpentUsdc: executionSpent.toFixed(4),
    devSmokeSpentUsdc: devSmokeSpent.toFixed(4),
    failedBuyerAttemptsUsdc: failedBuyerAttemptsAmount.toFixed(4),
    unreimbursedBuyerAttemptsUsdc: unreimbursedBuyerAttemptsAmount.toFixed(4),
    inferenceCallsCount: inferenceCount,
    toolsCallsCount: toolsCount,
    premiumDataCallsCount: premiumDataCount,
    executionCallsCount: executionCount,
    devSmokeCallsCount: devSmokeCount,
    failedBuyerAttemptsCount: failedBuyerAttempts,
    unreimbursedBuyerAttemptsCount: unreimbursedBuyerAttempts,
    pendingBuyerAttemptsCount: pendingBuyerAttempts,
    sellerSmokeDiagnosticsCount: sellerSmokeDiagnostics,
  };
}

async function findActiveFuelPermission(userId: string, dbEnabled = true) {
  if (!dbEnabled) return null;
  const rows = await db.select()
    .from(spendPermissions)
    .where(and(eq(spendPermissions.userId, userId), eq(spendPermissions.isActive, true)))
    .orderBy(desc(spendPermissions.updatedAt))
    .limit(1);
  return rows[0] || null;
}

function permissionResponse(row: Awaited<ReturnType<typeof findActiveFuelPermission>> | any) {
  if (!row) return null;
  const limit = Number(row.limit || 0);
  const spent = Number(row.spent || 0);
  const remaining = Math.max(0, limit - spent);
  const expiresAtMs = row.expiresAt instanceof Date
    ? row.expiresAt.getTime()
    : typeof row.expiresAt === 'number'
      ? row.expiresAt
      : new Date(String(row.expiresAt)).getTime();
  return {
    id: row.id,
    userId: row.userId,
    chainId: row.chainId,
    asset: row.asset,
    limitUsdc: decimalString(limit),
    spentUsdc: decimalString(spent),
    remainingUsdc: decimalString(remaining),
    expiresAt: new Date(expiresAtMs).toISOString(),
    isActive: row.isActive,
    whitelist: Array.isArray(row.whitelist) ? row.whitelist.map(String) : [],
  };
}

async function persistBuyerReceipt(input: {
  userId: string;
  permissionId: string;
  fuelChargeId?: string;
  fuelChargeTxHash?: string;
  payer?: string;
  amountUsdc: string;
  category: FuelCategory;
  proofTxHash?: string;
  network?: SupportedX402Network;
  asset?: string;
  payTo?: string;
  status: 'settled' | 'pending' | 'failed';
  details?: Record<string, unknown>;
}, persistDb = true) {
  const id = input.proofTxHash
    ? `x402-buyer:${input.network || 'unknown'}:${input.proofTxHash}`
    : `x402-buyer:${randomUUID()}`;
  const receipt = {
    id,
    userId: input.userId,
    actionId: id,
    actionType: 'x402_buyer_smoke',
    direction: 'outgoing_buyer_payment',
    category: input.category,
    fuelPermissionId: input.permissionId,
    fuelChargeId: input.fuelChargeId,
    fuelChargeTxHash: input.fuelChargeTxHash,
    cost: input.amountUsdc,
    txHash: input.proofTxHash || null,
    network: input.network || '',
    asset: input.asset || '',
    amount: input.amountUsdc,
    payTo: input.payTo || '',
    payer: input.payer,
    status: input.status,
    attribution: { source: 'buyer_fuel', expectedBuilderCode: process.env.BUILDER_CODE },
    checkedAt: new Date().toISOString(),
    source: 'x402-facilitator',
    details: input.details || {},
  };
  if (!persistDb) return receipt;
  await db.insert(x402Receipts).values({
    id,
    userId: input.userId,
    receipt,
    updatedAt: new Date(),
  });
  return receipt;
}

function decodePaymentHeaderProof(headerVal: unknown): { payer?: string; txHash?: string; network?: string } {
  if (typeof headerVal !== 'string' || !headerVal) return {};
  try {
    let parsed: any;
    try {
      parsed = JSON.parse(Buffer.from(headerVal, 'base64').toString('utf8'));
    } catch {
      parsed = JSON.parse(headerVal);
    }
    if (parsed && typeof parsed === 'object') {
      const txHash = typeof parsed.txHash === 'string' ? parsed.txHash : typeof parsed.transaction === 'string' ? parsed.transaction : undefined;
      const payer = typeof parsed.payer === 'string' ? parsed.payer : undefined;
      const network = typeof parsed.network === 'string' ? parsed.network : undefined;
      return { payer, txHash, network };
    }
  } catch {
    // ignore malformed header
  }
  return {};
}

function paymentProofFromResponse(response: globalThis.Response): { payer?: string; txHash?: string; network?: string } {
  return decodePaymentHeaderProof(
    response.headers.get('payment-response') ||
      response.headers.get('x-payment-response') ||
      response.headers.get('Payment-Response') ||
      response.headers.get('X-Payment-Response'),
  );
}

export function createX402Router(options: CreateX402RouterOptions = {}) {
  const router = Router();
  const env = options.env || process.env;
  const runtimeMode = options.runtimeMode || 'auto';
  const dbEnabled = options.dbEnabled !== false;
  const buyerPayerRuntime = options.buyerPayerRuntime || getDefaultX402BuyerPayerRuntime(env);
  const resolveActiveFuelPermission = options.findActiveFuelPermission || findActiveFuelPermission;
  const repository = options.spendPermissionRepository || createDatabaseSpendPermissionRepository(sql);
  const requireDiagnosticsAdmin = createRequireOperatorAuth(env);
  const commonMiddlewareOptions = {
    serviceName: 'Miorail',
    onSettlement: (record: X402SettlementRecord) => persistSettlement(record, dbEnabled),
    onSettlementFailure: recordSettlementFailure,
    runtimeMode,
  };
  const smokeGateway = options.middlewareFactory
    ? options.middlewareFactory('/smoke-paid')
    : createX402MiddlewareFromEnv({
        ...commonMiddlewareOptions,
        routePath: '/smoke-paid',
      }, env);

  router.get(
    '/smoke-paid',
    requireDiagnosticsAdmin,
    (req: Request, _res: Response, next) => {
      const runId = extractRunId(req);
      smokeRunIdStorage.run(runId, () => next());
    },
    smokeGateway,
    (req: Request, res: Response) => {
      res.setHeader('Access-Control-Expose-Headers', 'payment-response, x-payment-response, PAYMENT-REQUIRED');
      const headerProof = decodePaymentHeaderProof(
        res.getHeader('payment-response') ||
        res.getHeader('x-payment-response') ||
        req.headers['payment-response'] ||
        req.headers['x-payment-response']
      );
      const config = x402ConfigFromEnv(env);
      const payer = headerProof.payer || lastSmokeSettlement?.payer || null;
      const txHash = headerProof.txHash || lastSmokeSettlement?.txHash || null;
      const network = headerProof.network || lastSmokeSettlement?.network || config.network || 'eip155:8453';
      const reqRunId = extractRunId(req) || smokeRunIdStorage.getStore();

      if (reqRunId) {
        lastBrowserRun = {
          runId: reqRunId,
          status: 'settled',
          txHash: txHash || undefined,
          payer: payer || undefined,
          settledAt: new Date().toISOString(),
        };
      }

      console.info('[x402] x402-browser-payment-started', {
        route: '/api/x402/smoke-paid',
        runId: reqRunId,
      });

      res.status(200).json({
        ok: true,
        data: 'x402 smoke payment accepted.',
        route: '/api/x402/smoke-paid',
        smokeRoute: '/api/x402/smoke-paid',
        runId: reqRunId,
        settlement: 'settled',
        payer,
        txHash,
        network,
        amount: config.amountAtomic || '1000',
        asset: config.asset || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: config.payTo || '',
      });
    }
  );

  router.get('/diagnostics', requireDiagnosticsAdmin, async (_req: Request, res: Response) => {
    const statusConfig = await x402StatusFromEnv(env);
    const diagnostics = x402MiddlewareDiagnosticsFromEnv(env, {
      runtimeMode,
      smokeRoute: '/api/x402/smoke-paid',
      config: statusConfig,
    });
    const browserPaidAvailable = Boolean(
      diagnostics.configured &&
      diagnostics.officialMiddlewareEnabled &&
      diagnostics.smokeRouteAvailable &&
      diagnostics.settleReady,
    );

    let latestGlobalRecord: { txHash?: string | null; createdAt?: Date } | null = null;
    let browserRunMatched = false;
    if (dbEnabled) {
      const rows = await db.select()
        .from(x402Receipts)
        .orderBy(desc(x402Receipts.createdAt))
        .limit(50);
      const parsed = rows.map(receiptRecord);
      latestGlobalRecord = parsed[0] || null;
      if (lastBrowserRun?.runId) {
        browserRunMatched = parsed.some((r) => r.runId === lastBrowserRun?.runId);
      }
    }

    const payerAddress = lastBrowserRun?.payer || lastSmokeSettlement?.payer || null;
    const lastPayer = await detectPayerWalletType(payerAddress, lastSmokeSettlement?.network || diagnostics.network, env);
    const latestErrorReason = lastSmokeSettlement?.errorReason || lastBrowserRun?.errorReason || null;
    const latestErrorMessage = lastSmokeSettlement?.errorMessage || null;
    const latestSettleFailure = latestErrorReason || latestErrorMessage
      ? {
          errorReason: latestErrorReason,
          errorCode: latestErrorReason,
          mappedReason: mapDiagnosticFailureReason(latestErrorReason, latestErrorMessage, lastPayer),
          checkedAt: lastSmokeSettlement?.settledAt || lastBrowserRun?.settledAt || null,
        }
      : null;

    res.json({
      status: diagnostics.status,
      middlewareMode: diagnostics.middlewareMode,
      officialMiddlewareEnabled: diagnostics.officialMiddlewareEnabled,
      facilitatorHost: diagnostics.facilitatorHost,
      browserPaidFlowAvailable: browserPaidAvailable,
      browserPaidActionAvailable: browserPaidAvailable,
      paymentResponseHeaderReadable: true,
      settleReady: diagnostics.settleReady,
      settleBlockedReason: diagnostics.settleBlockedReason || null,
      probeStatus: diagnostics.probeStatus || null,
      supportedNetworks: diagnostics.supportedNetworks || [],
      buyerPayer: buyerPayerRuntime.status(),
      latestSettleFailure,
      lastPayer,
      latestSettleFailureReason: lastSmokeSettlement?.errorReason || lastBrowserRun?.errorReason || null,
      lastSmokeSettlementStatus: lastSmokeSettlement?.status || null,
      lastSmokeSettlementReason: lastSmokeSettlement?.errorReason || null,
      lastSmokeTxHashPresent: Boolean(lastSmokeSettlement?.txHash),
      lastSmokePayerPresent: Boolean(lastSmokeSettlement?.payer),
      lastBrowserRunId: lastBrowserRun?.runId || null,
      lastBrowserRunStatus: lastBrowserRun?.status || null,
      lastBrowserRunReason: lastBrowserRun?.errorReason || null,
      lastBrowserRunLedgerMatched: browserRunMatched,
      lastBrowserRunTxHashPresent: Boolean(lastBrowserRun?.txHash),
      lastBrowserRunPayerPresent: Boolean(lastBrowserRun?.payer),
      lastGlobalLedgerTxHashPresent: Boolean(latestGlobalRecord?.txHash),
      lastGlobalLedgerCreatedAt: latestGlobalRecord?.createdAt ? latestGlobalRecord.createdAt.toISOString() : null,
      configured: diagnostics.configured,
      network: diagnostics.network,
      chainId: diagnostics.chainId,
      asset: diagnostics.asset,
      payToConfigured: diagnostics.payToConfigured,
      builderCodeConfigured: diagnostics.builderCodeConfigured,
      builderCodeAttribution: diagnostics.builderCodeAttribution,
      facilitatorAuthConfigured: diagnostics.facilitatorAuthConfigured,
      authSource: diagnostics.authSource,
      smokeRoute: diagnostics.smokeRoute,
      smokeRouteAvailable: diagnostics.smokeRouteAvailable,
      eip712DomainAttached: diagnostics.eip712DomainAttached,
      eip712DomainName: diagnostics.eip712DomainName,
      eip712DomainVersion: diagnostics.eip712DomainVersion,
      errorCode: diagnostics.errorCode,
      missingConfig: diagnostics.missingConfig,
      warnings: diagnostics.warnings,
    });
  });

  const resolveSubscriptionOwnerWallet = options.subscriptionOwnerWalletResolver || (() => getSubscriptionOwnerWallet(env));
  const resolveSubscriptionOwnerReadiness = options.subscriptionOwnerReadinessResolver || checkSubscriptionOwnerReadiness;

  router.get('/fuel/subscription-owner', async (_req: Request, res: Response) => {
    const chainId = 8453;
    const asset = canonicalUsdcForBaseChain(chainId);
    try {
      const wallet = await resolveSubscriptionOwnerWallet();
      res.json(X402FuelOwnerResponseSchema.parse({
        status: 'ready',
        configured: true,
        accountAddressPresent: true,
        subscriptionOwner: wallet.address,
        walletName: wallet.walletName,
        chainId,
        asset,
        testnet: false,
        missingConfig: [],
      }));
    } catch (error) {
      const unavailable = error instanceof SubscriptionOwnerUnavailableError
        ? error
        : new SubscriptionOwnerUnavailableError('Subscription owner wallet unavailable.', 'subscription_owner_unavailable');
      res.status(503).json(X402FuelOwnerResponseSchema.parse({
        status: unavailable.missingConfig.length ? 'missing_config' : 'unavailable',
        configured: unavailable.missingConfig.length === 0,
        accountAddressPresent: false,
        walletName: subscriptionWalletName(env),
        chainId,
        asset,
        testnet: false,
        missingConfig: unavailable.missingConfig,
        errorCode: unavailable.errorCode,
      }));
    }
  });

  router.post('/fuel/permission', async (req: Request, res: Response, next) => {
    try {
      const parsed = X402FuelPermissionRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: 'invalid_fuel_permission_request',
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        });
      }

      const input = parsed.data;
      const userId = tenantUserId(req);
      const wallet = await resolveSubscriptionOwnerWallet();
      if (wallet.address.toLowerCase() !== input.subscriptionOwner.toLowerCase()) {
        return res.status(400).json({
          error: 'subscription_owner_mismatch',
          expectedOwnerPresent: true,
        });
      }

      const limit = Number(input.limitUsdc);
      const recurringCharge = Number(input.recurringCharge || input.limitUsdc);
      if (!Number.isFinite(limit) || limit <= 0) {
        return res.status(400).json({ error: 'invalid_fuel_limit' });
      }
      if (Number.isFinite(recurringCharge) && limit > recurringCharge + 0.000001) {
        return res.status(400).json({ error: 'limit_exceeds_subscription_charge' });
      }

      const ttlHours = input.ttlHours ?? Math.max(24, (input.periodInDays || 30) * 24);
      const expiresAt = Date.now() + ttlHours * 60 * 60 * 1000;
      const asset = canonicalUsdcForBaseChain(8453);

      if (dbEnabled) {
        await db.update(spendPermissions)
          .set({ isActive: false, updatedAt: new Date() })
          .where(and(eq(spendPermissions.userId, userId), eq(spendPermissions.chainId, 8453), eq(spendPermissions.isActive, true)));
      }

      const permission = {
        id: input.id,
        userId,
        chainId: 8453,
        asset,
        limit,
        spent: 0,
        whitelist: [asset, wallet.address, input.subscriptionPayer].filter(Boolean) as string[],
        expiresAt,
        isActive: true,
      };
      await repository.create(permission);
      const stored = await repository.getById(input.id) || permission;
      res.status(201).json(X402FuelPermissionResponseSchema.parse({
        success: true,
        status: 'ready',
        subscriptionId: input.id,
        activePermission: permissionResponse(stored),
      }));
    } catch (error) {
      if (error instanceof SubscriptionOwnerUnavailableError) {
        return res.status(503).json({
          error: 'subscription_owner_unavailable',
          errorCode: error.errorCode,
          missingConfig: error.missingConfig,
        });
      }
      next(error);
    }
  });

  router.get('/fuel', async (req: Request, res: Response, next) => {
    try {
      const userId = tenantUserId(req);
      const statusConfig = await x402StatusFromEnv(env);
      const active = await resolveActiveFuelPermission(userId, dbEnabled);
      const activePermission = permissionResponse(active);
      const pending = activePermission ? listFuelReservations(activePermission.id) : [];

      let records: ReturnType<typeof receiptRecord>[] = [];
      if (dbEnabled) {
        const rows = await db.select()
          .from(x402Receipts)
          .where(eq(x402Receipts.userId, userId))
          .orderBy(desc(x402Receipts.createdAt))
          .limit(100);
        records = rows.map(receiptRecord)
          .filter((record) => record.userId === userId);
      }

      const spend = {
        inference: 0,
        premiumData: 0,
        mcpTool: 0,
        execution: 0,
        devSmoke: 0,
      };

      for (const record of records) {
        if (record.direction !== 'outgoing_buyer_payment' || record.status !== 'settled') continue;
        const actionType = record.actionType || 'x402_resource';
        const category = ledgerCategory(actionType, record.category);
        const cost = isReadOnlyActionType(actionType) ? '0' : (record.cost || atomicUsdcToDecimal(record.amount));
        const costVal = Number(cost || 0);
        if (!Number.isFinite(costVal)) continue;
        if (category === 'inference') spend.inference += costVal;
        if (category === 'premium_data') spend.premiumData += costVal;
        if (category === 'mcp_tool') spend.mcpTool += costVal;
        if (category === 'execution') spend.execution += costVal;
        if (category === 'dev_smoke') spend.devSmoke += costVal;
      }

      const recentReceipts = records.slice(0, 20).map((record) => {
        const actionType = record.actionType || 'x402_resource';
        const category = ledgerCategory(actionType, record.category);
        const cost = isReadOnlyActionType(actionType) ? '0' : (record.cost || atomicUsdcToDecimal(record.amount));
        return {
          id: record.id,
          runId: record.runId,
          actionId: record.actionId || record.id,
          actionType,
          direction: record.direction || 'incoming_seller_smoke',
          category,
          fuelPermissionId: record.fuelPermissionId,
          fuelChargeId: record.fuelChargeId,
          fuelChargeTxHash: record.fuelChargeTxHash,
          cost,
          txHash: record.txHash,
          network: record.network,
          asset: record.asset,
          amount: record.amount,
          payTo: record.payTo,
          status: record.status,
          settlementStatus: record.status,
          attribution: record.attribution,
          createdAt: record.createdAt.toISOString(),
          settlement: record.status,
          details: {
            source: record.source,
            checkedAt: record.checkedAt,
            direction: record.direction || 'incoming_seller_smoke',
          },
        };
      });

      const response = {
        status: !activePermission
          ? 'missing_permission'
          : !activePermission.isActive
            ? 'permission_inactive'
            : Date.now() > new Date(activePermission.expiresAt).getTime()
              ? 'permission_expired'
              : Number(activePermission.remainingUsdc) <= 0
                ? 'limit_exhausted'
                : 'ready',
        mode: 'buyer' as const,
        activePermission,
        pendingReservations: pending.map((reservation) => ({
          id: reservation.id,
          amountUsdc: decimalString(reservation.amount),
          category: reservation.category,
          createdAt: reservation.createdAt,
        })),
        spendByCategory: {
          inference: spend.inference.toFixed(4),
          premiumData: spend.premiumData.toFixed(4),
          mcpTool: spend.mcpTool.toFixed(4),
          execution: spend.execution.toFixed(4),
          devSmoke: spend.devSmoke.toFixed(4),
        },
        recentReceipts,
        buyerSmoke: {
          configured: Boolean(env.X402_BUYER_SMOKE_URL),
          urlHost: sanitizedUrlHost(env.X402_BUYER_SMOKE_URL),
        },
        buyerPayer: buyerPayerRuntime.status(),
        x402: {
          settleReady: statusConfig.settleReady,
          status: statusConfig.status,
          network: statusConfig.network,
        },
      };

      res.json(X402FuelResponseSchema.parse(response));
    } catch (error) {
      next(error);
    }
  });

  router.post('/buyer-smoke', requireDiagnosticsAdmin, async (req: Request, res: Response, next) => {
    try {
      const userId = tenantUserId(req);
      const smokeUrl = env.X402_BUYER_SMOKE_URL;
      if (!smokeUrl) {
        return res.status(503).json({
          error: 'x402_buyer_smoke_not_configured',
          missingConfig: ['X402_BUYER_SMOKE_URL'],
        });
      }
      const active = await resolveActiveFuelPermission(userId, dbEnabled);
      if (!active) {
        return res.status(402).json({ error: 'fuel_permission_required', status: 'missing_permission' });
      }
      const amount = Number(env.X402_BUYER_SMOKE_AMOUNT_USDC || req.body?.amountUsdc || 0.001);
      const category: FuelCategory = 'dev_smoke';
      const fuel = options.fuelChargeServiceFactory
        ? options.fuelChargeServiceFactory(repository)
        : new FuelChargeService(repository, {
            walletName: subscriptionWalletName(env),
            paymasterUrl: env.PAYMASTER_URL,
            rpcUrl: rpcUrlForNetwork(`eip155:${active.chainId}`, env),
          });
      const fuelInput = {
        permissionId: active.id,
        amount,
        category,
        chainEnv: env.CHAIN_ENV || active.chainId,
      };
      const reserved = await fuel.reserve(fuelInput);
      if (!reserved.success || !reserved.reservation) {
        return res.status(402).json({
          error: 'fuel_reservation_failed',
          status: reserved.status,
          message: reserved.error,
        });
      }

      let paidFetch = options.buyerPaidFetch;
      if (!paidFetch) {
        try {
          paidFetch = await buyerPayerRuntime.getPaidFetch();
        } catch (error) {
          fuel.release(reserved.reservation.id);
          const errorCode = error instanceof X402BuyerUnavailableError
            ? error.errorCode
            : 'x402_buyer_payer_unavailable';
          return res.status(503).json({
            error: 'x402_buyer_unavailable',
            errorCode,
            buyerPayer: buyerPayerRuntime.status(),
            note: 'Buyer x402 uses a CDP-managed payer account; no user key is stored or requested.',
          });
        }
      }

      let ownerWallet: SubscriptionOwnerWallet;
      try {
        ownerWallet = await resolveSubscriptionOwnerWallet();
      } catch (error) {
        fuel.release(reserved.reservation.id);
        const unavailable = error instanceof SubscriptionOwnerUnavailableError
          ? error
          : new SubscriptionOwnerUnavailableError('Subscription owner wallet unavailable.', 'subscription_owner_unavailable');
        return res.status(503).json({
          error: 'fuel_charge_preflight_failed',
          status: unavailable.errorCode,
          missingConfig: unavailable.missingConfig,
          paidResourceCalled: false,
        });
      }

      const network = `eip155:${active.chainId}` as SupportedX402Network;
      if (network !== 'eip155:8453' && network !== 'eip155:84532') {
        fuel.release(reserved.reservation.id);
        return res.status(503).json({
          error: 'fuel_charge_preflight_failed',
          status: 'unsupported_chain',
          paidResourceCalled: false,
        });
      }

      const chargePreflight = await fuel.preflightReserved({
        ...fuelInput,
        expectedSubscriptionOwner: ownerWallet.address,
      }, reserved.reservation);
      if (!chargePreflight.success) {
        fuel.release(reserved.reservation.id);
        const userLimitFailure = chargePreflight.status === 'limit_exhausted' ||
          chargePreflight.status === 'permission_inactive' ||
          chargePreflight.status === 'permission_expired';
        return res.status(userLimitFailure ? 402 : 503).json({
          error: 'fuel_charge_preflight_failed',
          status: chargePreflight.status,
          message: chargePreflight.error,
          paidResourceCalled: false,
        });
      }

      const ownerReadiness = await resolveSubscriptionOwnerReadiness(ownerWallet, network, env);
      if (!ownerReadiness.ready) {
        fuel.release(reserved.reservation.id);
        return res.status(503).json({
          error: 'fuel_charge_preflight_failed',
          status: ownerReadiness.errorCode,
          paidResourceCalled: false,
          subscriptionOwnerReadiness: ownerReadiness,
        });
      }

      let paidResponse: globalThis.Response;
      try {
        paidResponse = await paidFetch(smokeUrl, {
          headers: { Accept: 'application/json' },
        });
      } catch (error) {
        fuel.release(reserved.reservation.id);
        const statusConfig = x402ConfigFromEnv(env);
        await persistBuyerReceipt({
          userId,
          permissionId: active.id,
          amountUsdc: decimalString(amount),
          category,
          network: statusConfig.network,
          asset: statusConfig.asset,
          payTo: statusConfig.payTo,
          status: 'failed',
          details: {
            source: 'buyer-smoke',
            smokeUrlHost: sanitizedUrlHost(smokeUrl),
            failure: 'buyer_fetch_failed',
          },
        }, dbEnabled);
        return res.status(502).json({
          error: 'x402_buyer_fetch_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (!paidResponse.ok) {
        fuel.release(reserved.reservation.id);
        const statusConfig = x402ConfigFromEnv(env);
        const failedPaymentProof = paymentProofFromResponse(paidResponse);
        await persistBuyerReceipt({
          userId,
          permissionId: active.id,
          amountUsdc: decimalString(amount),
          category,
          proofTxHash: failedPaymentProof.txHash,
          payer: failedPaymentProof.payer,
          network: (failedPaymentProof.network as SupportedX402Network | undefined) || statusConfig.network,
          asset: statusConfig.asset,
          payTo: statusConfig.payTo,
          status: 'failed',
          details: {
            source: 'buyer-smoke',
            smokeUrlHost: sanitizedUrlHost(smokeUrl),
            failure: 'paid_resource_failed',
            resourceStatus: paidResponse.status,
          },
        }, dbEnabled);
        return res.status(502).json({
          error: 'x402_buyer_resource_failed',
          status: paidResponse.status,
        });
      }

      const paymentProof = paymentProofFromResponse(paidResponse);
      if (!paymentProof.txHash) {
        fuel.release(reserved.reservation.id);
        await persistBuyerReceipt({
          userId,
          permissionId: active.id,
          amountUsdc: decimalString(amount),
          category,
          network: paymentProof.network as SupportedX402Network | undefined,
          status: 'failed',
          payer: paymentProof.payer,
          details: {
            source: 'buyer-smoke',
            smokeUrlHost: sanitizedUrlHost(smokeUrl),
            failure: 'missing_x402_payment_proof',
          },
        }, dbEnabled);
        return res.status(502).json({
          error: 'x402_buyer_missing_payment_proof',
          status: 'missing_payment_proof',
          message: 'Paid resource returned success without a durable x402 payment proof.',
        });
      }

      const charge = await fuel.chargeReserved({
        ...fuelInput,
        expectedSubscriptionOwner: ownerWallet.address,
      }, reserved.reservation);
      if (!charge.success) {
        const statusConfig = x402ConfigFromEnv(env);
        await persistBuyerReceipt({
          userId,
          permissionId: active.id,
          amountUsdc: decimalString(amount),
          category,
          fuelChargeId: charge.chargeId,
          fuelChargeTxHash: charge.proof?.txHash,
          proofTxHash: paymentProof.txHash,
          payer: paymentProof.payer,
          network: (paymentProof.network as SupportedX402Network | undefined) || statusConfig.network,
          asset: statusConfig.asset,
          payTo: statusConfig.payTo,
          status: 'failed',
          details: {
            source: 'buyer-smoke',
            smokeUrlHost: sanitizedUrlHost(smokeUrl),
            paymentProof,
            chargeStatus: charge.status,
            chargeError: charge.error,
          },
        }, dbEnabled);
        return res.status(402).json({
          error: 'fuel_charge_failed',
          status: charge.status,
          message: charge.error,
          reconciliationRequired: charge.status === 'accounting_reconciliation_required',
        });
      }

      const statusConfig = x402ConfigFromEnv(env);
      const receipt = await persistBuyerReceipt({
        userId,
        permissionId: active.id,
        fuelChargeId: charge.chargeId,
        fuelChargeTxHash: charge.proof?.txHash,
        amountUsdc: decimalString(amount),
        category,
        proofTxHash: paymentProof.txHash,
        payer: paymentProof.payer,
        network: (paymentProof.network as SupportedX402Network | undefined) || statusConfig.network,
        asset: statusConfig.asset,
        payTo: statusConfig.payTo,
        status: 'settled',
        details: {
          source: 'buyer-smoke',
          smokeUrlHost: sanitizedUrlHost(smokeUrl),
          paymentProof,
          chargeProof: charge.proof,
        },
      }, dbEnabled);

      res.status(200).json({
        ok: true,
        status: 'settled',
        receipt,
        fuelPermissionId: active.id,
        fuelChargeId: charge.chargeId,
        txHash: paymentProof.txHash,
        fuelChargeTxHash: charge.proof?.txHash,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/ledger', async (req: Request, res: Response, next) => {
    try {
      const userId = tenantUserId(req);
      let rows: any[] = [];
      let auditContext: any[] = [];
      if (dbEnabled) {
        rows = await db.select()
          .from(x402Receipts)
          .where(eq(x402Receipts.userId, userId))
          .orderBy(desc(x402Receipts.createdAt))
          .limit(100);
        auditContext = await db.select()
          .from(auditLogs)
          .where(eq(auditLogs.userId, userId))
          .orderBy(desc(auditLogs.createdAt))
          .limit(100);
      }
      const filterRunId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
      const records = rows
        .map(receiptRecord)
        .filter((record) => record.userId === userId)
        .filter((record) => !filterRunId || record.runId === filterRunId);
      const auditByActionId = new Map(auditContext.map((log) => [log.actionId, log]));

      const entries = records.map(record => {
        const audit = record.actionId ? auditByActionId.get(record.actionId) : undefined;
        const actionType = record.actionType || audit?.actionType || 'x402_resource';
        const direction = record.direction || 'incoming_seller_smoke';
        const category = ledgerCategory(actionType, record.category);
        const cost = isReadOnlyActionType(actionType) ? '0' : (record.cost || atomicUsdcToDecimal(record.amount));
        return {
          id: record.id,
          runId: record.runId,
          actionId: record.actionId || audit?.actionId || record.id,
          actionType,
          direction,
          category,
          fuelPermissionId: record.fuelPermissionId,
          fuelChargeId: record.fuelChargeId,
          fuelChargeTxHash: record.fuelChargeTxHash,
          cost,
          txHash: record.txHash,
          network: record.network,
          asset: record.asset,
          amount: record.amount,
          payTo: record.payTo,
          status: record.status,
          settlementStatus: record.status,
          attribution: record.attribution,
          createdAt: record.createdAt.toISOString(),
          settlement: record.status,
          proofStatus: record.txHash ? 'verified_tx' : 'state_only_tx_unavailable',
          details: {
            source: record.source,
            payer: record.payer,
            runId: record.runId,
            checkedAt: record.checkedAt,
            proofStatus: record.txHash ? 'verified_tx' : 'state_only_tx_unavailable',
            errorReason: record.errorReason,
            fuelChargeTxHash: record.fuelChargeTxHash,
            audit: audit?.details || null,
          },
        };
      });

      const response = {
        entries,
        summary: {
          ...summarizeX402LedgerEntries(entries),
          settlement: entries.length > 0 ? 'real' : 'none',
          buyerFuelMode: 'settled_only',
          x402: x402ConfigFromEnv(env).status,
        },
      };

      res.json(X402LedgerResponseSchema.parse(response));
    } catch (error) {
      next(error);
    }
  });

  router.get('/pricing', async (_req: Request, res: Response) => {
    const pricing = [
      { actionType: 'portfolio_scan', label: 'Read-only Portfolio Scan', priceUsdc: '0', description: 'Base portfolio read, provider status, and recommendation metadata stay free.' },
      { actionType: 'premium_security_scan', label: 'Premium Security Scan', priceUsdc: '0.0020', description: 'Paid deep token/security data. Basic read-only recommendations remain free.' },
      { actionType: 'swap_execution', label: 'Swap Simulation & Routing', priceUsdc: '0.0050', description: 'EIP-5792 batch execution preparation and route optimization' },
      { actionType: 'inference_call', label: 'Autonomous AI Inference', priceUsdc: '0.0010', description: 'Agent LLM reasoning and intent classification' },
      { actionType: 'paid_mcp_tool', label: 'Paid MCP Tool Call', priceUsdc: '0.0010', description: 'Outgoing paid tool resource accessed through buyer x402 fuel.' },
    ];
    res.json(X402PricingResponseSchema.parse({ pricing }));
  });

  return router;
}

export const x402Router = createX402Router();
