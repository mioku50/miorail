import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import type { WalletClient } from 'viem';

export type PaidActionState =
  | 'idle'
  | 'preparing_payment'
  | 'awaiting_wallet_confirmation'
  | 'settling_payment'
  | 'running_action'
  | 'succeeded'
  | 'rejected'
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
}

export interface X402PaymentReceipt {
  success?: boolean;
  payer?: string;
  transaction?: string;
  network?: string;
  errorReason?: string;
  [key: string]: unknown;
}

export interface PaidFetchOptions {
  route: string;
  walletClient?: WalletClient | null;
  expectedChainId?: number;
  onState?: (state: PaidActionState) => void;
  fetchImpl?: typeof fetch;
}

type WalletClientWithAccount = WalletClient & {
  account: NonNullable<WalletClient['account']> & { address: `0x${string}` };
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

  constructor(state: PaidActionState, message: string, status?: number) {
    super(message);
    this.name = 'PaidActionError';
    this.state = state;
    this.status = status;
  }
}

export const PAID_ACTION_LABELS: Record<PaidActionState, string> = {
  idle: 'Pay 0.001 USDC & Run',
  preparing_payment: 'Preparing payment',
  awaiting_wallet_confirmation: 'Confirm in Base Account',
  settling_payment: 'Settling payment...',
  running_action: 'Running action',
  succeeded: 'Paid & completed',
  rejected: 'Payment rejected - retry',
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
      return 'Approve the USDC payment in your wallet.';
    case 'settling_payment':
      return 'Waiting for facilitator settlement.';
    case 'running_action':
      return 'Payment settled; protected route is running.';
    case 'succeeded':
      return 'Receipt saved to Fuel history.';
    case 'rejected':
      return 'Payment rejected.';
    case 'insufficient_funds':
      return 'Insufficient USDC on Base.';
    case 'unsupported_wallet':
      return 'Connect wallet first.';
    case 'settlement_failed':
      return 'Payment settled, but action result failed.';
    case 'failed':
      return 'Payment failed.';
    default:
      return 'User-confirmed x402 payment.';
  }
}

export function mapPaidActionError(error: unknown): PaidActionError {
  if (error instanceof PaidActionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const clean = message.toLowerCase();
  if (/user rejected|user denied|request rejected|4001|rejected/i.test(message)) {
    return new PaidActionError('rejected', 'Payment rejected');
  }
  if (/insufficient|exceeds balance|not enough|balance/i.test(clean)) {
    return new PaidActionError('insufficient_funds', 'Insufficient USDC on Base');
  }
  if (/unsupported|signtypeddata|wallet client|connector/i.test(clean)) {
    return new PaidActionError('unsupported_wallet', 'Unsupported wallet for x402 payment signing');
  }
  if (/settlement|facilitator|payment required|402/i.test(clean)) {
    return new PaidActionError('settlement_failed', 'Payment settlement failed');
  }
  return new PaidActionError('failed', 'Payment failed');
}

export function decodeX402PaymentResponseHeader(header: string | null): X402PaymentReceipt | null {
  if (!header) return null;
  try {
    return decodePaymentResponseHeader(header) as X402PaymentReceipt;
  } catch {
    try {
      return JSON.parse(atob(header)) as X402PaymentReceipt;
    } catch {
      return null;
    }
  }
}

export function hasSupportedWalletClient(walletClient?: WalletClient | null): walletClient is WalletClientWithAccount {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeX402PaymentRequired(body: unknown, resourceUrl: string): unknown {
  if (!isRecord(body) || body.x402Version !== 2 || !Array.isArray(body.accepts)) {
    return body;
  }

  const resource = isRecord(body.resource) && typeof body.resource.url === 'string'
    ? body.resource
    : {
        url: resourceUrl,
        description: typeof body.error === 'string' ? body.error : 'x402 protected resource',
      };

  return {
    ...body,
    resource,
    accepts: body.accepts.map((accept) => {
      if (!isRecord(accept)) return accept;
      return {
        scheme: 'exact',
        ...accept,
      };
    }),
  };
}

function createX402CompatibilityFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.status !== 402) return response;

    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }

    const resourceUrl = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.toString()
        : String(input);
    const normalized = normalizeX402PaymentRequired(body, resourceUrl);
    if (normalized === body) return response;

    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json');
    headers.set('PAYMENT-REQUIRED', encodePaymentRequiredHeader(normalized as never));
    return new Response(JSON.stringify(normalized), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

export async function runX402PaidFetch<TBody = unknown>({
  route,
  walletClient,
  expectedChainId = 8453,
  onState,
  fetchImpl = fetch,
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
      setState('settling_payment');
      return signature;
    },
  };

  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer,
    networks: [`eip155:${expectedChainId}`],
  });

  setState('settling_payment');
  const paidFetch = wrapFetchWithPayment(createX402CompatibilityFetch(fetchImpl), client);
  let response: Response;
  try {
    response = await paidFetch(resolvePaidRoute(route), {
      headers: {
        'Accept': 'application/json',
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
    throw new PaidActionError('settlement_failed', 'x402 facilitator unavailable', 503);
  }
  if (response.status === 402) {
    throw new PaidActionError('settlement_failed', 'Payment settlement failed', 402);
  }
  if (!response.ok) {
    throw new PaidActionError('failed', `Paid endpoint failed: ${response.status}`, response.status);
  }

  setState('running_action');
  let body: TBody;
  try {
    body = await response.clone().json() as TBody;
  } catch {
    body = {} as TBody;
  }

  setState('succeeded');
  return {
    body,
    response,
    receipt,
    paymentResponseHeader,
    paid: Boolean(receipt?.success || paymentResponseHeader),
    completedAt: new Date().toISOString(),
  };
}
