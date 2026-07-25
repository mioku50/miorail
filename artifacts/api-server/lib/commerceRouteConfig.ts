import {
  createBitrefillCatalogSourceV1,
  createBitrefillOrderGatewayV1,
  createBitrefillPersonalCatalogSourceV1,
  createBitrefillPersonalOrderGatewayV1,
  resolveCommerceCredentialV1,
  type CommerceApiSurfaceV1,
  type CommerceCatalogSourceV1,
  type CommerceOrderGatewayV1,
} from '@mioagent/commerce-engine';
import type { CommerceOrderV1, HashV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T64/T64.1 — server-side commerce configuration and the process-local order
// book.
//
// Two credentials reach two DIFFERENT Bitrefill APIs, and this module is where
// the surface is chosen:
//
//   BITREFILL_API_KEY      → Personal API `/v2/*`, `Authorization: Bearer …`
//   BITREFILL_ACCESS_TOKEN → x402 SIWX session `/x402/*`, `X-Access-Token: …`
//
// The engine's `commerceAuthHeadersV1` refuses to attach either credential to
// the other surface, so a misconfiguration is a loud typed failure rather than
// an account key quietly sent to the wrong gate.
//
// Configuration is read from the environment ONLY: no request, no client, and
// no LLM output can influence which host is called or with which credential.
// Neither credential is ever logged, hashed, or returned.
// ---------------------------------------------------------------------------

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface CommerceRuntimeConfigV1 {
  timeoutMs: number;
  freshnessTtlMs: number;
  apiKey: string | undefined;
  accessToken: string | undefined;
}

export function getCommerceRuntimeConfigV1(): CommerceRuntimeConfigV1 {
  const apiKey = process.env.BITREFILL_API_KEY?.trim();
  const accessToken = process.env.BITREFILL_ACCESS_TOKEN?.trim();
  return {
    timeoutMs: readIntEnv('MIORAIL_COMMERCE_TIMEOUT_MS', 8_000),
    freshnessTtlMs: readIntEnv('MIORAIL_COMMERCE_FRESHNESS_TTL_MS', 120_000),
    apiKey: apiKey && apiKey.length > 0 ? apiKey : undefined,
    accessToken: accessToken && accessToken.length > 0 ? accessToken : undefined,
  };
}

/** Which Bitrefill API this deployment is configured to reach. Reported to
 * operators (never with the credential itself) so a wrong key is diagnosable. */
export function resolveCommerceSurfaceV1(): CommerceApiSurfaceV1 | 'unconfigured' {
  const config = getCommerceRuntimeConfigV1();
  const credential = resolveCommerceCredentialV1(config);
  if (credential.kind === 'personal_api') return 'personal_api';
  if (credential.kind === 'x402_session') return 'x402';
  return 'unconfigured';
}

let catalogSource: CommerceCatalogSourceV1 | null = null;
let orderGateway: CommerceOrderGatewayV1 | null = null;

/**
 * The Personal API wins when its key is present: it is the account-backed
 * catalogue. Otherwise the x402 surface is used, which works unauthenticated
 * (each gated route then answers 402, reported honestly as
 * `provider_payment_required`) or with a SIWX session token.
 */
export function resolveCommerceCatalogSourceV1(): CommerceCatalogSourceV1 {
  if (catalogSource) return catalogSource;
  const config = getCommerceRuntimeConfigV1();
  catalogSource = config.apiKey
    ? createBitrefillPersonalCatalogSourceV1({
        timeoutMs: config.timeoutMs,
        freshnessTtlMs: config.freshnessTtlMs,
        apiKey: config.apiKey,
      })
    : createBitrefillCatalogSourceV1({
        timeoutMs: config.timeoutMs,
        freshnessTtlMs: config.freshnessTtlMs,
        accessToken: config.accessToken,
      });
  return catalogSource;
}

export function resolveCommerceOrderGatewayV1(): CommerceOrderGatewayV1 {
  if (orderGateway) return orderGateway;
  const config = getCommerceRuntimeConfigV1();
  orderGateway = config.apiKey
    ? createBitrefillPersonalOrderGatewayV1({ timeoutMs: config.timeoutMs, apiKey: config.apiKey })
    : createBitrefillOrderGatewayV1({ timeoutMs: config.timeoutMs, accessToken: config.accessToken });
  return orderGateway;
}

/** Test seam: drops the memoized source/gateway so a test can inject its own. */
export function resetCommerceRuntimeV1(): void {
  catalogSource = null;
  orderGateway = null;
}

// --- Process-local order book ----------------------------------------------

interface StoredCommerceOrderV1 {
  order: CommerceOrderV1;
  evidenceSetHash: HashV1;
  tenantId: string;
  walletAddress: string;
  storedAt: number;
}

const orders = new Map<string, StoredCommerceOrderV1>();

/** Orders are kept for one invoice lifetime plus a reconciliation window. */
const ORDER_RETENTION_MS_V1 = 60 * 60_000;

/**
 * IN-MEMORY ON PURPOSE, AND A KNOWN LIMIT.
 *
 * Commerce has no durable tables yet, so a restart loses the binding between a
 * wallet and its open checkout. The consequence is deliberate and safe: the
 * status route then reports `unknown_order` rather than reconstructing a proof
 * it cannot bind, and the storefront's own order list remains the fallback.
 * Durable, tenant-scoped persistence is the gate this family has to pass
 * before Bitrefill can be promoted past `scored`.
 */
export function rememberCommerceOrderV1(input: StoredCommerceOrderV1): void {
  const cutoff = Date.now() - ORDER_RETENTION_MS_V1;
  for (const [key, value] of orders) {
    if (value.storedAt < cutoff) orders.delete(key);
  }
  orders.set(commerceOrderKeyV1(input.tenantId, input.order.invoiceId), input);
}

export function recallCommerceOrderV1(
  tenantId: string,
  invoiceId: string,
): StoredCommerceOrderV1 | null {
  const stored = orders.get(commerceOrderKeyV1(tenantId, invoiceId));
  if (!stored) return null;
  if (stored.storedAt < Date.now() - ORDER_RETENTION_MS_V1) {
    orders.delete(commerceOrderKeyV1(tenantId, invoiceId));
    return null;
  }
  return stored;
}

/** Tenant-scoped, so one wallet can never read another wallet's checkout. */
export function commerceOrderKeyV1(tenantId: string, invoiceId: string): string {
  return `${tenantId}|${invoiceId}`;
}

export function clearCommerceOrdersV1(): void {
  orders.clear();
}
