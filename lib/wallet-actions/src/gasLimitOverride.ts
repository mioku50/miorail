import { encodeFunctionData, numberToHex, parseAbi, type Hex } from 'viem';
import type { Config } from 'wagmi';
import { getConnectorClient, getPublicClient } from 'wagmi/actions';

// ---------------------------------------------------------------------------
// The gas a batch is given, when the wallet would give it none to spare.
//
// On 2026-11-12 a Base Account sold 0.0279 AAPLc through KyberSwap twice, and
// both batches reached Base and reverted with "Call failed": the wallet gave
// the operation 625,592 gas for its calls, and in the block it landed in the
// swap needed a little more. Replayed one block earlier the same calls ran with
// 543 gas to spare. Base Account sets a batch's gas at the least that runs when
// it estimates: on its five operations read back that day the limit was 0.993
// to 1.003 of that least. A swap whose pools move between the estimate and the
// block then fails, and a heavy multi-pool route is the one that fails.
//
// The wallet takes a gas limit for each call from the app: `gasLimitOverride`,
// a call capability its SDK announces for every chain, and its server adds
// those limits up into the operation's. This measures each call as the wallet
// will run it, the batch sent from the account to itself, one prefix at a time,
// and gives each call what it adds, plus a margin. The margin costs nothing:
// an EntryPoint v0.6 operation is charged for the gas it used, not the gas it
// was allowed, and the fee sponsor's own ceiling is far above it.
//
// Anything not measured goes exactly as before, with the wallet's estimate:
// a wallet that does not announce the capability, an account with no code yet
// (its first operation deploys it, and a batch run against no code measures
// nothing), an estimate that failed or did not answer in time.
// ---------------------------------------------------------------------------

/** Added to what each call measured, in percent. */
export const GAS_LIMIT_MARGIN_PERCENT_V1 = BigInt(30);
/** Added to each call on top of the margin. */
export const GAS_LIMIT_CALL_EXTRA_V1 = BigInt(20_000);
/** How long a press waits for the measurement before it sends without one. */
export const GAS_LIMIT_MEASURE_TIMEOUT_MS_V1 = 2_500;
/** More calls than this are not measured: one estimate per prefix. */
export const GAS_LIMIT_MAX_CALLS_V1 = 12;

const EXECUTE_BATCH_ABI_V1 = parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)']);

export interface SizedCallV1 {
  to: string;
  data?: string;
  value?: string | number | bigint | null;
  capabilities?: Record<string, unknown>;
}

export type GasEstimatorV1 = (tx: { from: Hex; to: Hex; data: Hex }) => Promise<bigint>;
export type CodeReaderV1 = (address: Hex) => Promise<string | undefined>;

function capabilityAnswerV1(entry: unknown): boolean | null {
  if (!entry || typeof entry !== 'object') return null;
  const capability = (entry as Record<string, unknown>).gasLimitOverride;
  if (!capability || typeof capability !== 'object') return null;
  const supported = (capability as { supported?: unknown }).supported;
  return typeof supported === 'boolean' ? supported : null;
}

/**
 * Whether the wallet takes a gas limit per call on this chain. Base Account
 * announces it under the all-chains key (`0x0`, which wagmi turns into `0`);
 * what a wallet says for this chain itself wins over that.
 */
export function gasLimitOverrideSupportV1(capabilities: unknown, chainId = 8453): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const byChain = capabilities as Record<string | number, unknown>;
  const own = capabilityAnswerV1(byChain[chainId] ?? byChain[`0x${chainId.toString(16)}`]);
  if (own !== null) return own;
  return capabilityAnswerV1(byChain[0] ?? byChain['0x0']) === true;
}

/** What a transaction pays before it runs anything: 21,000, and 16 per non-zero byte of data, 4 per zero. */
export function intrinsicGasV1(data: string): bigint {
  let gas = BigInt(21_000);
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  for (let index = 0; index + 1 < hex.length; index += 2) {
    gas += hex.slice(index, index + 2) === '00' ? BigInt(4) : BigInt(16);
  }
  return gas;
}

