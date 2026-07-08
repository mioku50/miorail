import { Request, Response, NextFunction, type RequestHandler } from 'express';
import { X402PaymentRequired } from '@mioagent/x402-parser';
import {
  canonicalUsdcForBaseChain,
  normalizeBaseChain,
  type SupportedBaseChainId,
} from '@mioagent/security/baseGuards';
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type RoutesConfig,
  type SettleResultContext,
} from '@x402/core/server';
import type { PaymentRequirements, SettleResponse } from '@x402/core/types';
import { paymentMiddlewareFromHTTPServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import {
  BUILDER_CODE,
  BUILDER_CODE_PATTERN,
  BuilderCodeClientExtension,
  builderCodeResourceServerExtension,
  declareBuilderCodeExtension,
  parseBuilderCodeSuffixFromCalldata,
} from '@x402/extensions/builder-code';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';

export interface X402GatewayConfig {
  paymentRequired: X402PaymentRequired;
  facilitator: X402Facilitator;
}

export interface X402Facilitator {
  verifyReceipt(receipt: string, requiredAmount: string): Promise<boolean>;
}

export class MockFacilitator implements X402Facilitator {
  private usedReceipts = new Set<string>();

  async verifyReceipt(receipt: string, requiredAmount: string): Promise<boolean> {
    if (!receipt) return false;

    // Anti-replay
    if (this.usedReceipts.has(receipt)) {
      return false;
    }

    // Simplistic mock validation based on receipt string contents
    if (receipt.includes('valid-receipt') && receipt.includes(`amount:${requiredAmount}`)) {
      this.usedReceipts.add(receipt);
      return true;
    }

    return false;
  }
}

export type X402RuntimeStatus = 'configured' | 'simulated' | 'missing';
export type X402SettlementStatus = 'settled' | 'pending' | 'failed';
export type SupportedX402Network = `eip155:${SupportedBaseChainId}`;
export type BuilderCodeAttributionRole = 'seller' | 'buyer';

export interface X402RuntimeConfig {
  status: X402RuntimeStatus;
  configured: boolean;
  missingConfig: string[];
  warnings: string[];
  facilitatorUrl?: string;
  payTo?: string;
  network?: SupportedX402Network;
  chainId?: SupportedBaseChainId;
  asset?: string;
  amountAtomic: string;
  builderCode?: string;
}

export interface X402SettlementAttribution {
  expectedBuilderCode?: string;
  seller?: string;
  buyer?: string | string[];
  wallet?: string;
  sellerVerified?: boolean;
  buyerVerified?: boolean;
  source?: 'settlement_extensions' | 'calldata' | 'unavailable';
}

export interface X402SettlementRecord {
  id?: string;
  userId?: string;
  actionId?: string;
  actionType?: string;
  cost?: string | null;
  txHash: string | null;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  payer?: string;
  status: X402SettlementStatus;
  attribution: X402SettlementAttribution;
  checkedAt: string;
  source: 'x402-facilitator' | 'mock';
  errorReason?: string;
  errorMessage?: string;
}

type MinimalSettleResponse = {
  success: boolean;
  transaction?: string;
  network?: string;
  amount?: string;
  payer?: string;
  extensions?: Record<string, unknown>;
  errorReason?: string;
  errorMessage?: string;
};

export interface CreateX402MiddlewareOptions {
  routePath?: string;
  serviceName?: string;
  onSettlement?: (record: X402SettlementRecord, context: SettleResultContext) => Promise<void> | void;
  syncFacilitatorOnStart?: boolean;
}

export const DEFAULT_X402_AMOUNT_ATOMIC_USDC = '1000';
const MOCK_PAYMENT_REQUIRED: X402PaymentRequired = {
  accepts: [
    {
      amount: '1000000',
      payTo: '0x1234567890123456789012345678901234567890',
      asset: '0x036cbd53842c5426634e7929541ec2318f3dCF7e',
      network: '84532',
    },
  ],
};

const BUILDER_CODE_PLACEHOLDERS = new Set([
  'builder_code',
  'change_me',
  'changeme',
  'example',
  'placeholder',
  'replace_me',
  'todo',
  'your_builder_code',
]);

const warningsEmitted = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warningsEmitted.has(key)) return;
  warningsEmitted.add(key);
  console.warn(message);
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function isValidAddress(value: string | undefined): boolean {
  return !!value && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isPositiveIntegerString(value: string): boolean {
  return /^[0-9]+$/.test(value) && BigInt(value) > 0n;
}

export function getBuilderCodeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { warn?: boolean } = {},
): string | undefined {
  const shouldWarn = options.warn ?? true;
  const raw = normalizeOptional(env.BUILDER_CODE || env.VITE_BUILDER_CODE || env.NEXT_PUBLIC_BUILDER_CODE);
  if (!raw || BUILDER_CODE_PLACEHOLDERS.has(raw.toLowerCase())) {
    if (shouldWarn) {
      warnOnce(
        'x402-builder-code-missing',
        '[x402] BUILDER_CODE is missing or placeholder; x402 payments will be unattributed.',
      );
    }
    return undefined;
  }
  if (!BUILDER_CODE_PATTERN.test(raw)) {
    if (shouldWarn) {
      warnOnce(
        'x402-builder-code-invalid',
        '[x402] BUILDER_CODE must match ^[a-z0-9_]{1,32}$; x402 payments will be unattributed.',
      );
    }
    return undefined;
  }
  return raw;
}

