import { createPublicClient, getAddress, http, keccak256, type Hex } from 'viem';
import { base } from 'viem/chains';

/**
 * Hydrex swap boundary observed at Base block 49,890,160 on 2026-08-12.
 * The outer address is an ERC-1967 proxy, so address-only pinning is not
 * sufficient. The two upstream paths below are the only live paths Miorail
 * accepts from the public prepare server.
 */
export const HYDREX_BASE_ROUTER_PROXY_V1 = '0x599bfa1039c9e22603f15642b711d56be62071f4' as const;
export const HYDREX_BASE_ROUTER_PROXY_CODE_HASH_V1 =
  '0x0fd29b47a89ab717d1653f7e091ec20c409ccee39c8cfbce5b61580ab5798fbc' as const;
export const HYDREX_BASE_ROUTER_IMPLEMENTATION_V1 =
  '0x2e5e3d3fbfb77df85b3535fbefa09d61a8320aac' as const;
export const HYDREX_BASE_ROUTER_IMPLEMENTATION_CODE_HASH_V1 =
  '0x48f4283f2f63da1ea0910b5a950150e2f457c7d0bdc51a7a5256ef8f255c0a81' as const;
export const HYDREX_BASE_ROUTER_ADMIN_V1 = '0x7f006592a2b11ad69f4ced3770da25b573cb6015' as const;

export const HYDREX_ZEROX_ALLOWANCE_HOLDER_V1 =
  '0x0000000000001ff3684f28c67538d4d072c22734' as const;
export const HYDREX_ZEROX_ALLOWANCE_HOLDER_CODE_HASH_V1 =
  '0x99f5e8edaceacfdd183eb5f1da8a7757b322495b80cf7928db289a1b1a09f799' as const;
export const HYDREX_KYBER_META_ROUTER_V1 =
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5' as const;
export const HYDREX_KYBER_META_ROUTER_CODE_HASH_V1 =
  '0x99590941aab8e1eaf2ceb825abf64b6956e82ce41e8966d7e320846905db85e3' as const;
export const HYDREX_ZEROX_INNER_SELECTOR_V1 = '0x2213bc0b' as const;
export const HYDREX_KYBER_INNER_SELECTOR_V1 = '0xe21fd0e9' as const;

export const HYDREX_MAX_ACCEPTABLE_FEE_BPS_V1 = 50n;
export const HYDREX_EXECUTE_SWAPS_SELECTOR_V1 = '0x68128618' as const;
export const EIP1967_IMPLEMENTATION_SLOT_HYDREX_V1 =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
export const EIP1967_ADMIN_SLOT_HYDREX_V1 =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103' as const;

