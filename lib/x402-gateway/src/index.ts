import { Request, Response, NextFunction, type RequestHandler } from 'express';
import { CdpClient } from '@coinbase/cdp-sdk';
import type { EvmServerAccount } from '@coinbase/cdp-sdk';
import { generateJwt } from '@coinbase/cdp-sdk/auth';
import { X402PaymentRequired } from '@mioagent/x402-parser';
import {
  builderCodeAdviceV1,
  resolveBuilderCodeV1,
  type BuilderCodeEnvV1,
} from '@mioagent/route-domain';
import {
  canonicalUsdcForBaseChain,
  normalizeBaseChain,
  type SupportedBaseChainId,
} from '@mioagent/security/baseGuards';
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorConfig,
  type RoutesConfig,
  type SettleResultContext,
} from '@x402/core/server';
import type { PaymentRequirements, SettleResponse, SupportedResponse } from '@x402/core/types';
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
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';

import { DEFAULT_STABLECOINS } from '@x402/evm';

export { ExactEvmScheme } from '@x402/evm';
export { wrapFetchWithPayment } from '@x402/fetch';

export function resolveEip712DomainExtra(network?: string, asset?: string): { name: string; version: string } {
  if (network && asset) {
    try {
      const defaultAsset = (DEFAULT_STABLECOINS as Record<string, { address: string; name: string; version: string }>)[network];
      if (defaultAsset && defaultAsset.address.toLowerCase() === asset.toLowerCase()) {
        return {
          name: defaultAsset.name,
          version: defaultAsset.version,
        };
      }
    } catch {
      // fallback below
    }
  }
  return { name: 'USD Coin', version: '2' };
}

export interface X402GatewayConfig {
  paymentRequired: X402PaymentRequired;
  facilitator: X402Facilitator;
}

export interface X402Facilitator {
  verifyReceipt(receipt: string, requiredAmount: string): Promise<boolean>;
}

export type X402RuntimeStatus =
  | 'connected'
  | 'configured'
  | 'missing'
  | 'unsupported_network_for_settlement'
  | 'facilitator_auth_required'
  | 'facilitator_auth_invalid'
  | 'facilitator_rate_limited'
  | 'facilitator_unreachable'
  | 'degraded';
export type X402SettlementStatus = 'settled' | 'pending' | 'failed';
export type SupportedX402Network = `eip155:${SupportedBaseChainId}`;
export type BuilderCodeAttributionRole = 'seller' | 'buyer';
export type X402FacilitatorAuthSource = 'bearer_token' | 'cdp_api_key_pair';
export type X402MiddlewareRuntimeMode = 'auto' | 'official' | 'unavailable';
export type X402ResolvedMiddlewareMode = 'official' | 'unavailable';
export type X402BuyerPaymentMode = 'free' | 'x402';
export type X402BuyerPayerStatus = 'ready' | 'missing_config' | 'unavailable' | 'insufficient_usdc';

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
  facilitatorAuthConfigured?: boolean;
  authSource?: X402FacilitatorAuthSource;
  settleReady?: boolean;
  settleBlockedReason?: string;
  probeStatus?: X402RuntimeStatus;
  errorCode?: string;
  lastCheckedAt?: string;
  supportedKindsCount?: number;
  supportedNetworks?: string[];
  middlewareMode?: X402ResolvedMiddlewareMode;
  officialMiddlewareEnabled?: boolean;
  smokeRoute?: string;
  smokeRouteAvailable?: boolean;
  builderCodeAttribution?: 'attached' | 'unavailable';
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
  source: 'x402-facilitator';
  errorReason?: string;
  errorMessage?: string;
  details?: Record<string, unknown>;
}

export interface X402BuyerSigner {
  address: `0x${string}` | string;
  signTypedData(message: unknown): Promise<`0x${string}` | string>;
}

export interface CreateX402BuyerClientOptions {
  signer?: X402BuyerSigner;
  networks?: SupportedX402Network[];
  builderCode?: string;
}

export interface CreateX402BuyerPaidFetchOptions extends CreateX402BuyerClientOptions {
  fetchImpl?: typeof globalThis.fetch;
}

export interface X402BuyerPayerStatusSnapshot {
  status: X402BuyerPayerStatus;
  configured: boolean;
  accountAddressPresent: boolean;
  accountType: 'cdp_evm_server_account';
  walletName: string;
  missingConfig: string[];
  errorCode?: string;
  lastCheckedAt?: string;
}

export interface X402BuyerPayerRuntime {
  getPaidFetch(): Promise<typeof globalThis.fetch>;
  status(): X402BuyerPayerStatusSnapshot;
}

export interface CreateX402BuyerPayerRuntimeOptions {
  fetchImpl?: typeof globalThis.fetch;
  networks?: SupportedX402Network[];
  builderCode?: string;
  resolveAccount?: (input: {
    apiKeyId: string;
    apiKeySecret: string;
    walletSecret: string;
    walletName: string;
  }) => Promise<X402BuyerSigner>;
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
  onSettlementFailure?: (failure: {
    errorReason?: string;
    errorMessage?: string;
    checkedAt: string;
  }) => Promise<void> | void;
  syncFacilitatorOnStart?: boolean;
  runtimeMode?: X402MiddlewareRuntimeMode;
  /**
   * Overrides the atomic USDC amount priced for this route only, leaving the
   * global X402_AMOUNT_ATOMIC_USDC config (and every other route) untouched.
   * Must be a positive integer string; when omitted the route falls back to
   * config.amountAtomic exactly as before this option existed.
   */
  amountAtomicOverride?: string;
}

