import { createHmac, timingSafeEqual } from 'node:crypto';
import { decodeFunctionData, encodeAbiParameters, keccak256, parseAbi, type Hex } from 'viem';

// ---------------------------------------------------------------------------
// Sponsored gas, bound to the exact calls a person approved.
//
// Growth plan step 2 (2026-09-23): a first stock purchase should not stop at
// "you need ETH for gas". Base Account asks an ERC-7677 paymaster to pay, and
// the paymaster Miorail points it at is this server — not Coinbase's endpoint,
// whose URL carries a billable key.
//
// The wallet calls the paymaster from its own origin, so no Miorail session
// comes with the request. What authenticates it is a token the approve step
// minted for ONE wallet and ONE exact list of calls: this module sponsors a
// user operation only when its sender is that wallet and its calldata decodes
// to exactly those calls. Anything else — another wallet, another contract, a
// changed amount, an expired token — gets a JSON-RPC refusal, and the wallet
// falls back to the user paying gas. Nothing here signs, broadcasts or holds a
// key to anything but the upstream URL.
// ---------------------------------------------------------------------------

export const SPONSORED_GAS_CHAIN_ID_V1 = '0x2105';

/**
 * EntryPoint v0.6, the one Base Account's smart wallet runs on. Only this one
 * is accepted: a user operation for another entry point has other fields, and
 * a verifier that half-understands it is worse than one that says no.
 */
export const SPONSORED_GAS_ENTRY_POINT_V1 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';

export const SPONSORED_GAS_METHODS_V1 = ['pm_getPaymasterStubData', 'pm_getPaymasterData'] as const;
export type SponsoredGasMethodV1 = (typeof SPONSORED_GAS_METHODS_V1)[number];

/** Default sponsored operations per wallet per UTC day. */
export const SPONSORED_GAS_DAILY_LIMIT_DEFAULT_V1 = 3;

/** How long an approval's sponsorship stays usable. The wallet asks for the
 * final paymaster data only after the person confirms, which can take a
 * minute; the swap's own slippage and deadline still bound what executes. */
export const SPONSORED_GAS_TOKEN_TTL_MS_V1 = 10 * 60 * 1000;

const SMART_WALLET_ABI_V1 = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);

export interface SponsoredCallV1 {
  to: string;
  /** Hex quantity or decimal string. */
  value: string | bigint;
  data: string;
}

function normalizedCallsV1(calls: readonly SponsoredCallV1[]) {
  return calls.map((call) => ({
    target: call.to.toLowerCase() as Hex,
    value: typeof call.value === 'bigint' ? call.value : BigInt(call.value),
    data: call.data.toLowerCase() as Hex,
  }));
}

/**
 * One digest for one list of calls, order included.
 *
 * Computed at approve time from the calls handed to the wallet and again here
 * from the calls the wallet actually asks to have paid for. The two sides use
 * this function and nothing else, so they cannot hash different things.
 */
export function sponsoredCallsDigestV1(calls: readonly SponsoredCallV1[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { name: 'target', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
          ],
        },
      ],
      [normalizedCallsV1(calls)],
    ),
  );
}

const ERC8021_MARKER_V1 = '80218021802180218021802180218021';

/**
 * Removes a trailing ERC-8021 attribution (schema 0), when there is one.
 *
 * The Builder Code rides on every Miorail batch as `dataSuffix`, and where a
 * smart wallet appends it — to the outer calldata or to a call — is the
 * wallet's choice. It is attribution, not an instruction: ABI decoding ignores
 * trailing bytes, which is the whole premise of the standard. Layout, read
 * from the end: 16-byte marker, 1-byte schema id (0), 1-byte length, codes.
 */
export function stripErc8021SuffixV1(data: string): string {
  const hex = data.toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) return hex;
  const body = hex.slice(2);
  if (!body.endsWith(ERC8021_MARKER_V1)) return hex;
  const beforeMarker = body.length - ERC8021_MARKER_V1.length;
  if (beforeMarker < 4) return hex;
  const schemaId = body.slice(beforeMarker - 2, beforeMarker);
  if (schemaId !== '00') return hex;
  const codesLength = Number.parseInt(body.slice(beforeMarker - 4, beforeMarker - 2), 16);
  const suffixChars = (codesLength + 2) * 2 + ERC8021_MARKER_V1.length;
  if (!Number.isFinite(codesLength) || codesLength === 0 || suffixChars > body.length) return hex;
  return `0x${body.slice(0, body.length - suffixChars)}`;
}

/**
 * The calls inside a smart wallet user operation, or null when the calldata
 * is not one of the two shapes Base Account's wallet produces.
 */