export function x402ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): X402RuntimeConfig {
  const missingConfig: string[] = [];
  const warnings: string[] = [];
  const facilitatorUrl = normalizeOptional(env.X402_FACILITATOR_URL);
  const payTo = normalizeOptional(env.X402_PAYTO_ADDRESS);
  const networkRaw = normalizeOptional(env.X402_NETWORK);
  const amountAtomic = normalizeOptional(env.X402_AMOUNT_ATOMIC_USDC) || DEFAULT_X402_AMOUNT_ATOMIC_USDC;
  let network: SupportedX402Network | undefined;
  let chainId: SupportedBaseChainId | undefined;
  let asset: string | undefined;

  if (!facilitatorUrl) missingConfig.push('X402_FACILITATOR_URL');
  if (!payTo) missingConfig.push('X402_PAYTO_ADDRESS');
  if (payTo && !isValidAddress(payTo)) missingConfig.push('X402_PAYTO_ADDRESS');
  if (!networkRaw) {
    missingConfig.push('X402_NETWORK');
  } else {
    try {
      const normalized = normalizeBaseChain(networkRaw);
      network = normalized.caip2;
      chainId = normalized.chainId;
      asset = canonicalUsdcForBaseChain(normalized.chainId);
    } catch {
      missingConfig.push('X402_NETWORK');
      warnings.push('unsupported_network');
    }
  }
  if (!isPositiveIntegerString(amountAtomic)) {
    missingConfig.push('X402_AMOUNT_ATOMIC_USDC');
  }

  if (facilitatorUrl) {
    try {
      const parsed = new URL(facilitatorUrl);
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        missingConfig.push('X402_FACILITATOR_URL');
        warnings.push('facilitator_url_must_be_https');
      }
    } catch {
      missingConfig.push('X402_FACILITATOR_URL');
      warnings.push('invalid_facilitator_url');
    }
  }

  const anyConfigured = !!facilitatorUrl || !!payTo || !!networkRaw;
  const builderCode = getBuilderCodeFromEnv(env, { warn: anyConfigured });
  const configured = missingConfig.length === 0 && !!facilitatorUrl && !!payTo && !!network && !!asset;

  return {
    status: configured ? 'configured' : anyConfigured ? 'missing' : 'simulated',
    configured,
    missingConfig: anyConfigured ? [...new Set(missingConfig)] : [],
    warnings,
    facilitatorUrl,
    payTo,
    network,
    chainId,
    asset,
    amountAtomic,
    builderCode,
  };
}

export function legacyMockPaymentRequired(): X402PaymentRequired {
  return MOCK_PAYMENT_REQUIRED;
}

export function paymentRequiredFromRuntimeConfig(config: X402RuntimeConfig): X402PaymentRequired {
  if (!config.payTo || !config.asset || !config.network) return legacyMockPaymentRequired();
  return {
    accepts: [
      {
        amount: config.amountAtomic,
        payTo: config.payTo,
        asset: config.asset,
        network: config.network,
        version: '2',
      },
    ],
  };
}