export interface X402MiddlewareDiagnostics {
  middlewareMode: X402ResolvedMiddlewareMode;
  officialMiddlewareEnabled: boolean;
  configured: boolean;
  status: X402RuntimeStatus;
  network?: SupportedX402Network;
  chainId?: SupportedBaseChainId;
  asset?: string;
  payToConfigured: boolean;
  builderCodeConfigured: boolean;
  builderCodeAttribution: 'attached' | 'unavailable';
  facilitatorAuthConfigured: boolean;
  authSource?: X402FacilitatorAuthSource;
  facilitatorHost?: string;
  settleReady: boolean;
  settleBlockedReason?: string;
  probeStatus?: X402RuntimeStatus;
  smokeRoute: string;
  smokeRouteAvailable: boolean;
  eip712DomainAttached: boolean;
  eip712DomainName?: string;
  eip712DomainVersion?: string;
  errorCode?: string;
  missingConfig: string[];
  warnings: string[];
  supportedNetworks?: string[];
}

export interface X402FacilitatorHealth {
  status: Extract<
    X402RuntimeStatus,
    | 'connected'
    | 'facilitator_auth_required'
    | 'facilitator_auth_invalid'
    | 'facilitator_rate_limited'
    | 'facilitator_unreachable'
    | 'degraded'
  >;
  errorCode?: string;
  checkedAt: string;
  supportedKindsCount?: number;
  supportedNetworks?: string[];
}

type FacilitatorOperation = 'verify' | 'settle' | 'supported' | 'bazaar';

interface X402FacilitatorAuthResolution {
  configured: boolean;
  source?: X402FacilitatorAuthSource;
  token?: string;
  apiKeyId?: string;
  apiKeySecret?: string;
  errorCode?: string;
}

export const DEFAULT_X402_AMOUNT_ATOMIC_USDC = '1000';
// The placeholder list moved to @mioagent/route-domain/builder-code — one list,
// so a value rejected for the wallet suffix cannot still reach the facilitator.

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

function sanitizedHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

function mainnetSettlementRequiresAuth(chainId?: SupportedBaseChainId): boolean {
  return chainId === 8453;
}

function settleBlockedReasonForHealth(status: X402RuntimeStatus, errorCode?: string): string {
  if (status === 'facilitator_auth_required') return errorCode || 'facilitator_auth_required';
  if (status === 'facilitator_auth_invalid') return errorCode || 'facilitator_auth_invalid';
  if (status === 'facilitator_rate_limited') return 'facilitator_rate_limited';
  if (status === 'facilitator_unreachable') return 'facilitator_unreachable';
  if (status === 'unsupported_network_for_settlement') return 'network_not_supported';
  if (status === 'degraded') return 'facilitator_degraded';
  if (status === 'missing') return 'x402_not_configured';
  return 'settlement_not_ready';
}

export function classifyX402SettleFailureReason(reason?: string, message?: string): string {
  const text = [reason, message].filter(Boolean).join(' ').toLowerCase();
  if (/insufficient|balance|funds?|allowance|usdc/.test(text)) return 'insufficient_usdc';
  if (/unauthori[sz]ed|forbidden|auth|jwt|401|403/.test(text)) return 'facilitator_auth_missing';
  if (/network|chain|unsupported|8453|84532/.test(text)) return 'network_not_supported';
  if (/rate|429|quota|limit/.test(text)) return 'facilitator_rate_limited';
  return reason || 'settlement_failed';
}

