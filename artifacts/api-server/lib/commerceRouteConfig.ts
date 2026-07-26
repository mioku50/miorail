import {
  createBitrefillCatalogSourceV1,
  createBitrefillOrderGatewayV1,
  createBitrefillPersonalCatalogSourceV1,
  createBitrefillPersonalOrderGatewayV1,
  resolveCommerceCredentialV1,
  type CommerceApiSurfaceV1,
  type CommerceCatalogSourceV1,
  type CommerceOrderGatewayV1,
  type CommerceReceiptReaderV1,
} from '@mioagent/commerce-engine';

// ---------------------------------------------------------------------------
// T64/T64.1 — server-side commerce configuration.
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

// T64.2: the process-local order Map that used to live here is GONE. Orders
// are durable now (commerce_orders + commerce_order_events + commerce_proofs
// via createDatabaseCommerceStorageRepository), so a checkout survives a
// restart and a repeat cannot open a second invoice.

// ---------------------------------------------------------------------------
// T64.3 — the onchain receipt reader.
//
// Injected so the engine opens no socket. A missing RPC yields a reader that
// returns null, which the proof layer treats as `receipt_missing` rather than
// as a successful payment.
// ---------------------------------------------------------------------------

let receiptReader: CommerceReceiptReaderV1 | null = null;

export function resolveCommerceReceiptReaderV1(): CommerceReceiptReaderV1 {
  if (receiptReader) return receiptReader;
  const rpcUrl = process.env.BASE_MAINNET_RPC_URL?.trim();
  receiptReader = {
    async readReceipt(input: { transactionHash: string }) {
      if (!rpcUrl) return null;
      const { createPublicClient, http } = await import('viem');
      const { base } = await import('viem/chains');
      const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
      try {
        const receipt = await client.getTransactionReceipt({
          hash: input.transactionHash as `0x${string}`,
        });
        return {
          transactionHash: receipt.transactionHash,
          status: receipt.status === 'success' ? ('success' as const) : ('reverted' as const),
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          chainId: base.id,
          logs: receipt.logs.map((log) => ({
            address: log.address,
            topics: log.topics as readonly string[],
            data: log.data,
          })),
        };
      } catch {
        // A receipt that cannot be read is absent, never a success.
        return null;
      }
    },
  };
  return receiptReader;
}

export function resetCommerceReceiptReaderV1(): void {
  receiptReader = null;
}
