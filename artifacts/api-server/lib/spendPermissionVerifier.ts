import { getPermissionStatus } from '@base-org/account/spend-permission/node';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';
import type { SpendPermissionClaimV1, OnchainPermissionStatusV1 } from '@mioagent/intelligence-budget';
import { getSubscriptionOwnerWallet, rpcUrlForNetwork } from '../routes/x402/index.js';

// ---------------------------------------------------------------------------
// T71 §4 — the bridge between a claim in a POST body and the chain.
//
// `lib/intelligence-budget` decides whether a permission is acceptable, and it
// deliberately cannot reach a network to find out what the permission actually
// is. This module is the only place that asks, and it asks two questions:
//
//   getHash          — what IS this permission's identity, derived from its own
//                      fields rather than from whatever the client named?
//   getPermissionStatus — has the chain approved it, is it live, and how much
//                      is left in the current period?
//
// The spender is resolved from `getSubscriptionOwnerWallet()`, which is the
// SAME address the charger later draws with. Resolving it any other way would
// let a permission verify here and be unusable at charge time — the user would
// have signed something, been told it worked, and found out a month later.
//
// The RPC URL is read here and never returned, logged or attached to an error.
// ---------------------------------------------------------------------------

export interface SpendPermissionVerifierV1 {
  /** The canonical spender, from the same source the charger uses. */
  spenderAddress(): Promise<string>;
  /** The permission's identity, derived from its own fields. */
  derivedHash(claim: SpendPermissionClaimV1): Promise<string>;
  /** What the chain says. */
  status(claim: SpendPermissionClaimV1): Promise<OnchainPermissionStatusV1>;
}

/** The chain could not be asked. Distinct from "the chain said no": one is
 * worth retrying and the other never is, and collapsing them would tell a user
 * their wallet did something it did not. */
export class PermissionStatusUnavailableError extends Error {
  readonly code = 'permission_status_unavailable';
  constructor() {
    // No cause, no URL, no provider name: this message reaches a client.
    super('The permission status could not be read from Base.');
    this.name = 'PermissionStatusUnavailableError';
  }
}

/** SpendPermissionManager on Base mainnet. Pinned rather than discovered: the
 * address this hash is computed by is part of what the check means. */
const SPEND_PERMISSION_MANAGER_V1 = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad' as const;

/** Only `getHash` — the narrowest ABI that answers the question. */
const SPEND_PERMISSION_MANAGER_GET_HASH_ABI_V1 = [
  {
    type: 'function',
    name: 'getHash',
    stateMutability: 'view',
    inputs: [
      {
        name: 'spendPermission',
        type: 'tuple',
        components: [
          { name: 'account', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'allowance', type: 'uint160' },
          { name: 'period', type: 'uint48' },
          { name: 'start', type: 'uint48' },
          { name: 'end', type: 'uint48' },
          { name: 'salt', type: 'uint256' },
          { name: 'extraData', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const;

/** The SDK's own permission shape. Built from the claim rather than passed
 * through, so a field the client added cannot ride along into the SDK. */
function sdkPermission(claim: SpendPermissionClaimV1) {
  return {
    signature: claim.signature as `0x${string}`,
    chainId: claim.chainId,
    permissionHash: claim.permissionHash as `0x${string}`,
    permission: {
      account: claim.permission.account,
      spender: claim.permission.spender,
      token: claim.permission.token,
      allowance: claim.permission.allowance,
      period: claim.permission.period,
      start: claim.permission.start,
      end: claim.permission.end,
      salt: claim.permission.salt,
      extraData: claim.permission.extraData,
    },
  };
}

export function createSpendPermissionVerifierV1(
  env: NodeJS.ProcessEnv = process.env,
): SpendPermissionVerifierV1 {
  return {
    async spenderAddress(): Promise<string> {
      const wallet = await getSubscriptionOwnerWallet(env);
      return wallet.address;
    },

    async derivedHash(claim: SpendPermissionClaimV1): Promise<string> {
      // The SDK's own `getHash` is a read of SpendPermissionManager.getHash()
      // and is exported only from the browser entry point, which drags in
      // provider and store code this process must not load. So the same
      // contract call is made directly — the CONTRACT computes the canonical
      // hash either way, which is what makes it worth checking at all.
      const rpcUrl = rpcUrlForNetwork(`eip155:${claim.chainId}`, env);
      if (!rpcUrl) throw new PermissionStatusUnavailableError();
      try {
        const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
        return await client.readContract({
          address: SPEND_PERMISSION_MANAGER_V1,
          abi: SPEND_PERMISSION_MANAGER_GET_HASH_ABI_V1,
          functionName: 'getHash',
          args: [
            {
              account: claim.permission.account as `0x${string}`,
              spender: claim.permission.spender as `0x${string}`,
              token: claim.permission.token as `0x${string}`,
              allowance: BigInt(claim.permission.allowance),
              period: claim.permission.period,
              start: claim.permission.start,
              end: claim.permission.end,
              salt: BigInt(claim.permission.salt),
              extraData: claim.permission.extraData as `0x${string}`,
            },
          ],
        });
      } catch {
        // Never the cause: an RPC error carries the endpoint, and the endpoint
        // carries the key. Unreadable is not "does not match" — the caller
        // must not turn a network problem into an accusation about a wallet.
        throw new PermissionStatusUnavailableError();
      }
    },

    async status(claim: SpendPermissionClaimV1): Promise<OnchainPermissionStatusV1> {
      const rpcUrl = rpcUrlForNetwork(`eip155:${claim.chainId}`, env);
      if (!rpcUrl) throw new PermissionStatusUnavailableError();
      try {
        const result = await getPermissionStatus(sdkPermission(claim) as never, { rpcUrl });
        return {
          isActive: result.isActive === true,
          isApprovedOnchain: result.isApprovedOnchain === true,
          isRevoked: result.isRevoked === true,
          isExpired: result.isExpired === true,
          remainingSpendAtomic: (result.remainingSpend ?? BigInt(0)).toString(),
        };
      } catch {
        // Deliberately swallowing the cause: an RPC error carries the endpoint,
        // and the endpoint carries the key.
        throw new PermissionStatusUnavailableError();
      }
    },
  };
}

/** Canonical USDC on Base mainnet — the only asset paid evidence is charged
 * in, resolved from the shared guard rather than restated here. */
export function paidEvidenceTokenV1(): string {
  return canonicalUsdcForBaseChain(8453);
}

/** A monthly budget needs a permission that renews no faster than monthly.
 * 28 days rather than 30: month lengths vary and a wallet may round. */
export const PAID_EVIDENCE_MIN_PERIOD_SECONDS_V1 = 28 * 24 * 60 * 60;