function callValueV1(value: SizedCallV1['value']): bigint {
  if (value === null || value === undefined || value === '') return BigInt(0);
  return BigInt(value);
}

/** The account's own batch call, holding the first `count` calls. */
export function batchPrefixDataV1(calls: readonly SizedCallV1[], count: number): Hex {
  return encodeFunctionData({
    abi: EXECUTE_BATCH_ABI_V1,
    functionName: 'executeBatch',
    args: [
      calls.slice(0, count).map((call) => ({
        target: call.to as Hex,
        value: callValueV1(call.value),
        data: (call.data && call.data.length > 0 ? call.data : '0x') as Hex,
      })),
    ],
  });
}

/** One call's limit from what it measured: the margin, then the extra. */
export function paddedGasV1(measured: bigint): bigint {
  return measured + (measured * GAS_LIMIT_MARGIN_PERCENT_V1) / BigInt(100) + GAS_LIMIT_CALL_EXTRA_V1;
}

/**
 * Each call's gas limit, or null when the batch could not be measured.
 *
 * Prefix k is the batch's first k calls, estimated as the account calling
 * itself; what it runs is its estimate less the intrinsic gas of that one
 * transaction. A call's share is what its prefix runs beyond the one before
 * (the account's own overhead falls to the first call). Every prefix of a
 * batch that runs also runs, since a call sees only the calls before it.
 */
export async function measuredCallGasLimitsV1(input: {
  from: Hex;
  calls: readonly SizedCallV1[];
  estimate: GasEstimatorV1;
}): Promise<bigint[] | null> {
  const { from, calls } = input;
  if (calls.length === 0 || calls.length > GAS_LIMIT_MAX_CALLS_V1) return null;
  const prefixes = calls.map((_, index) => batchPrefixDataV1(calls, index + 1));
  let estimates: bigint[];
  try {
    estimates = await Promise.all(prefixes.map((data) => input.estimate({ from, to: from, data })));
  } catch {
    return null;
  }
  const limits: bigint[] = [];
  let before = BigInt(0);
  for (let index = 0; index < estimates.length; index += 1) {
    const runs = estimates[index]! - intrinsicGasV1(prefixes[index]!);
    if (runs <= BigInt(0)) return null;
    const share = runs > before ? runs - before : BigInt(0);
    if (runs > before) before = runs;
    limits.push(paddedGasV1(share));
  }
  return limits;
}

/** A call as it is sent: as given, perhaps with capabilities of its own. */
export type WithCallCapabilitiesV1<T> = T & { capabilities?: Record<string, unknown> };

/** The calls with their limits attached, each keeping any capability it already carried. */
export function withGasLimitOverridesV1<T extends SizedCallV1>(calls: readonly T[], limits: readonly bigint[]): WithCallCapabilitiesV1<T>[] {
  if (limits.length !== calls.length) return [...calls];
  return calls.map((call, index) => ({
    ...call,
    capabilities: { ...(call.capabilities ?? {}), gasLimitOverride: { value: numberToHex(limits[index]!) } },
  }));
}

/** No account code to measure against: none at all, or an EIP-7702 delegation, which is an EOA's. */
export function accountCodeMeasurableV1(code: string | undefined): boolean {
  if (!code || code === '0x') return false;
  return !code.toLowerCase().startsWith('0xef0100');
}

/**
 * The calls to send: with a measured limit on each when the wallet takes one,
 * unchanged otherwise. `limits` says which it was.
 */
