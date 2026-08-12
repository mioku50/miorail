import { createPublicClient, getAddress, http, keccak256, type Hex } from 'viem';
import { base } from 'viem/chains';

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
 */
export const O1_BASE_ROUTER_PROXY_V1 = '0x7293d41c28e5fc2292e62d26fec60e22a145d1a5' as const;
export const O1_BASE_ROUTER_PROXY_CODE_HASH_V1 =
  '0xd06339b0d4fc20f56696572d97fb01fdb2f0db989deecdff9f4c88f5e7933a28' as const;
export const O1_BASE_ROUTER_IMPLEMENTATION_V1 =
  '0x92c27c975701404fd16fff98d85c348ef6573703' as const;
export const O1_BASE_ROUTER_IMPLEMENTATION_CODE_HASH_V1 =
  '0xdc88fb54d9db6ad8deda9ed12202f50231d40a4e8c6ce7cd2a8d1b46732bc954' as const;
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
      // The public skill names only the signature, not this argument's
      // semantics. It is decoded and hashed but never treated as a recipient.
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

export function createO1RouterPinReaderV1(input: { rpcUrl: string }): O1RouterPinReaderV1 {
  const rpcUrl = input.rpcUrl.trim();
  return {
    async verify() {
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
    },
  };
}