export const HYDREX_EXECUTE_SWAPS_ABI_V1 = [
  {
    type: 'function',
    name: 'executeSwaps',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'swaps',
        type: 'tuple[]',
        components: [
          { name: 'router', type: 'address' },
          { name: 'inputAsset', type: 'address' },
          { name: 'outputAsset', type: 'address' },
          { name: 'inputAmount', type: 'uint256' },
          { name: 'minOutputAmount', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'origin', type: 'string' },
          { name: 'referral', type: 'address' },
          { name: 'referralFeeBps', type: 'uint256' },
        ],
      },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const HYDREX_READ_ABI_V1 = [
  {
    type: 'function',
    name: 'whitelistedRouters',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'feeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export type HydrexPinnedSourceV1 = 'ZEROX' | 'KYBERSWAP';

export function hydrexSourceForRouterV1(address: string): HydrexPinnedSourceV1 | null {
  const normalized = address.toLowerCase();
  if (normalized === HYDREX_ZEROX_ALLOWANCE_HOLDER_V1) return 'ZEROX';
  if (normalized === HYDREX_KYBER_META_ROUTER_V1) return 'KYBERSWAP';
  return null;
}

export function hydrexInnerSelectorForSourceV1(source: HydrexPinnedSourceV1): string {
  return source === 'ZEROX' ? HYDREX_ZEROX_INNER_SELECTOR_V1 : HYDREX_KYBER_INNER_SELECTOR_V1;
}

function expectedUpstreamHash(address: string): Hex | null {
  const normalized = address.toLowerCase();
  if (normalized === HYDREX_ZEROX_ALLOWANCE_HOLDER_V1) {
    return HYDREX_ZEROX_ALLOWANCE_HOLDER_CODE_HASH_V1;
  }
  if (normalized === HYDREX_KYBER_META_ROUTER_V1) {
    return HYDREX_KYBER_META_ROUTER_CODE_HASH_V1;
  }
  return null;
}

export type HydrexPinResultV1 =
  | { ok: true; blockNumber: string; feeBps: string }
  | { ok: false; reason: 'not_configured' | 'unavailable' | 'mismatch' };

export interface HydrexRouterPinReaderV1 {
  verify(): Promise<HydrexPinResultV1>;
  verifyUpstream(router: string): Promise<HydrexPinResultV1>;
  verifyAll(): Promise<HydrexPinResultV1>;
}

export function createHydrexRouterPinReaderV1(input: { rpcUrl: string }): HydrexRouterPinReaderV1 {
  const rpcUrl = input.rpcUrl.trim();

  async function verifyOuter(): Promise<HydrexPinResultV1> {
    if (!rpcUrl) return { ok: false, reason: 'not_configured' };
    try {
      const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const [proxyCode, implementationSlot, adminSlot, feeBps, blockNumber] = await Promise.all([
        client.getBytecode({ address: HYDREX_BASE_ROUTER_PROXY_V1 }),
        client.getStorageAt({ address: HYDREX_BASE_ROUTER_PROXY_V1, slot: EIP1967_IMPLEMENTATION_SLOT_HYDREX_V1 }),
        client.getStorageAt({ address: HYDREX_BASE_ROUTER_PROXY_V1, slot: EIP1967_ADMIN_SLOT_HYDREX_V1 }),
        client.readContract({ address: HYDREX_BASE_ROUTER_PROXY_V1, abi: HYDREX_READ_ABI_V1, functionName: 'feeBps' }),
        client.getBlockNumber(),
      ]);
      if (!proxyCode || !implementationSlot || !adminSlot) return { ok: false, reason: 'mismatch' };
      const implementation = getAddress(`0x${implementationSlot.slice(-40)}` as Hex).toLowerCase();
      const admin = getAddress(`0x${adminSlot.slice(-40)}` as Hex).toLowerCase();
      if (
        keccak256(proxyCode) !== HYDREX_BASE_ROUTER_PROXY_CODE_HASH_V1 ||
        implementation !== HYDREX_BASE_ROUTER_IMPLEMENTATION_V1 ||
        admin !== HYDREX_BASE_ROUTER_ADMIN_V1 ||
        feeBps > HYDREX_MAX_ACCEPTABLE_FEE_BPS_V1
      ) return { ok: false, reason: 'mismatch' };
      const implementationCode = await client.getBytecode({ address: HYDREX_BASE_ROUTER_IMPLEMENTATION_V1 });
      if (!implementationCode || keccak256(implementationCode) !== HYDREX_BASE_ROUTER_IMPLEMENTATION_CODE_HASH_V1) {
        return { ok: false, reason: 'mismatch' };
      }
      return { ok: true, blockNumber: blockNumber.toString(), feeBps: feeBps.toString() };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async function verifyUpstream(router: string): Promise<HydrexPinResultV1> {
    const outer = await verifyOuter();
    if (!outer.ok) return outer;
    const hash = expectedUpstreamHash(router);
    if (!hash) return { ok: false, reason: 'mismatch' };
    try {
      const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const normalized = getAddress(router) as `0x${string}`;
      const [code, whitelisted, blockNumber] = await Promise.all([
        client.getBytecode({ address: normalized }),
        client.readContract({
          address: HYDREX_BASE_ROUTER_PROXY_V1,
          abi: HYDREX_READ_ABI_V1,
          functionName: 'whitelistedRouters',
          args: [normalized],
        }),
        client.getBlockNumber(),
      ]);
      if (!code || keccak256(code) !== hash || !whitelisted) return { ok: false, reason: 'mismatch' };
      return { ...outer, blockNumber: blockNumber.toString() };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  return {
    verify: verifyOuter,
    verifyUpstream,
    async verifyAll() {
      for (const router of [HYDREX_ZEROX_ALLOWANCE_HOLDER_V1, HYDREX_KYBER_META_ROUTER_V1]) {
        const result = await verifyUpstream(router);
        if (!result.ok) return result;
      }
      return verifyOuter();
    },
  };
}