export function userOperationCallsV1(callData: string): SponsoredCallV1[] | null {
  if (typeof callData !== 'string' || !/^0x[0-9a-fA-F]*$/.test(callData)) return null;
  let decoded: ReturnType<typeof decodeFunctionData<typeof SMART_WALLET_ABI_V1>>;
  try {
    decoded = decodeFunctionData({ abi: SMART_WALLET_ABI_V1, data: stripErc8021SuffixV1(callData) as Hex });
  } catch {
    return null;
  }
  const raw =
    decoded.functionName === 'execute'
      ? [{ target: decoded.args[0], value: decoded.args[1], data: decoded.args[2] }]
      : decoded.args[0];
  return raw.map((call) => ({
    to: call.target.toLowerCase(),
    value: call.value,
    data: stripErc8021SuffixV1(call.data),
  }));
}

// ---------------------------------------------------------------------------
// The token the approve step mints and the paymaster checks.
// ---------------------------------------------------------------------------

export interface SponsorshipClaimV1 {
  v: 1;
  /** Lowercase smart-wallet address: the user operation's `sender`. */
  wallet: string;
  blueprintId: string;
  digest: Hex;
  /** Unix milliseconds. */
  expiresAt: number;
}

/**
 * The HMAC key, derived from the session secret for this one purpose.
 *
 * A derived key rather than the secret itself, so a token can never be
 * confused with a session signature, and no new secret has to be provisioned
 * for sponsorship to work. Null when there is no session secret: then there
 * is no sponsorship at all, rather than tokens signed with nothing.
 */
export function sponsorshipKeyV1(env: NodeJS.ProcessEnv): Buffer | null {
  const secret = env.SESSION_SECRET?.trim();
  if (!secret) return null;
  return createHmac('sha256', secret).update('miorail/sponsored-gas-token/v1').digest();
}