export function createX402RoutesConfig(
  config: X402RuntimeConfig,
  routePath = '/mock-paid-endpoint',
  serviceName = 'Miorail',
): RoutesConfig {
  if (!config.configured || !config.payTo || !config.network || !config.asset) {
    throw new Error(`x402 is not configured: ${config.missingConfig.join(', ')}`);
  }

  const routeConfig = {
    accepts: {
      scheme: 'exact',
      payTo: config.payTo,
      price: {
        asset: config.asset,
        amount: config.amountAtomic,
      },
      network: config.network,
      maxTimeoutSeconds: 300,
    },
    resource: routePath,
    description: 'Miorail x402 paid resource',
    mimeType: 'application/json',
    serviceName,
    tags: ['miorail', 'x402'],
    unpaidResponseBody: () => ({
      contentType: 'application/json',
      body: {
        error: 'Payment Required',
        paymentRequired: paymentRequiredFromRuntimeConfig(config),
      },
    }),
    settlementFailedResponseBody: (_context: unknown, settleResult: { errorReason?: string; errorMessage?: string }) => ({
      contentType: 'application/json',
      body: {
        error: 'Payment Required: settlement failed',
        reason: settleResult.errorReason || 'settlement_failed',
      },
    }),
    extensions: config.builderCode
      ? {
          [BUILDER_CODE]: declareBuilderCodeExtension(config.builderCode),
        }
      : undefined,
  };

  return {
    [`GET ${routePath}`]: routeConfig,
  } satisfies RoutesConfig;
}

function attributionFromExtensions(
  result: Pick<SettleResponse, 'extensions'>,
  expectedBuilderCode?: string,
): X402SettlementAttribution {
  const raw = result.extensions?.[BUILDER_CODE] as
    | { a?: string; s?: string | string[]; w?: string }
    | undefined;
  if (!raw) {
    return expectedBuilderCode
      ? { expectedBuilderCode, source: 'unavailable' }
      : { source: 'unavailable' };
  }
  const seller = raw.a;
  const buyer = raw.s;
  return {
    expectedBuilderCode,
    seller,
    buyer,
    wallet: raw.w,
    sellerVerified: expectedBuilderCode ? seller === expectedBuilderCode : undefined,
    buyerVerified: expectedBuilderCode
      ? Array.isArray(buyer)
        ? buyer.includes(expectedBuilderCode)
        : buyer === expectedBuilderCode
      : undefined,
    source: 'settlement_extensions',
  };
}

export function settlementRecordFromSettleResult(
  result: MinimalSettleResponse,
  requirements: Partial<Pick<PaymentRequirements, 'asset' | 'amount' | 'payTo'>>,
  config: X402RuntimeConfig,
  checkedAt = new Date().toISOString(),
): X402SettlementRecord {
  return {
    txHash: result.transaction || null,
    network: result.network || config.network || '',
    asset: requirements.asset || config.asset || '',
    amount: result.amount || requirements.amount || config.amountAtomic,
    payTo: requirements.payTo || config.payTo || '',
    payer: result.payer,
    status: result.success ? 'settled' : 'failed',
    attribution: attributionFromExtensions(result, config.builderCode),
    checkedAt,
    source: 'x402-facilitator',
    errorReason: result.errorReason,
    errorMessage: result.errorMessage,
  };
}

export function createOfficialX402Middleware(
  config: X402RuntimeConfig,
  options: CreateX402MiddlewareOptions = {},
): RequestHandler {
  if (!config.configured || !config.facilitatorUrl || !config.network) {
    throw new Error(`x402 is not configured: ${config.missingConfig.join(', ')}`);
  }

  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: config.facilitatorUrl }),
  ).register(config.network, new ExactEvmScheme());

  if (config.builderCode) {
    resourceServer.registerExtension(builderCodeResourceServerExtension);
  }

  if (options.onSettlement) {
    resourceServer.onAfterSettle(async (context) => {
      await options.onSettlement?.(
        settlementRecordFromSettleResult(context.result, context.requirements, config),
        context,
      );
    });
  }

  const httpServer = new x402HTTPResourceServer(
    resourceServer,
    createX402RoutesConfig(config, options.routePath, options.serviceName),
  );
  return paymentMiddlewareFromHTTPServer(
    httpServer,
    {
      appName: options.serviceName || 'Miorail',
      testnet: config.chainId === 84532,
    },
    undefined,
    options.syncFacilitatorOnStart ?? true,
  );
}

