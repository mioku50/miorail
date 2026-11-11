import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  http,
  keccak256,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { reusePassingCheckV1 } from './normalization.js';

/**
 * o1.exchange's execution boundary on Base: 0x's AllowanceHolder, running the
 * Settler that 0x's own registry names.
 *
 * Until 2026-10-20 an o1 order was a `swap` on o1's own upgradeable router
 * (pinned 2026-08-12, re-pinned 2026-10-19 after its upgrade to
 * `TerminalSwapX`). Since then every order o1 returns is an `exec` on 0x's
 * AllowanceHolder, and the old pin refused all of them. The operator approved
 * this boundary on 2026-11-11; o1's own router is no longer accepted, and an
 * order that names it again is a review event, not a fallback.
 *
 * What is pinned, and what cannot be:
 *
 * - AllowanceHolder is not a proxy. 0x publishes one address for every chain
 *   with the Cancun hardfork and says it may be hardcoded. Address and code
 *   hash are both checked; the hash was read at Base block 56,131,136 on
 *   2026-11-11 and is the one the Hydrex boundary has pinned since August.
 * - The Settler is redeployed often, and 0x says never to hardcode it and
 *   always to ask its registry (an ERC-721 whose token 2 is the taker-submitted
 *   Settler). `ownerOf(2)` is the current one; `prev(2)` is the one before,
 *   which 0x's API keeps using for a while after a deployment. A reverting
 *   `ownerOf` means 0x paused the Settler: nothing is quoted or built.
 *
 * What the bytes then guarantee, from 0x's source (0xProject/0x-settler,
 * AllowanceHolderBase.sol and SettlerBase.sol, read 2026-11-11):
 *
 * - `exec(operator, token, amount, target, data)` lets `operator`, and nobody
 *   else, move at most `amount` of `token` from the caller, and only until the
 *   call returns. It forwards `data` to `target` with the caller appended.
 * - `Settler.execute(slippage, actions, zid)` ends by sending its whole
 *   balance of `slippage.buyToken` to `slippage.recipient` and reverts when
 *   that is less than `slippage.minAmountOut`. What the actions do in between
 *   is not decoded here: they can spend the allowance above and nothing else
 *   of the caller's.
 */
export const O1_ZEROX_ALLOWANCE_HOLDER_V1 = '0x0000000000001ff3684f28c67538d4d072c22734' as const;
export const O1_ZEROX_ALLOWANCE_HOLDER_CODE_HASH_V1 =
  '0x99f5e8edaceacfdd183eb5f1da8a7757b322495b80cf7928db289a1b1a09f799' as const;
export const O1_ZEROX_DEPLOYER_V1 = '0x00000000000004533fe15556b1e086bb1a72ceae' as const;
/** 0x's feature number for the Settler a taker submits themselves. */
export const O1_ZEROX_TAKER_SUBMITTED_FEATURE_V1 = 2;

export const O1_ZEROX_EXEC_SELECTOR_V1 = '0x2213bc0b' as const;
/** `execute((address,address,uint256),bytes[],bytes32)`. `executeWithPermit`
 * has another selector and is never accepted: it would spend a signature. */
export const O1_ZEROX_SETTLER_EXECUTE_SELECTOR_V1 = '0x1fff991f' as const;

export const O1_ZEROX_EXEC_ABI_V1 = [
  {
    type: 'function',
    name: 'exec',
    stateMutability: 'payable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ name: 'result', type: 'bytes' }],
  },
] as const;