export async function gasLimitedCallsV1<T extends SizedCallV1>(input: {
  from: string;
  calls: readonly T[];
  capabilities: unknown;
  chainId?: number;
  estimate: GasEstimatorV1;
  code: CodeReaderV1;
  timeoutMs?: number;
}): Promise<{ calls: WithCallCapabilitiesV1<T>[]; limits: bigint[] | null }> {
  const unchanged = { calls: [...input.calls] as WithCallCapabilitiesV1<T>[], limits: null };
  if (!gasLimitOverrideSupportV1(input.capabilities, input.chainId ?? 8453)) return unchanged;
  const from = input.from.toLowerCase() as Hex;
  const measure = (async () => {
    if (!accountCodeMeasurableV1(await input.code(from))) return null;
    return measuredCallGasLimitsV1({ from, calls: input.calls, estimate: input.estimate });
  })().catch(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), input.timeoutMs ?? GAS_LIMIT_MEASURE_TIMEOUT_MS_V1);
  });
  let limits: bigint[] | null;
  try {
    limits = await Promise.race([measure, timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (!limits) return unchanged;
  return { calls: withGasLimitOverridesV1(input.calls, limits), limits };
}

/**
 * Estimates and code read from the page's own public node for the chain, never through the wallet.
 *
 * The page's wagmi config is taken as an object: each app resolves its own copy of wagmi's types, which
 * do not match this package's, while the object is the same one at run time (as in liveWalletConnection).
 */
export function publicGasMeterV1(config: object, chainId = 8453): { estimate: GasEstimatorV1; code: CodeReaderV1 } {
  const client = () => {
    const found = getPublicClient(config as Config, { chainId: chainId as never });
    if (!found) throw new Error(`No public client for chain ${chainId}`);
    return found;
  };
  return {
    estimate: async (tx) =>
      BigInt(
        (await client().request({
          method: 'eth_estimateGas',
          params: [{ from: tx.from, to: tx.to, data: tx.data }],
        } as never)) as string,
      ),
    code: async (address) => client().getCode({ address }),
  };
}

/**
 * `wallet_sendCalls`, keeping each call's own capabilities.
 *
 * viem's `sendCalls` (2.53) rebuilds every call as `{ data, to, value }` and so
 * drops a call capability on the way to the wallet. This sends the request as
 * viem would (EIP-5792 version 2.0.0, the chain and the account named, the same
 * connector client wagmi checks for the account and the chain) with the calls'
 * capabilities kept. It is used only for calls that carry one.
 */
export async function sendCallsKeepingCallCapabilitiesV1(
  config: object,
  input: WalletSendCallsInputV1,
): Promise<{ id: string }> {
  const client = await getConnectorClient(config as Config, { account: input.account as Hex, chainId: input.chainId as never });
  return walletSendCallsIdV1(await client.request(walletSendCallsRequestV1(input) as never, { retryCount: 0 }));
}

export interface WalletSendCallsInputV1 {
  account: string;
  chainId: number;
  calls: readonly SizedCallV1[];
  capabilities?: Record<string, unknown>;
  forceAtomic: boolean;
}

/** The request viem would send, with each call's capabilities kept. */
export function walletSendCallsRequestV1(input: WalletSendCallsInputV1) {
  return {
    method: 'wallet_sendCalls' as const,
    params: [
      {
        atomicRequired: input.forceAtomic,
        calls: input.calls.map((call) => {
          const value = callValueV1(call.value);
          return {
            to: call.to,
            data: call.data,
            value: value > BigInt(0) ? numberToHex(value) : undefined,
            ...(call.capabilities ? { capabilities: call.capabilities } : {}),
          };
        }),
        capabilities: input.capabilities,
        chainId: numberToHex(input.chainId),
        from: input.account,
        version: '2.0.0',
      },
    ],
  };
}

/** The batch id from a wallet's answer: a bare string from an older wallet, `{ id }` from EIP-5792 v2. */
export function walletSendCallsIdV1(response: unknown): { id: string } {
  if (typeof response === 'string' && response.length > 0) return { id: response };
  const id = (response as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || id.length === 0) throw new Error('The wallet returned no id for the batch');
  return { id };
}
