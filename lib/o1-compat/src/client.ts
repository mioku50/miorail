import {
  O1TradingOrderRequestV1Schema,
  O1TradingOrderResponseV1Schema,
  O1_HOST_V1,
  O1_ORDER_PATH_V1,
  type O1TradingOrderRequestV1,
  type O1TradingOrderResponseV1,
} from './contracts.js';

// ---------------------------------------------------------------------------
// T67D §3 — the read-only compatibility client.
//
// What it can do: ask api.o1.exchange for an UNSIGNED order batch.
// What it cannot do, structurally rather than by policy:
//
//   * reach any other host or path — both are constants below, and the request
//     never takes a URL. A provider URL that a caller can influence is a
//     provider URL an attacker can influence.
//   * sign anything. There is no signer here, no key, and no `signed` field in
//     any schema it can produce.
//   * call /api/v2/order/complete. It is not implemented. Adding it would mean
//     Miorail hands a signed transaction to a third party to broadcast, which
//     is the failure the whole gate exists to document.
//
// The bearer token is never logged, hashed, or attached to an error. Errors
// carry a status and a code — never a body, because a provider error body is a
// place a request header can be echoed back.
// ---------------------------------------------------------------------------

export type O1ClientErrorCodeV1 =
  | 'o1_not_configured'
  | 'o1_unauthorized'
  | 'o1_rate_limited'
  | 'o1_server_error'
  | 'o1_timeout'
  | 'o1_network_error'
  | 'o1_malformed_response';

export class O1ClientError extends Error {
  readonly code: O1ClientErrorCodeV1;
  readonly status: number | null;

  constructor(code: O1ClientErrorCodeV1, status: number | null = null) {
    // Deliberately terse. The message is built from the code and the status
    // only, so no provider text — and no echoed Authorization header — can ride
    // out through a log line.
    super(`o1 trading API: ${code}${status === null ? '' : ` (${status})`}`);
    this.name = 'O1ClientError';
    this.code = code;
    this.status = status;
  }
}

export interface O1CompatClientConfigV1 {
  configured: boolean;
  live: boolean;
  timeoutMs: number;
  missing: string[];
}

const DEFAULT_TIMEOUT_MS_V1 = 10_000;
const MAX_TIMEOUT_MS_V1 = 30_000;

export function o1ConfigFromEnvV1(env: NodeJS.ProcessEnv = process.env): O1CompatClientConfigV1 {
  const token = env.O1_TRADING_API_TOKEN?.trim();
  const raw = Number(env.O1_TRADING_TIMEOUT_MS);
  const missing: string[] = [];
  if (!token) missing.push('O1_TRADING_API_TOKEN');
  return {
    configured: Boolean(token),
    // Default false. A live probe is opt-in twice: this flag and an interactive
    // confirmation at the CLI.
    live: env.O1_TRADING_COMPAT_LIVE === 'true',
    timeoutMs:
      Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_TIMEOUT_MS_V1) : DEFAULT_TIMEOUT_MS_V1,
    missing,
  };
}

/** The one URL this client can build. Exported so a test can assert it rather
 * than trusting a comment. */
export function o1OrderUrlV1(): string {
  return `https://${O1_HOST_V1}${O1_ORDER_PATH_V1}`;
}

export interface O1CompatClientDepsV1 {
  fetchImpl?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
}

/**
 * Requests an unsigned order batch. Nothing is signed and nothing is submitted.
 *
 * The response is parsed with a strict schema: an unexpected field means the
 * provider changed something nobody has judged, and continuing past it would be
 * deciding it is harmless without looking.
 */
export async function requestUnsignedOrderV1(
  request: O1TradingOrderRequestV1,
  deps: O1CompatClientDepsV1 = {},
): Promise<O1TradingOrderResponseV1> {
  const env = deps.env ?? process.env;
  const config = o1ConfigFromEnvV1(env);
  if (!config.configured) throw new O1ClientError('o1_not_configured');

  const parsed = O1TradingOrderRequestV1Schema.parse(request);
  // `schemaVersion` is Miorail's own marker for the contract it validated
  // against. It is stripped rather than sent: the provider has no use for it,
  // and a field it does not expect is a field it might reject or echo.
  const body: Record<string, unknown> = { ...parsed };
  delete body.schemaVersion;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? globalThis.fetch)(o1OrderUrlV1(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.O1_TRADING_API_TOKEN!.trim()}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new O1ClientError('o1_timeout');
    }
    throw new O1ClientError('o1_network_error');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new O1ClientError('o1_unauthorized', response.status);
  }
  if (response.status === 429) throw new O1ClientError('o1_rate_limited', response.status);
  if (response.status >= 500) throw new O1ClientError('o1_server_error', response.status);
  if (!response.ok) throw new O1ClientError('o1_server_error', response.status);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new O1ClientError('o1_malformed_response', response.status);
  }
  const decoded = O1TradingOrderResponseV1Schema.safeParse(payload);
  if (!decoded.success) throw new O1ClientError('o1_malformed_response', response.status);
  return decoded.data;
}
