import { createPublicClient, getAddress, http, type Address } from 'viem';
import { base, mainnet } from 'viem/chains';
import { normalize, toCoinType } from 'viem/ens';

export type BaseNameResolutionV1 =
  | { outcome: 'resolved'; name: string; address: Address }
  | { outcome: 'invalid' | 'unresolved' | 'not_configured' | 'unavailable'; name: string; errorCode: string };

export function ethereumMainnetRpcUrlV1(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = (env.ETHEREUM_MAINNET_RPC_URL || '').trim();
  if (explicit) return explicit;

  // Miorail already carries private Base RPCs in production. These providers'
  // project keys are network-agnostic, so derive the matching Ethereum L1 URL
  // only for exact reviewed hosts. Never rewrite an arbitrary provider URL.
  const candidates = [
    env.BASE_MAINNET_RPC_URL,
    env.BASE_RPC_URL,
    env.ALCHEMY_BASE_MAINNET_RPC_URL,
  ];
  for (const candidate of candidates) {
    try {
      const url = new URL((candidate || '').trim());
      if (url.protocol !== 'https:') continue;
      if (url.hostname === 'base-mainnet.g.alchemy.com') {
        url.hostname = 'eth-mainnet.g.alchemy.com';
        return url.toString();
      }
      if (url.hostname === 'base-mainnet.infura.io') {
        url.hostname = 'mainnet.infura.io';
        return url.toString();
      }
    } catch {
      // Try the next configured Base RPC.
    }
  }
  return null;
}

export const baseNameResolverRuntimeV1 = {
  rpcUrl: () => ethereumMainnetRpcUrlV1(),
  lookup: async (rpcUrl: string, name: string): Promise<Address | null> => {
    const client = createPublicClient({
      chain: mainnet,
      transport: http(rpcUrl, { retryCount: 1, timeout: 6_000 }),
    });
    return client.getEnsAddress({
      name,
      coinType: toCoinType(base.id),
      strict: true,
    });
  },
};

/** Resolve a Basename through ENSIP-19 for Base (coin type 2147492101).
 * The returned address is the only value allowed to enter the Send action. */
export async function resolveBaseNameV1(value: string): Promise<BaseNameResolutionV1> {
  let name: string;
  try {
    name = normalize(value.trim());
  } catch {
    return { outcome: 'invalid', name: value.trim(), errorCode: 'base_name_invalid' };
  }
  if (name.length > 255 || !name.endsWith('.base.eth')) {
    return { outcome: 'invalid', name, errorCode: 'base_name_invalid' };
  }

  const rpcUrl = baseNameResolverRuntimeV1.rpcUrl();
  if (!rpcUrl) {
    return { outcome: 'not_configured', name, errorCode: 'base_name_resolver_not_configured' };
  }
  try {
    const address = await baseNameResolverRuntimeV1.lookup(rpcUrl, name);
    if (!address) return { outcome: 'unresolved', name, errorCode: 'base_name_unresolved' };
    return { outcome: 'resolved', name, address: getAddress(address) };
  } catch {
    return { outcome: 'unavailable', name, errorCode: 'base_name_resolver_unavailable' };
  }
}