const O1_ZEROX_DEPLOYER_ABI_V1 = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'prev',
    stateMutability: 'view',
    inputs: [{ name: 'featureId', type: 'uint128' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Whether the bytes after `exec`'s own arguments are nothing, or exactly one
 * ERC-8021 attribution suffix (schema 0): the codes in ASCII, their length,
 * a zero byte and the sixteen-byte marker. o1 ends every order with its
 * Builder Code this way (seen 2026-11-11). AllowanceHolder reads its five
 * arguments and nothing after them, so the suffix changes nothing it does;
 * anything else behind the arguments is refused as unexplained.
 */
export function o1AttributionSuffixOrNothingV1(tail: string): boolean {
  if (tail === '') return true;
  const match = /^((?:[0-9a-f]{2}){1,64})([0-9a-f]{2})00(?:8021){8}$/.exec(tail.toLowerCase());
  if (!match) return false;
  const codes = match[1]!;
  if (parseInt(match[2]!, 16) !== codes.length / 2) return false;
  // Printable ASCII only: a code, or codes with commas between them.
  return (codes.match(/.{2}/g) ?? []).every((byte) => {
    const value = parseInt(byte, 16);
    return value >= 0x21 && value <= 0x7e;
  });
}

export interface O1SettlerSlippageV1 {
  recipient: `0x${string}`;
  buyToken: `0x${string}`;
  minAmountOut: bigint;
}

/**
 * Reads what the Settler will check at the end, from the place the Settler
 * reads it. `slippage` is a static struct, so its three words sit directly
 * after the selector whatever the encoder did with the actions after them.
 * Null when the bytes are not a call to `execute` or a word is not an address.
 */
export function readO1SettlerSlippageV1(data: string): O1SettlerSlippageV1 | null {
  const bytes = data.toLowerCase();
  // Selector, the three words, the two offsets-or-values that follow them.
  if (!/^0x[0-9a-f]*$/.test(bytes) || bytes.length < 10 + 5 * 64 || bytes.length % 2 !== 0) return null;
  if (bytes.slice(0, 10) !== O1_ZEROX_SETTLER_EXECUTE_SELECTOR_V1) return null;
  const word = (index: number) => bytes.slice(10 + index * 64, 10 + (index + 1) * 64);
  const address = (value: string): `0x${string}` | null =>
    /^0{24}[0-9a-f]{40}$/.test(value) ? (`0x${value.slice(24)}` as `0x${string}`) : null;
  const recipient = address(word(0));
  const buyToken = address(word(1));
  if (!recipient || !buyToken) return null;
  return { recipient, buyToken, minAmountOut: BigInt(`0x${word(2)}`) };
}

export interface O1RouterPinReaderV1 {
  verify(): Promise<
    | {
        ok: true;
        blockNumber: string;
        /** The Settlers 0x's registry names now: the current one, then the
         * one before it when there is one. Lowercase. */
        settlers: readonly `0x${string}`[];
      }
    | { ok: false; reason: 'not_configured' | 'unavailable' | 'mismatch' }
  >;
}

type O1PinResultV1 = Awaited<ReturnType<O1RouterPinReaderV1['verify']>>;

/** Comparison-time passes, per endpoint. A refusal is never kept. */
const O1_PIN_CACHE_V1 = new Map<string, { until: number; value: O1PinResultV1 }>();

/** The contract answered, and its answer was to revert. */
function revertedV1(error: unknown): boolean {
  if (!(error instanceof ContractFunctionExecutionError)) return false;
  return (
    error.cause instanceof ContractFunctionRevertedError ||
    error.cause instanceof ContractFunctionZeroDataError
  );
}

export function createO1RouterPinReaderV1(input: {
  rpcUrl: string;
  /** How long a pass is reused — for comparison only. Review and approval
   * build readers without it and read the chain every time. */
  cacheTtlMs?: number;
  now?: () => number;
}): O1RouterPinReaderV1 {
  const rpcUrl = input.rpcUrl.trim();
  const ttlMs = input.cacheTtlMs ?? 0;
  const now = input.now ?? Date.now;
  return {
    verify: () => reusePassingCheckV1(O1_PIN_CACHE_V1, rpcUrl, { ttlMs, now }, readPin),
  };

  async function readPin(): Promise<O1PinResultV1> {
    if (!rpcUrl) return { ok: false, reason: 'not_configured' };
    try {
      const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const feature = BigInt(O1_ZEROX_TAKER_SUBMITTED_FEATURE_V1);
      const registry = { address: O1_ZEROX_DEPLOYER_V1, abi: O1_ZEROX_DEPLOYER_ABI_V1 } as const;
      const [holderCode, current, previous, blockNumber] = await Promise.all([
        client.getBytecode({ address: O1_ZEROX_ALLOWANCE_HOLDER_V1 }),
        // A revert here is 0x saying the Settler is paused. It is a refusal,
        // not a failed read, and it is not softened by the one before.
        client
          .readContract({ ...registry, functionName: 'ownerOf', args: [feature] })
          .catch((error: unknown) => {
            if (revertedV1(error)) return null;
            throw error;
          }),
        // No previous Settler is an ordinary state of the registry.
        client
          .readContract({ ...registry, functionName: 'prev', args: [feature] })
          .catch((error: unknown) => {
            if (revertedV1(error)) return null;
            throw error;
          }),
        client.getBlockNumber(),
      ]);
      if (!holderCode || keccak256(holderCode as Hex) !== O1_ZEROX_ALLOWANCE_HOLDER_CODE_HASH_V1) {
        return { ok: false, reason: 'mismatch' };
      }
      if (!current || current.toLowerCase() === ZERO_ADDRESS) return { ok: false, reason: 'mismatch' };
      const settlers = [current, previous]
        .filter((value): value is `0x${string}` => typeof value === 'string' && value.toLowerCase() !== ZERO_ADDRESS)
        .map((value) => value.toLowerCase() as `0x${string}`);
      return { ok: true, blockNumber: blockNumber.toString(), settlers: [...new Set(settlers)] };
    } catch {
      // Never bubble a viem error: its diagnostic text contains the RPC URL.
      return { ok: false, reason: 'unavailable' };
    }
  }
}
