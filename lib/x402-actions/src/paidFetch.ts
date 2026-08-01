// T59 decision 10: verbatim move of
// artifacts/interface/src/lib/x402PaidFetch.ts into a shared,
// surface-agnostic package (web + miniapp both need it; the miniapp
// previously had no x402 client at all). The ONLY functional addition is
// `PaidFetchOptions.init` (decision 10's "extend PaidFetchOptions with an
// init field") — runX402PaidFetch was GET-only before this; POST + JSON body
// is required for /blueprints/:blueprintId/simulate. Every existing GET
// caller (PaidActionButton, Fuel actions) is unaffected: `init` defaults to
// undefined, which reproduces the exact prior request shape.
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';

/**
 * Deliberately NOT `import type { WalletClient } from 'viem'`. viem/wagmi
 * are peerDependencies here (this package must interoperate with whichever
 * exact viem instance the CONSUMING app — interface or miniapp — resolves,
 * each pinning its own typescript/zod peer set). Importing viem's nominal
 * `WalletClient` type directly makes pnpm's per-peer-variant package
 * instances structurally "different, unrelated types" across a package
 * boundary (a well-known pnpm+TS monorepo pitfall) and breaks `tsc -b` in
 * the consuming app. This structural subset is everything runX402PaidFetch
 * actually uses — any real viem WalletClient satisfies it.
 */
export interface X402WalletClientLike {
  account?: { address: `0x${string}` } | null;
  chain?: { id: number } | null;
  // Loosely typed on purpose: real wallet clients (viem/wagmi) declare a
  // wide, overloaded signTypedData signature that differs subtly by exact
  // package instance/version. Call-site safety comes from the concrete
  // `X402TypedDataMessage` shape this module always passes in, not from
  // this structural interface trying to mirror viem's own types exactly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTypedData: (parameters: any) => Promise<`0x${string}`>;
}

export type PaidActionState =
  | 'idle'
  | 'preparing_payment'
  | 'awaiting_wallet_confirmation'
  | 'awaiting_wallet'
  | 'submitted'
  | 'settling_payment'
  | 'settling'
  | 'running_action'
  | 'succeeded'
  | 'settled'
  | 'settled_degraded'
  | 'rejected'
  | 'cancelled'
  | 'failed'
  | 'insufficient_funds'
  | 'unsupported_wallet'
  | 'settlement_failed';

export interface PaidActionResult<TBody = unknown> {
  body: TBody;
  response: Response;
  receipt: X402PaymentReceipt | null;
  paymentResponseHeader: string | null;
  paid: boolean;
  completedAt: string;
  runId?: string;
}

export interface X402PaymentReceipt {
  success?: boolean;
  payer?: string;
  transaction?: string;
  txHash?: string;
  network?: string;
  errorReason?: string;
  [key: string]: unknown;
}

export interface PaidFetchOptions {
  route: string;
  walletClient?: X402WalletClientLike | null;
  expectedChainId?: number;
  onState?: (state: PaidActionState) => void;
  fetchImpl?: typeof fetch;
  runId?: string;
  /**
   * T59: optional request init (method/body/headers) merged into the paid
   * request — e.g. `{ method: 'POST', headers: { 'content-type':
   * 'application/json' }, body: JSON.stringify(payload) }`. Any `headers`
   * here are merged UNDER the runId/Accept headers below (those always win
   * on key collision) so callers can't accidentally drop idempotency
   * tracking.
   */
  init?: RequestInit;
}

type WalletClientWithAccount = X402WalletClientLike & {
  account: NonNullable<X402WalletClientLike['account']> & { address: `0x${string}` };
};

interface X402TypedDataMessage {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export class PaidActionError extends Error {
  readonly state: PaidActionState;
  readonly status?: number;
  readonly reason?: string;

