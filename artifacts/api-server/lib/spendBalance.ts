import type { AssetRefV1 } from '@mioagent/route-domain';
import { BASE_PUBLIC_RPC_URL_V1 } from './baseRpcSwapSimulation.js';

// ---------------------------------------------------------------------------
// What the wallet holds of the one asset a swap spends.
//
// 2026-09-25, Base App: a 0.1 USDC buy of NVDAc from a wallet that held 0
// USDC. The simulation reverted with Uniswap's `TRANSFER_FROM_FAILED`, which
// is Permit2's word for a transferFrom that failed, and the screen told the
// person to "change the route or the amount". No route could have worked,
// because the wallet was empty. Hydrex, on the same empty wallet, reverts with
// USDC's own "transfer amount exceeds balance", which the text check already
// caught. A router names its own failure, not the cause, so the cause is read
// from the chain: one `balanceOf` (or `eth_getBalance` for ETH), and only
// after a revert.
//
// A read that does not come back is `null`, never a zero balance. The revert
// then stays a revert, because we could not show that the wallet was short.
// ---------------------------------------------------------------------------

export type SpendBalanceReaderV1 = (input: {
  asset: AssetRefV1;
  walletAddress: `0x${string}`;
}) => Promise<bigint | null>;

const ADDRESS_V1 = /^0x[0-9a-fA-F]{40}$/u;
const QUANTITY_V1 = /^0x[0-9a-fA-F]{1,64}$/u;
const DEFAULT_TIMEOUT_MS_V1 = 5_000;

export function createSpendBalanceReaderV1(options: {
  rpcUrl: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}): SpendBalanceReaderV1 | null {
  const rawUrl = options.rpcUrl?.trim();
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS_V1;

  return async ({ asset, walletAddress }) => {
    if (!ADDRESS_V1.test(walletAddress)) return null;
    const wallet = walletAddress.toLowerCase();
    let call: { method: string; params: unknown[] };
    if (asset.kind === 'native') {
      call = { method: 'eth_getBalance', params: [wallet, 'latest'] };
    } else if (asset.address && ADDRESS_V1.test(asset.address)) {
      // balanceOf(address)
      const data = `0x70a08231${wallet.slice(2).padStart(64, '0')}`;
      call = { method: 'eth_call', params: [{ to: asset.address.toLowerCase(), data }, 'latest'] };
    } else {
      return null;
    }
    try {
      const response = await fetchImpl(parsed.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...call }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { result?: unknown };
      const result = payload?.result;
      if (typeof result !== 'string' || !QUANTITY_V1.test(result)) return null;
      return BigInt(result);
    } catch {
      return null;
    }
  };
}

/** The read path's own RPC, then Base's public endpoint. A balance is an
 * ordinary read, so nothing here needs the simulation endpoint. */
export function createSpendBalanceReaderFromEnvV1(env: NodeJS.ProcessEnv = process.env): SpendBalanceReaderV1 | null {
  return createSpendBalanceReaderV1({
    rpcUrl: env.BASE_MAINNET_RPC_URL || env.BASE_RPC_URL || BASE_PUBLIC_RPC_URL_V1,
  });
}