function isValidAddress(value: string | undefined): boolean {
  return !!value && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isPositiveIntegerString(value: string): boolean {
  return /^[0-9]+$/.test(value) && BigInt(value) > 0n;
}

function firstConfigured(value: string | undefined, ...rest: Array<string | undefined>): string | undefined {
  return [value, ...rest].map(normalizeOptional).find(Boolean);
}

function bearer(value: string): string {
  return /^[A-Za-z]+ +/.test(value) ? value : `Bearer ${value}`;
}

function normalizeCdpApiKeySecret(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

function cdpJwtTtlSeconds(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.X402_FACILITATOR_JWT_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return 120;
  return Math.min(Math.max(Math.floor(raw), 30), 120);
}

function sanitizedStatusCode(error: unknown): number | undefined {
  let current: unknown = error;
  while (current) {
    const statusCode = typeof current === 'object' && current !== null && 'statusCode' in current
      ? Number((current as { statusCode?: unknown }).statusCode)
      : undefined;
    if (Number.isInteger(statusCode) && statusCode && statusCode > 0) return statusCode;
    const message = current instanceof Error ? current.message : String(current);
    const match = message.match(/\((\d{3})\)/) || message.match(/\b(status|HTTP)\s*[:=]?\s*(\d{3})\b/i);
    const parsed = match ? Number(match[2] || match[1]) : undefined;
    if (Number.isInteger(parsed)) return parsed;
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

export function classifyX402FacilitatorError(error: unknown): Pick<X402FacilitatorHealth, 'status' | 'errorCode'> {
  if (error instanceof X402FacilitatorAuthError) {
    return { status: error.status, errorCode: error.errorCode };
  }
  const statusCode = sanitizedStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    return { status: 'facilitator_auth_required', errorCode: `facilitator_${statusCode}` };
  }
  if (statusCode === 429) {
    return { status: 'facilitator_rate_limited', errorCode: 'facilitator_429' };
  }
  if (statusCode && statusCode >= 500) {
    return { status: 'facilitator_unreachable', errorCode: `facilitator_${statusCode}` };
  }
  const messages: string[] = [];
  let current: unknown = error;
  while (current) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  const message = messages.join(' ');
  if (/fetch failed|network|timeout|timed out|ENOTFOUND|ECONN|EAI_AGAIN|ETIMEDOUT/i.test(message)) {
    return { status: 'facilitator_unreachable', errorCode: 'facilitator_network' };
  }
  return { status: 'degraded', errorCode: statusCode ? `facilitator_${statusCode}` : 'facilitator_error' };
}

class X402FacilitatorAuthError extends Error {
  readonly status: Extract<X402RuntimeStatus, 'facilitator_auth_required' | 'facilitator_auth_invalid'>;
  readonly errorCode: string;

  constructor(
    status: Extract<X402RuntimeStatus, 'facilitator_auth_required' | 'facilitator_auth_invalid'>,
    errorCode: string,
  ) {
    super(`x402 facilitator auth unavailable: ${errorCode}`);
    this.name = 'X402FacilitatorAuthError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

export function resolveX402FacilitatorAuth(
  env: NodeJS.ProcessEnv = process.env,
): X402FacilitatorAuthResolution {
  const token = firstConfigured(env.X402_FACILITATOR_AUTH_TOKEN);
  if (token) {
    return {
      configured: true,
      source: 'bearer_token',
      token,
    };
  }

  const legacyBearer = firstConfigured(env.X402_FACILITATOR_API_KEY, env.CDP_API_KEY);
  if (legacyBearer) {
    return {
      configured: true,
      source: 'bearer_token',
      token: legacyBearer,
    };
  }

  const apiKeyId = firstConfigured(env.CDP_API_KEY_ID);
  const apiKeySecret = firstConfigured(env.CDP_API_KEY_SECRET);
  if (apiKeyId && apiKeySecret) {
    return {
      configured: true,
      source: 'cdp_api_key_pair',
      apiKeyId,
      apiKeySecret: normalizeCdpApiKeySecret(apiKeySecret),
    };
  }
  if (apiKeyId || apiKeySecret) {
    return {
      configured: false,
      source: 'cdp_api_key_pair',
      errorCode: 'cdp_api_key_pair_incomplete',
    };
  }
  return { configured: false };
}

export function x402FacilitatorAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveX402FacilitatorAuth(env).configured;
}

export function x402FacilitatorAuthSource(
  env: NodeJS.ProcessEnv = process.env,
): X402FacilitatorAuthSource | undefined {
  const auth = resolveX402FacilitatorAuth(env);
  return auth.configured ? auth.source : undefined;
}

const X402_CDP_JWT_REFRESH_SKEW_MS = 15_000;

let x402CdpJwtCache = new Map<
  string,
  {
    value: string;
    expiresAt: number;
  }
>();

function facilitatorEndpoint(config: X402RuntimeConfig, operation: FacilitatorOperation): {
  method: string;
  host: string;
  path: string;
} {
  if (!config.facilitatorUrl) {
    throw new X402FacilitatorAuthError('facilitator_auth_required', 'facilitator_url_missing');
  }
  const parsed = new URL(config.facilitatorUrl);
  const basePath = parsed.pathname.replace(/\/+$/, '');
  const endpointPath = `${basePath}/${operation}`.replace(/\/{2,}/g, '/');
  return {
    method: operation === 'supported' || operation === 'bazaar' ? 'GET' : 'POST',
    host: parsed.host,
    path: endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`,
  };
}

async function cdpJwtAuthorizationHeader(
  config: X402RuntimeConfig,
  env: NodeJS.ProcessEnv,
  operation: FacilitatorOperation,
  auth: X402FacilitatorAuthResolution,
): Promise<string> {
  if (!auth.apiKeyId || !auth.apiKeySecret) {
    throw new X402FacilitatorAuthError('facilitator_auth_required', 'cdp_api_key_pair_incomplete');
  }

  const endpoint = facilitatorEndpoint(config, operation);
  const expiresIn = cdpJwtTtlSeconds(env);
  const key = [
    auth.source,
    auth.apiKeyId,
    endpoint.method,
    endpoint.host,
    endpoint.path,
    expiresIn,
  ].join('|');
  const cached = x402CdpJwtCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const jwt = await generateJwt({
      apiKeyId: auth.apiKeyId,
      apiKeySecret: auth.apiKeySecret,
      requestMethod: endpoint.method,
      requestHost: endpoint.host,
      requestPath: endpoint.path,
      expiresIn,
    });
    const header = bearer(jwt);
    x402CdpJwtCache.set(key, {
      value: header,
      expiresAt: Date.now() + expiresIn * 1000 - X402_CDP_JWT_REFRESH_SKEW_MS,
    });
    return header;
  } catch {
    throw new X402FacilitatorAuthError('facilitator_auth_invalid', 'cdp_jwt_generation_failed');
  }
}

export function createX402FacilitatorAuthHeaders(
  env: NodeJS.ProcessEnv = process.env,
  config?: X402RuntimeConfig,
): FacilitatorConfig['createAuthHeaders'] | undefined {
  return async () => {
    const auth = resolveX402FacilitatorAuth(env);
    if (!auth.configured) {
      if (auth.errorCode) {
        throw new X402FacilitatorAuthError('facilitator_auth_required', auth.errorCode);
      }
      return {
        verify: {},
        settle: {},
        supported: {},
        bazaar: {},
      };
    }
    const authorizationFor = async (operation: FacilitatorOperation) => {
      if (auth.source === 'bearer_token' && auth.token) return bearer(auth.token);
      if (!config) {
        throw new X402FacilitatorAuthError('facilitator_auth_required', 'facilitator_url_missing');
      }
      return cdpJwtAuthorizationHeader(config, env, operation, auth);
    };
    const headersFor = async (operation: FacilitatorOperation) => ({
      Authorization: await authorizationFor(operation),
    });
    return {
      verify: await headersFor('verify'),
      settle: await headersFor('settle'),
      supported: await headersFor('supported'),
      bazaar: await headersFor('bazaar'),
    };
  };
}

// T67X-B1: the x402 seller/buyer attribution code and the ERC-8021 wallet
// attribution code are the SAME public base.dev identifier, so they resolve
// through the same rule — including the fail-closed conflict. This wrapper
// exists only to keep the warn-once behaviour x402 callers already rely on.
export function getBuilderCodeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { warn?: boolean } = {},
): string | undefined {
  const shouldWarn = options.warn ?? true;
  const resolution = resolveBuilderCodeV1(env as BuilderCodeEnvV1);
  if (resolution.status === 'resolved') {
    // Sanity-check against the extension's own pattern rather than assuming the
    // two agree: if @x402/extensions ever tightens it, an unattributable code
    // must not reach the facilitator claiming to be attributed.
    if (BUILDER_CODE_PATTERN.test(resolution.code)) return resolution.code;
    if (shouldWarn) {
      warnOnce(
        'x402-builder-code-extension-mismatch',
        '[x402] Builder Code is valid for ERC-8021 but not for the x402 builder-code extension; x402 payments will be unattributed.',
      );
    }
    return undefined;
  }
  if (shouldWarn) {
    warnOnce(
      `x402-builder-code-${resolution.status}`,
      `[x402] ${builderCodeAdviceV1(resolution)} x402 payments will be unattributed.`,
    );
  }
  return undefined;
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
  const auth = resolveX402FacilitatorAuth(env);
  const authRequired = mainnetSettlementRequiresAuth(chainId);
  const settleBlockedReason =
    !configured
      ? warnings.includes('unsupported_network') ? 'unsupported_network_for_settlement' : 'x402_not_configured'
      : auth.errorCode
        ? auth.errorCode
        : authRequired && !auth.configured
          ? 'facilitator_auth_missing'
          : undefined;
  const settleReady = configured && !settleBlockedReason;
  const status: X402RuntimeStatus =
    configured && settleBlockedReason === 'facilitator_auth_missing'
      ? 'facilitator_auth_required'
      : configured && settleBlockedReason === 'cdp_api_key_pair_incomplete'
        ? 'facilitator_auth_required'
        : configured
          ? 'configured'
          : 'missing';

  return {
    status,
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
    facilitatorAuthConfigured: auth.configured,
    authSource: auth.configured ? auth.source : undefined,
    settleReady,
    settleBlockedReason,
  };
}

export function paymentRequiredFromRuntimeConfig(config: X402RuntimeConfig): X402PaymentRequired {
  if (!config.payTo || !config.asset || !config.network) {
    throw new Error('x402_payment_configuration_incomplete');
  }
  const extraDomain = resolveEip712DomainExtra(config.network, config.asset);
  return {
    accepts: [
      {
        amount: config.amountAtomic,
        payTo: config.payTo,
        asset: config.asset,
        network: config.network,
        version: '2',
        maxTimeoutSeconds: 300,
        extra: extraDomain,
      },
    ],
  };
}

export function createX402RoutesConfig(
  config: X402RuntimeConfig,
  routePath = '/paid-resource',
  serviceName = 'Miorail',
  options: Pick<CreateX402MiddlewareOptions, 'onSettlementFailure' | 'amountAtomicOverride'> = {},
): RoutesConfig {
  if (!config.configured || !config.payTo || !config.network || !config.asset) {
    throw new Error(`x402 is not configured: ${config.missingConfig.join(', ')}`);
  }

  const amountAtomic =
    options.amountAtomicOverride !== undefined ? options.amountAtomicOverride : config.amountAtomic;
  if (!isPositiveIntegerString(amountAtomic)) {
    throw new Error('x402 route amount override must be a positive integer string');
  }
  const effectiveConfig: X402RuntimeConfig = { ...config, amountAtomic };

  const extraDomain = resolveEip712DomainExtra(config.network, config.asset);
  const routeConfig = {
    accepts: {
      scheme: 'exact',
      payTo: config.payTo,
      price: {
        asset: config.asset,
        amount: amountAtomic,
        extra: extraDomain,
      },
      network: config.network,
      maxTimeoutSeconds: 300,
      extra: extraDomain,
    },
    resource: routePath,
    description: 'Miorail x402 paid resource',
    mimeType: 'application/json',
    serviceName,
    tags: ['miorail', 'x402'],
    unpaidResponseBody: () => {
      const paymentRequired = paymentRequiredFromRuntimeConfig(effectiveConfig);
      return {
        contentType: 'application/json',
        body: {
          x402Version: 2,
          accepts: paymentRequired.accepts,
          error: 'Payment Required',
        },
      };
    },
    settlementFailedResponseBody: (_context: unknown, settleResult: { errorReason?: string; errorMessage?: string }) => {
      const reason = classifyX402SettleFailureReason(settleResult.errorReason, settleResult.errorMessage);
      void options.onSettlementFailure?.({
        errorReason: reason,
        errorMessage: settleResult.errorMessage,
        checkedAt: new Date().toISOString(),
      });
      return {
        contentType: 'application/json',
        body: {
          error: 'Payment Required: settlement failed',
          reason,
        },
      };
    },
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

const X402_HEALTH_SUCCESS_TTL_MS = 60_000;
const X402_HEALTH_FAILURE_TTL_MS = 120_000;
const DEFAULT_X402_FACILITATOR_TIMEOUT_MS = 2500;

let x402HealthCache:
  | {
      key: string;
      value: X402FacilitatorHealth;
      expiresAt: number;
    }
  | undefined;
let x402HealthInflight:
  | {
      key: string;
      promise: Promise<X402FacilitatorHealth>;
    }
  | undefined;

function facilitatorCacheKey(config: X402RuntimeConfig, env: NodeJS.ProcessEnv): string {
  const auth = resolveX402FacilitatorAuth(env);
  return [
    config.facilitatorUrl || '',
    config.network || '',
    config.payTo || '',
    auth.configured ? auth.source || 'auth' : auth.errorCode || 'anon',
  ].join('|');
}

function cacheHealth(key: string, value: X402FacilitatorHealth): X402FacilitatorHealth {
  x402HealthCache = {
    key,
    value,
    expiresAt: Date.now() + (value.status === 'connected' ? X402_HEALTH_SUCCESS_TTL_MS : X402_HEALTH_FAILURE_TTL_MS),
  };
  return value;
}

function createHTTPFacilitatorClient(config: X402RuntimeConfig, env: NodeJS.ProcessEnv): HTTPFacilitatorClient {
  return new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
    createAuthHeaders: createX402FacilitatorAuthHeaders(env, config),
  });
}

function facilitatorTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.X402_FACILITATOR_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30_000) : DEFAULT_X402_FACILITATOR_TIMEOUT_MS;
}

function withFacilitatorTimeout<T>(promise: Promise<T>, env: NodeJS.ProcessEnv): Promise<T> {
  const timeoutMs = facilitatorTimeoutMs(env);
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Facilitator request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function loadSupportedKinds(config: X402RuntimeConfig, env: NodeJS.ProcessEnv): Promise<SupportedResponse> {
  return withFacilitatorTimeout(createHTTPFacilitatorClient(config, env).getSupported(), env);
}

function supportedNetworksFromResponse(supported: SupportedResponse): string[] {
  const kinds = Array.isArray((supported as { kinds?: unknown }).kinds)
    ? ((supported as { kinds: Array<Record<string, unknown>> }).kinds)
    : [];
  const networks = kinds
    .map((kind) => (typeof kind.network === 'string' ? kind.network : undefined))
    .filter((network): network is string => !!network);
  return [...new Set(networks)];
}

function applyFacilitatorHealthToConfig(
  config: X402RuntimeConfig,
  health: X402FacilitatorHealth,
): X402RuntimeConfig {
  const hasParsedNetworks = Array.isArray(health.supportedNetworks) && health.supportedNetworks.length > 0;
  const networkSupported =
    health.status === 'connected' &&
    (!hasParsedNetworks || !config.network || health.supportedNetworks?.includes(config.network));

  if (health.status === 'connected' && networkSupported) {
    return {
      ...config,
      status: 'connected',
      settleReady: true,
      settleBlockedReason: undefined,
      probeStatus: health.status,
      errorCode: undefined,
      lastCheckedAt: health.checkedAt,
      supportedKindsCount: health.supportedKindsCount,
      supportedNetworks: health.supportedNetworks,
    };
  }

  const status: X402RuntimeStatus =
    health.status === 'connected' ? 'unsupported_network_for_settlement' : health.status;
  const errorCode =
    health.status === 'connected' ? 'facilitator_network_not_supported' : health.errorCode;
  return {
    ...config,
    status,
    settleReady: false,
    settleBlockedReason: settleBlockedReasonForHealth(status, errorCode),
    probeStatus: health.status,
    errorCode,
    lastCheckedAt: health.checkedAt,
    supportedKindsCount: health.supportedKindsCount,
    supportedNetworks: health.supportedNetworks,
  };
}

export async function probeX402FacilitatorStatus(
  config: X402RuntimeConfig = x402ConfigFromEnv(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<X402FacilitatorHealth> {
  if (!config.configured) {
    return {
      status: 'degraded',
      errorCode: 'x402_not_configured',
      checkedAt: new Date().toISOString(),
    };
  }

  const key = facilitatorCacheKey(config, env);
  if (x402HealthCache?.key === key && x402HealthCache.expiresAt > Date.now()) {
    return x402HealthCache.value;
  }
  if (x402HealthInflight?.key === key) return x402HealthInflight.promise;

  const promise = (async () => {
    try {
      const supported = await loadSupportedKinds(config, env);
      const supportedKindsCount = Array.isArray(supported.kinds) ? supported.kinds.length : 0;
      const supportedNetworks = supportedNetworksFromResponse(supported);
      const health: X402FacilitatorHealth = {
        status: supportedKindsCount > 0 ? 'connected' : 'degraded',
        errorCode: supportedKindsCount > 0 ? undefined : 'facilitator_no_supported_kinds',
        checkedAt: new Date().toISOString(),
        supportedKindsCount,
        supportedNetworks,
      };
      return cacheHealth(key, health);
    } catch (error) {
      const classified = classifyX402FacilitatorError(error);
      const health: X402FacilitatorHealth = {
        ...classified,
        checkedAt: new Date().toISOString(),
      };
      console.warn('[x402] facilitator probe failed', {
        status: health.status,
        errorCode: health.errorCode,
      });
      return cacheHealth(key, health);
    } finally {
      x402HealthInflight = undefined;
    }
  })();
  x402HealthInflight = { key, promise };

  return promise;
}

export async function x402StatusFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<X402RuntimeConfig> {
  const config = x402ConfigFromEnv(env);
  if (!config.configured) return config;
  const auth = resolveX402FacilitatorAuth(env);
  if (auth.errorCode === 'cdp_api_key_pair_incomplete') {
    return {
      ...config,
      status: 'facilitator_auth_required',
      errorCode: auth.errorCode,
      settleReady: false,
      settleBlockedReason: auth.errorCode,
      lastCheckedAt: new Date().toISOString(),
    };
  }
  if (!config.settleReady) {
    return {
      ...config,
      status: config.status === 'configured' ? 'facilitator_auth_required' : config.status,
      errorCode: config.settleBlockedReason,
      lastCheckedAt: new Date().toISOString(),
    };
  }
  const health = await probeX402FacilitatorStatus(config, env);
  return applyFacilitatorHealthToConfig(config, health);
}

export function clearX402FacilitatorStatusForTests(): void {
  x402HealthCache = undefined;
  x402HealthInflight = undefined;
  x402CdpJwtCache = new Map();
}

function createOfficialX402HttpServer(
  config: X402RuntimeConfig,
  options: CreateX402MiddlewareOptions = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!config.configured || !config.facilitatorUrl || !config.network) {
    throw new Error(`x402 is not configured: ${config.missingConfig.join(', ')}`);
  }

  const resourceServer = new x402ResourceServer(
    createHTTPFacilitatorClient(config, env),
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
    createX402RoutesConfig(config, options.routePath, options.serviceName, options),
  );
  return httpServer;
}

async function createInitializedOfficialX402Middleware(
  config: X402RuntimeConfig,
  options: CreateX402MiddlewareOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<RequestHandler> {
  const httpServer = createOfficialX402HttpServer(config, options, env);
  await withFacilitatorTimeout(httpServer.initialize(), env);
  cacheHealth(facilitatorCacheKey(config, env), {
    status: 'connected',
    checkedAt: new Date().toISOString(),
  });
  return paymentMiddlewareFromHTTPServer(
    httpServer,
    {
      appName: options.serviceName || 'Miorail',
      testnet: config.chainId === 84532,
    },
    undefined,
    false,
  );
}

export function createOfficialX402Middleware(
  config: X402RuntimeConfig,
  options: CreateX402MiddlewareOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): RequestHandler {
  if (!config.configured || !config.facilitatorUrl || !config.network) {
    throw new Error(`x402 is not configured: ${config.missingConfig.join(', ')}`);
  }
  const httpServer = createOfficialX402HttpServer(config, options, env);
  return paymentMiddlewareFromHTTPServer(
    httpServer,
    {
      appName: options.serviceName || 'Miorail',
      testnet: config.chainId === 84532,
    },
    undefined,
    false,
  );
}

function unavailablePayload(
  config: X402RuntimeConfig,
  status = config.status,
  errorCode = config.errorCode,
) {
  return {
    error: status === 'missing' ? 'x402_not_configured' : 'x402_facilitator_unavailable',
    status,
    errorCode,
    configured: config.configured,
    facilitatorConfigured: !!config.facilitatorUrl,
    payToConfigured: !!config.payTo,
    builderCodeConfigured: !!config.builderCode,
    settleReady: !!config.settleReady,
    settleBlockedReason: config.settleBlockedReason,
    network: config.network,
    chainId: config.chainId,
    missingConfig: config.missingConfig,
  };
}

export function createUnavailableX402Middleware(config: X402RuntimeConfig): RequestHandler {
  return (_req, res) => {
    res.status(503).json(unavailablePayload(config));
  };
}

export function createSafeOfficialX402Middleware(
  config: X402RuntimeConfig,
  options: CreateX402MiddlewareOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): RequestHandler {
  let handler: RequestHandler | undefined;
  let initPromise: Promise<RequestHandler> | undefined;

  return async (req, res, next) => {
    try {
      if (!handler) {
        if (!config.settleReady) {
          res.status(503).json(unavailablePayload(
            config,
            config.status === 'configured' ? 'facilitator_auth_required' : config.status,
            config.errorCode || config.settleBlockedReason,
          ));
          return;
        }
        const health = await probeX402FacilitatorStatus(config, env);
        const runtime = applyFacilitatorHealthToConfig(config, health);
        if (!runtime.settleReady) {
          res.status(503).json(unavailablePayload(runtime, runtime.status, runtime.errorCode));
          return;
        }
        initPromise ||= createInitializedOfficialX402Middleware(config, options, env);
        handler = await initPromise;
      }
      return handler(req, res, next);
    } catch (error) {
      initPromise = undefined;
      const classified = classifyX402FacilitatorError(error);
      const health = cacheHealth(facilitatorCacheKey(config, env), {
        ...classified,
        checkedAt: new Date().toISOString(),
      });
      console.warn('[x402] facilitator initialization failed', {
        status: health.status,
        errorCode: health.errorCode,
      });
      res.status(503).json(unavailablePayload(config, health.status, health.errorCode));
    }
  };
}

export function resolveX402MiddlewareMode(
  config: X402RuntimeConfig = x402ConfigFromEnv(),
  _env: NodeJS.ProcessEnv = process.env,
  runtimeMode: X402MiddlewareRuntimeMode = 'auto',
): X402ResolvedMiddlewareMode {
  if (runtimeMode === 'official') return config.configured ? 'official' : 'unavailable';
  if (runtimeMode === 'unavailable') return 'unavailable';
  return config.configured ? 'official' : 'unavailable';
}

export function x402MiddlewareDiagnosticsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { runtimeMode?: X402MiddlewareRuntimeMode; smokeRoute?: string; config?: X402RuntimeConfig } = {},
): X402MiddlewareDiagnostics {
  const config = options.config || x402ConfigFromEnv(env);
  const middlewareMode = resolveX402MiddlewareMode(config, env, options.runtimeMode);
  const smokeRoute = options.smokeRoute || '/api/x402/smoke-paid';
  const eip712Domain = resolveEip712DomainExtra(config.network, config.asset);
  return {
    middlewareMode,
    officialMiddlewareEnabled: middlewareMode === 'official',
    configured: config.configured,
    status: config.status,
    network: config.network,
    chainId: config.chainId,
    asset: config.asset,
    payToConfigured: !!config.payTo,
    builderCodeConfigured: !!config.builderCode,
    builderCodeAttribution: config.builderCode ? 'attached' : 'unavailable',
    facilitatorAuthConfigured: !!config.facilitatorAuthConfigured,
    authSource: config.authSource,
    facilitatorHost: sanitizedHost(config.facilitatorUrl),
    settleReady: !!config.settleReady,
    settleBlockedReason: config.settleBlockedReason,
    probeStatus: config.probeStatus,
    smokeRoute,
    smokeRouteAvailable: middlewareMode === 'official' && config.configured && !!config.settleReady,
    eip712DomainAttached: !!(eip712Domain.name && eip712Domain.version),
    eip712DomainName: eip712Domain.name,
    eip712DomainVersion: eip712Domain.version,
    errorCode: config.errorCode,
    missingConfig: config.missingConfig,
    warnings: config.warnings,
    supportedNetworks: config.supportedNetworks,
  };
}

export function createX402MiddlewareFromEnv(
  options: CreateX402MiddlewareOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): RequestHandler {
  const config = x402ConfigFromEnv(env);
  const middlewareMode = resolveX402MiddlewareMode(config, env, options.runtimeMode);
  if (middlewareMode === 'official') {
    return createSafeOfficialX402Middleware(config, options, env);
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

export class X402BuyerUnavailableError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message = 'x402 buyer payment signer is unavailable') {
    super(message);
    this.name = 'X402BuyerUnavailableError';
    this.errorCode = errorCode;
  }
}

function buyerPayerWalletNameFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeOptional(env.X402_BUYER_PAYER_ACCOUNT_NAME) ||
    normalizeOptional(env.BASE_SUBSCRIPTION_WALLET_NAME) ||
    normalizeOptional(env.CDP_SUBSCRIPTION_WALLET_NAME) ||
    'miorail-x402-buyer-payer';
}

function buyerPayerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  configured: boolean;
  missingConfig: string[];
  apiKeyId?: string;
  apiKeySecret?: string;
  walletSecret?: string;
  walletName: string;
} {
  const apiKeyId = normalizeOptional(env.CDP_API_KEY_ID);
  const apiKeySecret = normalizeOptional(env.CDP_API_KEY_SECRET);
  const walletSecret = normalizeOptional(env.CDP_WALLET_SECRET);
  const missingConfig: string[] = [];
  if (!apiKeyId) missingConfig.push('CDP_API_KEY_ID');
  if (!apiKeySecret) missingConfig.push('CDP_API_KEY_SECRET');
  if (!walletSecret) missingConfig.push('CDP_WALLET_SECRET');
  return {
    configured: missingConfig.length === 0,
    missingConfig,
    apiKeyId,
    apiKeySecret: apiKeySecret ? normalizeCdpApiKeySecret(apiKeySecret) : undefined,
    walletSecret,
    walletName: buyerPayerWalletNameFromEnv(env),
  };
}

function classifyBuyerPayerError(error: unknown): Pick<X402BuyerPayerStatusSnapshot, 'status' | 'errorCode'> {
  if (error instanceof X402BuyerUnavailableError) {
    if (error.errorCode === 'x402_buyer_insufficient_usdc') {
      return { status: 'insufficient_usdc', errorCode: error.errorCode };
    }
    if (error.errorCode === 'x402_buyer_payer_missing_config') {
      return { status: 'missing_config', errorCode: error.errorCode };
    }
    return { status: 'unavailable', errorCode: error.errorCode };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/insufficient|balance|funds?|allowance|usdc/i.test(message)) {
    return { status: 'insufficient_usdc', errorCode: 'x402_buyer_insufficient_usdc' };
  }
  if (/wallet secret|api key|unauthori[sz]ed|forbidden|auth|401|403/i.test(message)) {
    return { status: 'unavailable', errorCode: 'x402_buyer_cdp_auth_unavailable' };
  }
  return { status: 'unavailable', errorCode: 'x402_buyer_payer_unavailable' };
}

export function x402BuyerPayerStatusFromEnv(env: NodeJS.ProcessEnv = process.env): X402BuyerPayerStatusSnapshot {
  return getDefaultX402BuyerPayerRuntime(env).status();
}

export function createX402BuyerPayerRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: CreateX402BuyerPayerRuntimeOptions = {},
): X402BuyerPayerRuntime {
  const config = buyerPayerConfigFromEnv(env);
  let paidFetch: typeof globalThis.fetch | undefined;
  let inflight: Promise<typeof globalThis.fetch> | undefined;
  let snapshot: X402BuyerPayerStatusSnapshot = {
    status: config.configured ? 'ready' : 'missing_config',
    configured: config.configured,
    accountAddressPresent: false,
    accountType: 'cdp_evm_server_account',
    walletName: config.walletName,
    missingConfig: config.missingConfig,
    ...(config.configured ? {} : { errorCode: 'x402_buyer_payer_missing_config' }),
  };

  const updateSnapshot = (patch: Partial<X402BuyerPayerStatusSnapshot>) => {
    snapshot = {
      ...snapshot,
      ...patch,
      lastCheckedAt: new Date().toISOString(),
    };
  };

  const resolveAccount = async (): Promise<X402BuyerSigner> => {
    if (!config.configured || !config.apiKeyId || !config.apiKeySecret || !config.walletSecret) {
      throw new X402BuyerUnavailableError(
        'x402_buyer_payer_missing_config',
        'x402 buyer payer requires CDP_API_KEY_ID, CDP_API_KEY_SECRET, and CDP_WALLET_SECRET.',
      );
    }
    if (options.resolveAccount) {
      return options.resolveAccount({
        apiKeyId: config.apiKeyId,
        apiKeySecret: config.apiKeySecret,
        walletSecret: config.walletSecret,
        walletName: config.walletName,
      });
    }
    const cdp = new CdpClient({
      apiKeyId: config.apiKeyId,
      apiKeySecret: config.apiKeySecret,
      walletSecret: config.walletSecret,
    });
    const account = await cdp.evm.getOrCreateAccount({ name: config.walletName }) as EvmServerAccount;
    return account as unknown as X402BuyerSigner;
  };

  return {
    async getPaidFetch() {
      if (paidFetch) return paidFetch;
      if (!config.configured) {
        updateSnapshot({
          status: 'missing_config',
          configured: false,
          accountAddressPresent: false,
          errorCode: 'x402_buyer_payer_missing_config',
          missingConfig: config.missingConfig,
        });
        throw new X402BuyerUnavailableError('x402_buyer_payer_missing_config');
      }
      inflight ||= (async () => {
        try {
          const account = await resolveAccount();
          paidFetch = createX402BuyerPaidFetch({
            signer: account,
            networks: options.networks,
            builderCode: options.builderCode ?? getBuilderCodeFromEnv(env),
            fetchImpl: options.fetchImpl,
          });
          updateSnapshot({
            status: 'ready',
            configured: true,
            accountAddressPresent: Boolean(account.address),
            errorCode: undefined,
            missingConfig: [],
          });
          return paidFetch;
        } catch (error) {
          paidFetch = undefined;
          inflight = undefined;
          const classified = classifyBuyerPayerError(error);
          updateSnapshot({
            ...classified,
            configured: config.configured,
            accountAddressPresent: false,
            missingConfig: config.missingConfig,
          });
          throw error instanceof X402BuyerUnavailableError
            ? error
            : new X402BuyerUnavailableError(classified.errorCode || 'x402_buyer_payer_unavailable');
        }
      })();
      return inflight;
    },
    status() {
      return { ...snapshot, missingConfig: [...snapshot.missingConfig] };
    },
  };
}

let defaultBuyerPayerRuntime:
  | {
      key: string;
      runtime: X402BuyerPayerRuntime;
    }
  | undefined;

function defaultBuyerPayerRuntimeKey(env: NodeJS.ProcessEnv): string {
  const config = buyerPayerConfigFromEnv(env);
  return [
    config.configured ? 'configured' : 'missing',
    config.walletName,
    config.missingConfig.join(','),
    // The RESOLVED code, not one env key: caching on `BUILDER_CODE` alone
    // handed a stale runtime to a deployment that had switched to
    // BASE_BUILDER_CODE, and the buyer kept paying under the old attribution.
    getBuilderCodeFromEnv(env, { warn: false }) || '',
    normalizeOptional(env.X402_NETWORK) || '',
  ].join('|');
}

export function getDefaultX402BuyerPayerRuntime(
  env: NodeJS.ProcessEnv = process.env,
): X402BuyerPayerRuntime {
  const key = defaultBuyerPayerRuntimeKey(env);
  if (env === process.env && defaultBuyerPayerRuntime?.key === key) {
    return defaultBuyerPayerRuntime.runtime;
  }
  const runtime = createX402BuyerPayerRuntime(env);
  if (env === process.env) {
    defaultBuyerPayerRuntime = { key, runtime };
  }
  return runtime;
}

export function createX402BuyerClient(options: CreateX402BuyerClientOptions = {}): x402Client {
  if (!options.signer) {
    throw new X402BuyerUnavailableError(
      'x402_buyer_signer_missing',
      'x402 buyer payment requires a CDP-managed signer; no signer was configured.',
    );
  }
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: options.signer as never,
    networks: options.networks || ['eip155:8453', 'eip155:84532'],
  });
  registerBuilderCodeClientExtension(client, options.builderCode);
  return client;
}

export function createX402BuyerPaidFetch(options: CreateX402BuyerPaidFetchOptions = {}): typeof globalThis.fetch {
  const client = createX402BuyerClient(options);
  return wrapFetchWithPayment(options.fetchImpl || globalThis.fetch, client);
}

export function createLazyX402BuyerPaidFetch(
  env: NodeJS.ProcessEnv = process.env,
  _options: CreateX402BuyerPayerRuntimeOptions = {},
): typeof globalThis.fetch {
  const runtime = getDefaultX402BuyerPayerRuntime(env);
  return async (input, init) => {
    const paidFetch = await runtime.getPaidFetch();
    return paidFetch(input, init);
  };
}

export function x402BuyerPaymentModeFromEnv(env: NodeJS.ProcessEnv = process.env): X402BuyerPaymentMode {
  return env.LLM_PAYMENT_MODE === 'x402' ? 'x402' : 'free';
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
      res.status(402).json({
        x402Version: 2,
        accepts: config.paymentRequired.accepts,
        error: 'Payment Required',
      });
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
        res.status(402).json({
          x402Version: 2,
          accepts: config.paymentRequired.accepts,
          error: 'Payment Required: Invalid or used receipt',
        });
        return;
      }

      next();
    } catch {
      res.status(400).json({ error: 'Invalid X-402-Payment header' });
    }
  };
}