  constructor(state: PaidActionState, message: string, status?: number, reason?: string) {
    super(message);
    this.name = 'PaidActionError';
    this.state = state;
    this.status = status;
    this.reason = reason;
  }
}

export const PAID_ACTION_LABELS: Record<PaidActionState, string> = {
  idle: 'Pay 0.001 USDC & Run',
  preparing_payment: 'Preparing payment',
  awaiting_wallet_confirmation: 'Confirm in Base Account',
  awaiting_wallet: 'Confirm in Base Account',
  submitted: 'Submitted payment',
  settling_payment: 'Settling payment...',
  settling: 'Settling payment...',
  running_action: 'Running action',
  succeeded: 'Paid & completed',
  settled: 'Paid & completed',
  settled_degraded: 'Paid (tx proof pending)',
  rejected: 'Payment rejected - retry',
  cancelled: 'Payment cancelled - retry',
  failed: 'Payment failed - retry',
  insufficient_funds: 'Insufficient USDC on Base',
  unsupported_wallet: 'Connect wallet first',
  settlement_failed: 'Payment settlement failed',
};

export function paidActionButtonLabel(state: PaidActionState, costLabel: string): string {
  if (state === 'idle') return `Pay ${costLabel} & Run`;
  return PAID_ACTION_LABELS[state];
}

export function paidActionCopy(state: PaidActionState): string {
  switch (state) {
    case 'preparing_payment':
      return 'Reading x402 payment requirements.';
    case 'awaiting_wallet_confirmation':
    case 'awaiting_wallet':
      return 'Approve the USDC payment in your wallet.';
    case 'submitted':
    case 'settling_payment':
    case 'settling':
      return 'Sending EIP-712 authorization to the Base x402 facilitator.';
    case 'running_action':
      return 'Payment verified. Executing protected action.';
    case 'succeeded':
    case 'settled':
      return 'Receipt saved to Fuel history.';
    case 'settled_degraded':
      return 'Payment settled; tx proof unavailable.';
    case 'rejected':
    case 'cancelled':
      return 'Signature cancelled. No funds were moved.';
    case 'insufficient_funds':
      return 'Your Base account needs USDC on Base to run this action.';
    case 'unsupported_wallet':
      return 'Connect a Base-compatible wallet before paying.';
    case 'settlement_failed':
      return 'Payment settlement failed on gateway.';
    case 'failed':
      return 'Action failed after payment step.';
    default:
      return 'Click to authorize payment on Base.';
  }
}

export function mapPaidActionError(error: unknown): PaidActionError {
  if (error instanceof PaidActionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const clean = message.toLowerCase();
  if (/user rejected|user denied|request rejected|4001|rejected/i.test(message)) {
    return new PaidActionError('rejected', 'Payment rejected', undefined, 'wallet_cancelled');
  }
  if (/insufficient|exceeds balance|not enough|balance/i.test(clean)) {
    return new PaidActionError('insufficient_funds', 'Insufficient USDC on Base', undefined, 'insufficient_funds');
  }
  if (/unsupported|signtypeddata|wallet client|connector/i.test(clean)) {
    return new PaidActionError('unsupported_wallet', 'Unsupported wallet for x402 payment signing', undefined, 'unsupported_wallet');
  }
  if (/settlement|facilitator|payment required|402/i.test(clean)) {
    return new PaidActionError('settlement_failed', 'Payment settlement failed', 402, 'facilitator_settlement_failed');
  }
  return new PaidActionError('failed', 'Payment failed', undefined, 'unknown');
}

export function decodeX402PaymentResponseHeader(header: string | null): X402PaymentReceipt | null {
  if (!header) return null;
  let parsed: unknown;
  try {
    parsed = decodePaymentResponseHeader(header);
  } catch {
    try {
      parsed = JSON.parse(atob(header));
    } catch {
      try {
        parsed = JSON.parse(decodeURIComponent(header));
      } catch {
        try {
          parsed = JSON.parse(header);
        } catch {
          parsed = null;
        }
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Record<string, unknown>;
  const txHash =
    typeof raw.txHash === 'string'
      ? raw.txHash
      : typeof raw.transaction === 'string'
        ? raw.transaction
        : undefined;
  return {
    ...raw,
    success: raw.success !== false,
    payer: typeof raw.payer === 'string' ? raw.payer : undefined,
    txHash,
    transaction: txHash,
    network: typeof raw.network === 'string' ? raw.network : undefined,
  };
}

export function hasSupportedWalletClient(walletClient?: X402WalletClientLike | null): walletClient is WalletClientWithAccount {
  return Boolean(
    walletClient?.account?.address &&
    typeof walletClient.signTypedData === 'function',
  );
}

export function resolvePaidRoute(route: string): string {
  if (/^https?:\/\//i.test(route)) return route;
  const origin = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'http://localhost';
  return new URL(route, origin).toString();
}

// ---------------------------------------------------------------------------
// T67X-A3 — there used to be a compatibility fetch here.
//
// It intercepted every 402, added a `resource` object and `scheme: 'exact'` to
// the body, re-encoded the PAYMENT-REQUIRED header from that patched body, and
// handed the result to the official client.
//
// It was both unnecessary and wrong. Unnecessary because the v2 client reads
// the PAYMENT-REQUIRED HEADER, which the resource server has always set
// correctly — the patched body was never consulted. Wrong because a client that
// supplies `scheme` is asserting which settlement scheme it is about to be
// charged under; that assertion belongs to the server, and a server whose 402
// the official client cannot read is a server bug, not a client concern.
//
// `lib/x402-gateway/src/conformance.test.ts` drives the real middleware with
// the unmodified official client and asserts the envelope directly. If Miorail
// ever emits a 402 the client cannot consume, that test fails — which is the
// signal to fix the response, not to re-add a repair here.
// ---------------------------------------------------------------------------

export async function runX402PaidFetch<TBody = unknown>({
  route,
  walletClient,
  expectedChainId = 8453,
  onState,
  fetchImpl = fetch,
  runId,
  init,
}: PaidFetchOptions): Promise<PaidActionResult<TBody>> {
  if (!hasSupportedWalletClient(walletClient)) {
    throw new PaidActionError('unsupported_wallet', 'Connect wallet first');
  }
  if (walletClient.chain?.id && walletClient.chain.id !== expectedChainId) {
    throw new PaidActionError('unsupported_wallet', 'Switch to Base');
  }

  const setState = (state: PaidActionState) => onState?.(state);
  setState('preparing_payment');
  const walletAccount = walletClient.account;

  const signer = {
    address: walletAccount.address,
    signTypedData: async (message: X402TypedDataMessage) => {
      setState('awaiting_wallet_confirmation');
      const signature = await walletClient.signTypedData({
        account: walletAccount,
        domain: message.domain,
        types: message.types,
        primaryType: message.primaryType,
        message: message.message,
      } as never);
      setState('submitted');
      return signature;
    },
  };

  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer,
    networks: [`eip155:${expectedChainId}`],
  });

  setState('settling_payment');
  const targetRoute = runId
    ? `${route}${route.includes('?') ? '&' : '?'}runId=${encodeURIComponent(runId)}`
    : route;
  const paidFetch = wrapFetchWithPayment(fetchImpl, client);
  let response: Response;
  try {
    response = await paidFetch(resolvePaidRoute(targetRoute), {
      ...init,
      headers: {
        'Accept': 'application/json',
        ...init?.headers,
        ...(runId ? { 'X-Idempotency-Key': runId, 'X-Miorail-Smoke-Run-Id': runId } : {}),
      },
    });
  } catch (error) {
    throw mapPaidActionError(error);
  }

  const paymentResponseHeader =
    response.headers.get('payment-response') ||
    response.headers.get('x-payment-response') ||
    null;
  const receipt = decodeX402PaymentResponseHeader(paymentResponseHeader);

  if (response.status === 503) {
    throw new PaidActionError('settlement_failed', 'x402 facilitator unavailable', 503, 'facilitator_settlement_failed');
  }
  if (response.status === 402) {
    throw new PaidActionError('settlement_failed', 'Payment settlement failed', 402, 'facilitator_settlement_failed');
  }
  if (!response.ok) {
    throw new PaidActionError('failed', `Paid endpoint failed: ${response.status}`, response.status, 'route_non_200');
  }

  setState('running_action');
  let body: TBody;
  try {
    body = await response.clone().json() as TBody;
  } catch {
    body = {} as TBody;
  }

  const rawBody = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const bodyIndicatesPaid = Boolean(rawBody.ok || rawBody.settlement === 'settled' || rawBody.success);
  const effectiveReceipt: X402PaymentReceipt | null =
    receipt ||
    (bodyIndicatesPaid
      ? {
          success: true,
          payer: typeof rawBody.payer === 'string' ? rawBody.payer : undefined,
          txHash:
            typeof rawBody.txHash === 'string'
              ? rawBody.txHash
              : typeof rawBody.transaction === 'string'
                ? rawBody.transaction
                : undefined,
          transaction:
            typeof rawBody.txHash === 'string'
              ? rawBody.txHash
              : typeof rawBody.transaction === 'string'
                ? rawBody.transaction
                : undefined,
          network: typeof rawBody.network === 'string' ? rawBody.network : undefined,
        }
      : null);

  setState('succeeded');
  return {
    body,
    response,
    receipt: effectiveReceipt,
    paymentResponseHeader,
    paid: Boolean(effectiveReceipt?.success || paymentResponseHeader || bodyIndicatesPaid),
    completedAt: new Date().toISOString(),
    runId,
  };
}