function base64UrlV1(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function issueSponsorshipTokenV1(claim: SponsorshipClaimV1, key: Buffer): string {
  const payload = base64UrlV1(JSON.stringify(claim));
  const signature = base64UrlV1(createHmac('sha256', key).update(payload).digest());
  return `${payload}.${signature}`;
}

export type SponsorshipTokenCheckV1 =
  | { ok: true; claim: SponsorshipClaimV1 }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifySponsorshipTokenV1(token: unknown, key: Buffer, nowMs: number): SponsorshipTokenCheckV1 {
  if (typeof token !== 'string' || token.length > 2000) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const expected = createHmac('sha256', key).update(parts[0]).digest();
  const given = Buffer.from(parts[1], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  let claim: SponsorshipClaimV1;
  try {
    claim = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as SponsorshipClaimV1;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    claim?.v !== 1 ||
    typeof claim.wallet !== 'string' ||
    typeof claim.blueprintId !== 'string' ||
    typeof claim.digest !== 'string' ||
    typeof claim.expiresAt !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (claim.expiresAt <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, claim };
}

// ---------------------------------------------------------------------------
// The per-wallet daily count.
//
// Held in memory: a restart forgets today's count, which the paymaster's own
// per-user limit in the CDP portal still bounds. Counted by distinct user
// operation NONCE, because a wallet may ask for the final paymaster data more
// than once for one operation, and a retry must not spend a person's quota.
// ---------------------------------------------------------------------------

export interface SponsorshipLedgerV1 {
  /** Whether one more operation (or this same one again) is within today's limit. */
  allows(wallet: string, nonce: string | null): boolean;
  /** Counts a sponsored operation once, however often it is asked for. */
  record(wallet: string, nonce: string): void;
  clear(): void;
}

export function createSponsorshipLedgerV1(input: { limit: () => number; now: () => Date }): SponsorshipLedgerV1 {
  let day = '';
  const seen = new Map<string, Set<string>>();
  const today = (): void => {
    const current = input.now().toISOString().slice(0, 10);
    if (current !== day) {
      day = current;
      seen.clear();
    }
  };
  return {
    allows(wallet, nonce) {
      today();
      const used = seen.get(wallet.toLowerCase());
      if (nonce !== null && used?.has(nonce.toLowerCase())) return true;
      return (used?.size ?? 0) < input.limit();
    },
    record(wallet, nonce) {
      today();
      const key = wallet.toLowerCase();
      const used = seen.get(key) ?? new Set<string>();
      used.add(nonce.toLowerCase());
      seen.set(key, used);
    },
    clear() {
      seen.clear();
      day = '';
    },
  };
}

export function sponsoredGasDailyLimitV1(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.SPONSORED_GAS_DAILY_LIMIT_PER_WALLET ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : SPONSORED_GAS_DAILY_LIMIT_DEFAULT_V1;
}

/**
 * Where the paymaster actually lives, or null.
 *
 * `CDP_PAYMASTER_URL` is the name this code documents; `Paymaster_endpoint`
 * is the label the CDP portal gives the same value, and the first operator to
 * configure it used that. Anything but Coinbase's Base RPC host is refused, so
 * a mistyped variable cannot point every user's gas request somewhere else.
 * The URL carries a billable key: it is returned to exactly one caller, the
 * forwarder, and never logged.
 */
export function paymasterUpstreamUrlV1(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.CDP_PAYMASTER_URL ?? env.Paymaster_endpoint ?? '').trim().replace(/^"|"$/g, '');
  return /^https:\/\/api\.developer\.coinbase\.com\/rpc\/v1\/base\/[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
}

// ---------------------------------------------------------------------------
// The whole policy, as one pure decision.
// ---------------------------------------------------------------------------

export type SponsoredGasRefusalCodeV1 =
  | 'invalid_request'
  | 'method_not_supported'
  | 'wrong_chain'
  | 'wrong_entry_point'
  | 'no_sponsorship'
  | 'sponsorship_invalid'
  | 'sponsorship_expired'
  | 'wrong_sender'
  | 'calls_not_approved'
  | 'daily_limit_reached';

export type SponsoredGasDecisionV1 =
  | { ok: true; method: SponsoredGasMethodV1; wallet: string; nonce: string; claim: SponsorshipClaimV1 }
  | { ok: false; code: SponsoredGasRefusalCodeV1; message: string };

/** JSON-RPC error codes, per ERC-7677's use of the standard ranges. */
export const SPONSORED_GAS_RPC_ERROR_CODE_V1: Readonly<Record<SponsoredGasRefusalCodeV1, number>> = {
  invalid_request: -32600,
  method_not_supported: -32601,
  wrong_chain: -32602,
  wrong_entry_point: -32602,
  no_sponsorship: -32602,
  sponsorship_invalid: -32602,
  sponsorship_expired: -32602,
  wrong_sender: -32602,
  calls_not_approved: -32602,
  daily_limit_reached: -32602,
};

export function decideSponsoredGasV1(input: {
  method: unknown;
  params: unknown;
  key: Buffer;
  nowMs: number;
  ledger: SponsorshipLedgerV1;
}): SponsoredGasDecisionV1 {
  const refuse = (code: SponsoredGasRefusalCodeV1, message: string): SponsoredGasDecisionV1 => ({
    ok: false,
    code,
    message,
  });
  if (!SPONSORED_GAS_METHODS_V1.includes(input.method as SponsoredGasMethodV1)) {
    return refuse('method_not_supported', 'Only pm_getPaymasterStubData and pm_getPaymasterData are served here.');
  }
  if (!Array.isArray(input.params) || input.params.length < 3) {
    return refuse('invalid_request', 'Expected [userOperation, entryPoint, chainId, context].');
  }
  const [userOp, entryPoint, chainId, context] = input.params as [unknown, unknown, unknown, unknown];
  if (typeof chainId !== 'string' || chainId.toLowerCase() !== SPONSORED_GAS_CHAIN_ID_V1) {
    return refuse('wrong_chain', 'Gas is sponsored on Base mainnet only.');
  }
  if (typeof entryPoint !== 'string' || entryPoint.toLowerCase() !== SPONSORED_GAS_ENTRY_POINT_V1) {
    return refuse('wrong_entry_point', 'Gas is sponsored for EntryPoint v0.6 user operations only.');
  }
  const op = userOp as { sender?: unknown; nonce?: unknown; callData?: unknown } | null;
  if (!op || typeof op.sender !== 'string' || typeof op.nonce !== 'string' || typeof op.callData !== 'string') {
    return refuse('invalid_request', 'The user operation is missing its sender, nonce or calldata.');
  }
  const token = (context as { sponsorship?: unknown } | null | undefined)?.sponsorship;
  if (token === undefined) {
    return refuse('no_sponsorship', 'This request carries no Miorail sponsorship.');
  }
  const verified = verifySponsorshipTokenV1(token, input.key, input.nowMs);
  if (!verified.ok) {
    return verified.reason === 'expired'
      ? refuse('sponsorship_expired', 'This sponsorship has expired. Approve the action again.')
      : refuse('sponsorship_invalid', 'This sponsorship was not issued by Miorail.');
  }
  const { claim } = verified;
  if (op.sender.toLowerCase() !== claim.wallet) {
    return refuse('wrong_sender', 'This sponsorship belongs to another wallet.');
  }
  const calls = userOperationCallsV1(op.callData);
  if (!calls || sponsoredCallsDigestV1(calls) !== claim.digest) {
    return refuse('calls_not_approved', 'These calls are not the ones that were approved.');
  }
  if (!input.ledger.allows(claim.wallet, op.nonce)) {
    return refuse('daily_limit_reached', "Today's sponsored gas for this wallet is used up; the wallet can still pay it.");
  }
  return { ok: true, method: input.method as SponsoredGasMethodV1, wallet: claim.wallet, nonce: op.nonce, claim };
}
