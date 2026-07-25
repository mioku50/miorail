import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import {
  PINNED_BASE_USDC_V1,
  verifyPinnedEarnContractsV1,
  type EarnPinnedContractReaderV1,
  type PinnedEarnVerificationV1,
} from '@mioagent/earn-engine';

// ---------------------------------------------------------------------------
// T62.1 §1 — production earn contract preflight. A CONCRETE
// EarnPinnedContractReaderV1 over a Base-mainnet viem public client, plus a
// CACHED verification so the earn gate consults an in-memory result instead of
// hitting the RPC on every request. The RPC URL comes exclusively from the
// server env (never request data); this client is READ-ONLY — the server never
// signs or broadcasts through it. Fail closed: a wrong chain id, an unreachable
// RPC, missing bytecode, a non-USDC underlying, or missing ERC-4626 reads all
// resolve to a verification whose `ok` is false, and the gate then returns a
// stable 503 with NO partial execution.
// ---------------------------------------------------------------------------

/** Server-env-only Base mainnet RPC URL (never request data). Shared with the
 * T63A live earn data reader so both read the same configured endpoint. */
export function baseRpcUrlV1(env: NodeJS.ProcessEnv): string {
  return env.BASE_MAINNET_RPC_URL || env.BASE_RPC_URL || 'https://mainnet.base.org';
}

// Moonwell markets are Compound-v2 mTokens: `underlying()` returns the accepted
// ERC-20. Morpho vaults are ERC-4626: `asset()` returns the accepted ERC-20 and
// the deposit path relies on the standard 4626 view reads below.
const MOONWELL_UNDERLYING_ABI = [
  { name: 'underlying', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

const ERC4626_ABI = [
  { name: 'asset', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'totalAssets', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'convertToShares', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { name: 'maxDeposit', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'previewDeposit', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const;

const ONE_USDC = BigInt(1_000_000);
const PROBE_ACCOUNT: Address = '0x000000000000000000000000000000000000dEaD';

/** The minimal read surface the preflight needs. A viem PublicClient satisfies
 * it structurally; tests inject a fake so no live RPC is ever made. */
export interface EarnRpcClientV1 {
  getChainId(): Promise<number>;
  getBytecode(args: { address: Address }): Promise<`0x${string}` | undefined>;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

export function createViemEarnPinnedContractReader(client: EarnRpcClientV1): EarnPinnedContractReaderV1 {
  return {
    async getCodeSize(address) {
      const code = await client.getBytecode({ address: address as Address });
      return code && code.length > 2 ? (code.length - 2) / 2 : 0;
    },
    async getVenueUnderlyingAsset({ protocol, target }) {
      try {
        const result =
          protocol === 'moonwell'
            ? await client.readContract({ address: target as Address, abi: MOONWELL_UNDERLYING_ABI, functionName: 'underlying' })
            : await client.readContract({ address: target as Address, abi: ERC4626_ABI, functionName: 'asset' });
        return typeof result === 'string' ? (result.toLowerCase() as `0x${string}`) : null;
      } catch {
        return null;
      }
    },
    async supportsErc4626Reads(vault) {
      try {
        await client.readContract({ address: vault as Address, abi: ERC4626_ABI, functionName: 'asset' });
        await client.readContract({ address: vault as Address, abi: ERC4626_ABI, functionName: 'totalAssets' });
        await client.readContract({ address: vault as Address, abi: ERC4626_ABI, functionName: 'convertToShares', args: [ONE_USDC] });
        await client.readContract({ address: vault as Address, abi: ERC4626_ABI, functionName: 'maxDeposit', args: [PROBE_ACCOUNT] });
        await client.readContract({ address: vault as Address, abi: ERC4626_ABI, functionName: 'previewDeposit', args: [ONE_USDC] });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function failClosedVerificationV1(reason: string): PinnedEarnVerificationV1 {
  return { ok: false, usdc: { address: PINNED_BASE_USDC_V1, codePresent: false }, venues: [], failures: [reason] };
}

/** chain id 8453 gate + pinned-contract verification. The pinned addresses ARE
 * the config (PINNED_EARN_VENUES_V1) — verifying live bytecode + the accepted
 * asset AT those addresses is the "addresses match configuration" check. */
export async function runEarnContractPreflightV1(client: EarnRpcClientV1): Promise<PinnedEarnVerificationV1> {
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch {
    return failClosedVerificationV1('rpc_unreachable');
  }
  if (chainId !== 8453) return failClosedVerificationV1('wrong_chain_id');
  return verifyPinnedEarnContractsV1(createViemEarnPinnedContractReader(client));
}

// --- Cache -----------------------------------------------------------------

interface PreflightCacheEntry {
  at: number;
  verification: PinnedEarnVerificationV1;
}

let cache: PreflightCacheEntry | null = null;

/** Test hook only — clears the module cache between cases. */
export function resetEarnContractPreflightCacheV1(): void {
  cache = null;
}

export interface EarnPreflightDepsV1 {
  createClient?: () => EarnRpcClientV1;
  now?: () => number;
  ttlMs?: number;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_PREFLIGHT_TTL_MS = 5 * 60_000;

/**
 * Cached preflight. Runs the chain-id gate + pinned verification at most once
 * per TTL window; a failed verification is cached the same as a passing one so
 * the gate does not hammer a broken RPC. The gate calls this on demand (behind
 * the flag), and the startup warmer primes it once at boot.
 */
export async function resolveEarnContractPreflightV1(deps: EarnPreflightDepsV1 = {}): Promise<PinnedEarnVerificationV1> {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? DEFAULT_PREFLIGHT_TTL_MS;
  if (cache && now() - cache.at < ttlMs) return cache.verification;

  const env = deps.env ?? process.env;
  const client =
    deps.createClient?.() ??
    (createPublicClient({ chain: base, transport: http(baseRpcUrlV1(env)) }) as unknown as EarnRpcClientV1);
  const verification = await runEarnContractPreflightV1(client);
  cache = { at: now(), verification };
  return verification;
}
