import { createPublicClient, getAddress, http, keccak256, type Hex } from 'viem';
import { base } from 'viem/chains';
import { reusePassingCheckV1 } from './normalization.js';

/**
 * o1.exchange standard-swap execution boundary on Base.
 *
 * The API currently returns an ERC-1967 proxy. Pinning only the proxy address
 * would let an upgrade silently change the code a Route Card authorises, so
 * both proxy and implementation bytecode are checked before quote/build. An
 * upgrade is a review event: the adapter becomes unavailable until these
 * constants are deliberately updated.
 *
 * Observed at Base block 49,887,887 on 2026-08-12 and explicitly approved by
 * the operator for the first o1 Routes release.
 *
 * Re-pinned at block 52,819,869 on 2026-10-19, at the operator's request,
 * after o1 upgraded the proxy to `TerminalSwapX` (deployed 2026-10-11). The pin
 * had refused every comparison since at least 2026-09-23. Proxy code and admin
 * are unchanged. The new implementation is an exact Sourcify match (solc
 * 0.8.28) and keeps every function of the reviewed one. It adds three: a
 * reverting quote helper, an owner-only share-vault registry, and an
 * admin-only reinitializer. `swap` still pays and is paid only by `msg.sender`,
 * the fee is inside `amountIn`, and `minReturn` is checked against the
 * caller's own balance change. An owner can raise `feeRate` or pause; neither
 * can deliver less than `minReturn`. The OKX leg calls an address from the
 * calldata, but only with OKX's own selectors, and approves only OKX's fixed
 * approval proxy.
 */
export const O1_BASE_ROUTER_PROXY_V1 = '0x7293d41c28e5fc2292e62d26fec60e22a145d1a5' as const;
export const O1_BASE_ROUTER_PROXY_CODE_HASH_V1 =
  '0xd06339b0d4fc20f56696572d97fb01fdb2f0db989deecdff9f4c88f5e7933a28' as const;
export const O1_BASE_ROUTER_IMPLEMENTATION_V1 =
  '0x59c7e94464e12a7c2429f8d87e52021107b9d217' as const;
export const O1_BASE_ROUTER_IMPLEMENTATION_CODE_HASH_V1 =
  '0x50edc8fda26478607e1d08a74e7d0a23e3bbee2da654198b49cdec4b249b6dc7' as const;
export const O1_BASE_ROUTER_ADMIN_V1 = '0x48162129286c08daa34004dd6862880ff3a9ff8e' as const;

export const EIP1967_IMPLEMENTATION_SLOT_V1 =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
export const EIP1967_ADMIN_SLOT_V1 =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103' as const;

export const O1_SWAP_SELECTOR_V1 = '0xe6cb474f' as const;
export const O1_MAX_HOPS_V1 = 8;

export const O1_SWAP_ABI_V1 = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'swaps',
        type: 'tuple[]',
        components: [
          { name: 'dexType', type: 'uint8' },
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'pool', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'exchange', type: 'address' },
          { name: 'extraData', type: 'bytes' },
        ],
      },
      // The verified source (2026-10-19) calls it `feeToken`: the input or
      // output token the fee is taken in. Never a recipient.
      { name: 'settlementToken', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

export interface O1RouterPinReaderV1 {
  verify(): Promise<
    | { ok: true; blockNumber: string }
    | { ok: false; reason: 'not_configured' | 'unavailable' | 'mismatch' }
  >;
}

type O1PinResultV1 = Awaited<ReturnType<O1RouterPinReaderV1['verify']>>;

/** Comparison-time passes, per endpoint. A refusal is never kept. */
const O1_PIN_CACHE_V1 = new Map<string, { until: number; value: O1PinResultV1 }>();

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
      const [proxyCode, implementationSlot, adminSlot, blockNumber] = await Promise.all([
        client.getBytecode({ address: O1_BASE_ROUTER_PROXY_V1 }),
        client.getStorageAt({
          address: O1_BASE_ROUTER_PROXY_V1,
          slot: EIP1967_IMPLEMENTATION_SLOT_V1,
        }),
        client.getStorageAt({
          address: O1_BASE_ROUTER_PROXY_V1,
          slot: EIP1967_ADMIN_SLOT_V1,
        }),
        client.getBlockNumber(),
      ]);
      if (!proxyCode || !implementationSlot || !adminSlot) {
        return { ok: false, reason: 'mismatch' };
      }
      const implementation = getAddress(
        `0x${implementationSlot.slice(-40)}` as Hex,
      ).toLowerCase();
      const admin = getAddress(`0x${adminSlot.slice(-40)}` as Hex).toLowerCase();
      if (
        keccak256(proxyCode) !== O1_BASE_ROUTER_PROXY_CODE_HASH_V1 ||
        implementation !== O1_BASE_ROUTER_IMPLEMENTATION_V1 ||
        admin !== O1_BASE_ROUTER_ADMIN_V1
      ) {
        return { ok: false, reason: 'mismatch' };
      }
      const implementationCode = await client.getBytecode({
        address: O1_BASE_ROUTER_IMPLEMENTATION_V1,
      });
      if (
        !implementationCode ||
        keccak256(implementationCode) !== O1_BASE_ROUTER_IMPLEMENTATION_CODE_HASH_V1
      ) {
        return { ok: false, reason: 'mismatch' };
      }
      return { ok: true, blockNumber: blockNumber.toString() };
    } catch {
      // Never bubble a viem error: its diagnostic text contains the RPC URL.
      return { ok: false, reason: 'unavailable' };
    }
  }
}