export function createUnavailableX402Middleware(config: X402RuntimeConfig): RequestHandler {
  return (_req, res) => {
    res.status(503).json({
      error: 'x402_not_configured',
      status: config.status,
      missingConfig: config.missingConfig,
    });
  };
}

function isTestRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'test' || env.npm_lifecycle_event === 'test' || process.argv.some((arg) => arg === '--test');
}

export function createX402MiddlewareFromEnv(
  options: CreateX402MiddlewareOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): RequestHandler {
  const config = x402ConfigFromEnv(env);
  if (config.configured && env.NODE_ENV !== 'test') {
    return createOfficialX402Middleware(config, options);
  }
  if (isTestRuntime(env)) {
    return x402Gateway({ paymentRequired: legacyMockPaymentRequired(), facilitator: new MockFacilitator() });
  }
  return createUnavailableX402Middleware(config);
}

function baseChainForNetwork(network: string) {
  return normalizeBaseChain(network).chainId === 8453 ? base : baseSepolia;
}

export function verifyBuilderCodeAttributionFromCalldata(
  calldata: Hex,
  expectedBuilderCode: string,
  role: BuilderCodeAttributionRole,
): boolean {
  const parsed = parseBuilderCodeSuffixFromCalldata(calldata);
  if (!parsed) return false;
  if (role === 'seller') return parsed.a === expectedBuilderCode;
  const serviceCodes = Array.isArray(parsed.s) ? parsed.s : parsed.s ? [parsed.s] : [];
  return serviceCodes.includes(expectedBuilderCode);
}

export async function verifyBuilderCodeAttributionFromTxInput(input: {
  txHash: Hex;
  network: SupportedX402Network;
  expectedBuilderCode: string;
  role: BuilderCodeAttributionRole;
  rpcUrl?: string;
  client?: PublicClient;
}): Promise<boolean> {
  const client =
    input.client ||
    (input.rpcUrl
      ? createPublicClient({ chain: baseChainForNetwork(input.network), transport: http(input.rpcUrl) })
      : undefined);
  if (!client) return false;
  const tx = await client.getTransaction({ hash: input.txHash });
  return verifyBuilderCodeAttributionFromCalldata(tx.input, input.expectedBuilderCode, input.role);
}

export function registerBuilderCodeClientExtension<T extends { registerExtension(extension: unknown): unknown }>(
  client: T,
  builderCode = getBuilderCodeFromEnv(),
): T {
  if (!builderCode) return client;
  client.registerExtension(new BuilderCodeClientExtension(builderCode));
  return client;
}

export function createX402PaidFetchWithBuilderCode<T extends { registerExtension(extension: unknown): unknown }>(
  fetchFn: typeof globalThis.fetch,
  client: T,
  builderCode = getBuilderCodeFromEnv(),
): typeof globalThis.fetch {
  registerBuilderCodeClientExtension(client, builderCode);
  return wrapFetchWithPayment(fetchFn, client as unknown as Parameters<typeof wrapFetchWithPayment>[1]);
}

export function x402Gateway(config: X402GatewayConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const paymentHeader = req.headers['x-402-payment'];

    if (!paymentHeader) {
      res.setHeader('Payment-Required', JSON.stringify(config.paymentRequired));
      res.status(402).json({ error: 'Payment Required', paymentRequired: config.paymentRequired });
      return;
    }

    try {
      const payment = JSON.parse(Buffer.from(paymentHeader as string, 'base64').toString());

      if (!payment.receipt) {
         res.status(400).json({ error: 'Invalid X-402-Payment header: missing receipt' });
         return;
      }

      const requiredAmount = config.paymentRequired.accepts[0].amount;

      const isValid = await config.facilitator.verifyReceipt(payment.receipt, requiredAmount);

      if (!isValid) {
        res.status(402).json({ error: 'Payment Required: Invalid or used receipt', paymentRequired: config.paymentRequired });
        return;
      }

      next();
    } catch {
      res.status(400).json({ error: 'Invalid X-402-Payment header' });
    }
  };
}
