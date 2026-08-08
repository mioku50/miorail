import { getPermissionStatus } from '@base-org/account/spend-permission/node';
import { BaseError, ContractFunctionRevertedError, createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';
import type { SpendPermissionClaimV1, OnchainPermissionStatusV1 } from '@mioagent/intelligence-budget';
import { getSubscriptionOwnerWallet, rpcUrlForNetwork } from './subscriptionOwner.js';

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

const SPEND_PERMISSION_TUPLE_V1 = {
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
} as const;

/** The narrowest ABI that answers the two questions this module asks. */
const SPEND_PERMISSION_MANAGER_ABI_V1 = [
  {
    type: 'function',
    name: 'getHash',
    stateMutability: 'view',
    inputs: [SPEND_PERMISSION_TUPLE_V1],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'approveWithSignature',
    stateMutability: 'nonpayable',
    inputs: [SPEND_PERMISSION_TUPLE_V1, { name: 'signature', type: 'bytes' }],
    outputs: [],
  },
] as const;

/** The permission as the contract's own ABI wants it. One place, so `getHash`
 * and the signature check can never disagree about what was asked. */
function contractArgs(claim: SpendPermissionClaimV1) {
  return {
    account: claim.permission.account as `0x${string}`,
    spender: claim.permission.spender as `0x${string}`,
    token: claim.permission.token as `0x${string}`,
    allowance: BigInt(claim.permission.allowance),
    period: claim.permission.period,
    start: claim.permission.start,
    end: claim.permission.end,
    salt: BigInt(claim.permission.salt),
    extraData: claim.permission.extraData as `0x${string}`,
  } as const;
}

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

/**
 * T71-LIVE-2 §3 — does the contract accept this signature?
 *
 * `isApprovedOnchain` cannot answer that. It reads storage, and storage is
 * written by `approveWithSignature`, which nobody has sent yet — the wallet
 * signs and stops, and the Base Account SDK bundles the approve into the first
 * spend. So the old gate was waiting for a transaction that only the blocked
 * charge would ever have made.
 *
 * This asks the real question by SIMULATING that exact call. It is `eth_call`:
 * no transaction, no gas, no broadcast, no state change — the server's
 * never-signs boundary is untouched. What comes back is the contract's own
 * verdict on the account's signature over these exact fields, including the
 * ERC-6492 path that a Base Account which has not been deployed yet needs.
 *
 * A revert is an answer and is returned as `false`. Anything else is the
 * network failing to answer, which must never be reported to a user as their
 * wallet having done something wrong.
 */
async function signatureAcceptedV1(claim: SpendPermissionClaimV1, rpcUrl: string): Promise<boolean> {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  try {
    await client.simulateContract({
      address: SPEND_PERMISSION_MANAGER_V1,
      abi: SPEND_PERMISSION_MANAGER_ABI_V1,
      functionName: 'approveWithSignature',
      // No `account`: approveWithSignature is permissionless by design — the
      // authority is the signature, not the sender — and passing the spender
      // would imply otherwise.
      args: [contractArgs(claim), claim.signature as `0x${string}`],
    });
    return true;
  } catch (error) {
    if (error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError)) {
      return false;
    }
    // Never the cause: an RPC error carries the endpoint, and the endpoint
    // carries the key.
    throw new PermissionStatusUnavailableError();
  }
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
          abi: SPEND_PERMISSION_MANAGER_ABI_V1,
          functionName: 'getHash',
          args: [contractArgs(claim)],
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
        const isApprovedOnchain = result.isApprovedOnchain === true;
        return {
          isActive: result.isActive === true,
          isApprovedOnchain,
          // Already in storage is the stronger fact, and asking again would
          // depend on `approveWithSignature` being idempotent — which is not a
          // guarantee worth relying on when the answer is already known.
          signatureAcceptedOnchain: isApprovedOnchain
            ? true
            : await signatureAcceptedV1(claim, rpcUrl),
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
