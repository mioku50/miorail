import {
  createBitrefillCatalogSourceV1,
  createBitrefillOrderGatewayV1,
  type CommerceCatalogSourceV1,
  type CommerceOrderGatewayV1,
} from '@mioagent/commerce-engine';
import type { CommerceOrderV1, HashV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T64 — server-side commerce configuration and the process-local order book.
//
// Configuration is read from the environment ONLY: no request, no client, and
// no LLM output can influence which host is called or with which credential.
// The Bitrefill access token is held in memory, attached as a header by the
// engine, and never logged, hashed, or returned.
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
  accessToken: string | undefined;
}

export function getCommerceRuntimeConfigV1(): CommerceRuntimeConfigV1 {
  const token = process.env.BITREFILL_ACCESS_TOKEN?.trim();
  return {
    timeoutMs: readIntEnv('MIORAIL_COMMERCE_TIMEOUT_MS', 8_000),
    freshnessTtlMs: readIntEnv('MIORAIL_COMMERCE_FRESHNESS_TTL_MS', 120_000),
    accessToken: token && token.length > 0 ? token : undefined,
  };
}

let catalogSource: CommerceCatalogSourceV1 | null = null;
let orderGateway: CommerceOrderGatewayV1 | null = null;

export function resolveCommerceCatalogSourceV1(): CommerceCatalogSourceV1 {
  if (catalogSource) return catalogSource;
  const config = getCommerceRuntimeConfigV1();
  catalogSource = createBitrefillCatalogSourceV1({
    timeoutMs: config.timeoutMs,
    freshnessTtlMs: config.freshnessTtlMs,
    accessToken: config.accessToken,
  });
  return catalogSource;
}

export function resolveCommerceOrderGatewayV1(): CommerceOrderGatewayV1 {
  if (orderGateway) return orderGateway;
  const config = getCommerceRuntimeConfigV1();
  orderGateway = createBitrefillOrderGatewayV1({
    timeoutMs: config.timeoutMs,
    accessToken: config.accessToken,
  });
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
 * it cannot bind, and the storefront's own `my/orders` remains the fallback.
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
