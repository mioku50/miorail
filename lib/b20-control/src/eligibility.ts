import {
  B20_POLICY_REGISTRY_V1,
  B20_SELECTORS_V1,
  decodeBoolV1,
  decodeUintV1,
  encodeNoArgsV1,
  encodeWordArgV1,
  policyTypeFromIdV1,
  type B20PolicyTypeV1,
} from './pinned.js';
import { callManyV1, type B20ReaderV1 } from './reader.js';

// ---------------------------------------------------------------------------
// Can THIS wallet move THIS token — the third axis.
//
// Stocks already answers two questions about a representation: is there a route
// under the reviewed policy, and does the money come back if you take it. Both
// are about the market. Neither is about the holder, and for a regulated asset
// that is the gap where a surprise lives: a B20 carries transfer policies, and a
// policy can deny one address while the market is perfectly healthy.
//
// Every reviewed Coinbase representation measured on 2026-08-31 carries a live
// policy — NVDAc returns policy id 5 on all four scopes, type byte 0x00, a
// BLOCKLIST — so this is not a hypothetical surface. It is simply one nobody
// had asked.
//
// WHY THIS CAN BE ANSWERED AT ALL
//
// `IPolicyRegistry.isAuthorized` is documented never to revert for any
// combination of policy id and account, and it held across every case tried:
// ALWAYS_ALLOW authorizes everyone, ALWAYS_BLOCK denies everyone, an absent
// blocklist authorizes, an absent allowlist denies. That guarantee is what makes
// a verdict here safe to render — the read either answers or the transport
// failed, with no third outcome to misread.
//
// TWO RULES THIS FILE DOES NOT BEND
//
//   1. A failed read is `not_established`, never `denied`. Telling a holder
//      their address is blocked because our RPC was throttled would be the
//      worst false positive this product could produce.
//
//   2. SENDING and RECEIVING are separate facts and are never merged into one
//      "can trade" bit. They are separate policy scopes on the token, they can
//      disagree, and a single collapsed verdict would hide which one applies.
//
// And what it is NOT: this says nothing about whether a route exists or whether
// the round trip survives. A wallet can be perfectly authorized to hold
// something it cannot sell.
// ---------------------------------------------------------------------------

/** The transfer scopes a holder is affected by. `executor` is deliberately
 * absent: it is checked only on `transferFrom`, so it describes a spender
 * rather than the holder this answer is about. */
export const B20_ELIGIBILITY_SCOPES_V1 = ['transfer_sender', 'transfer_receiver'] as const;
export type B20EligibilityScopeV1 = (typeof B20_ELIGIBILITY_SCOPES_V1)[number];

/**
 * What the registry said about one scope.
 *
 * `not_established` covers every way an answer failed to arrive, and is the
 * only value that may be produced without a completed read.
 */
export type B20EligibilityVerdictV1 = 'authorized' | 'denied' | 'not_established';

export interface B20ScopeEligibilityV1 {
  scope: B20EligibilityScopeV1;
  verdict: B20EligibilityVerdictV1;
  /** The policy the token points this scope at, as decimal. Null when the
   * token did not answer — a token with no policy slot is a real state. */
  policyId: string | null;
  policyType: B20PolicyTypeV1 | null;
  /** Why, when the verdict is `not_established`. Never a provider or endpoint
   * detail: an RPC URL must not reach evidence. */
  reason: string | null;
}

export interface B20TransferEligibilityV1 {
  tokenAddress: string;
  wallet: string;
  /** The single block every verdict here was read at. Two verdicts from two
   * blocks are two facts, and this surface states one. */
  blockTag: string;
  blockNumber: string | null;
  scopes: B20ScopeEligibilityV1[];
}

const SCOPE_SELECTOR_V1: Readonly<Record<B20EligibilityScopeV1, string>> = {
  transfer_sender: B20_SELECTORS_V1.transferSenderPolicy,
  transfer_receiver: B20_SELECTORS_V1.transferReceiverPolicy,
};

function encodeIsAuthorizedV1(policyId: bigint, wallet: string): string {
  const id = policyId.toString(16).padStart(64, '0');
  const account = wallet.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return `0x${B20_SELECTORS_V1.isAuthorized}${id}${account}`;
}

function unresolvedV1(scope: B20EligibilityScopeV1, reason: string): B20ScopeEligibilityV1 {
  return { scope, verdict: 'not_established', policyId: null, policyType: null, reason };
}

/**
 * Whether one wallet may send and may receive one exact B20.
 *
 * Three round trips at one block: the scope keys off the token, the policy id
 * each scope points at, then the registry's verdict for the wallet. The scope
 * keys are READ rather than hardcoded for the same reason the inspector reads
 * them — they are view functions, and a guessed constant queries the wrong
 * scope while looking entirely correct.
 */
export async function readB20TransferEligibilityV1(input: {
  reader: B20ReaderV1;
  tokenAddress: string;
  wallet: string;
  blockTag: string;
  blockNumber?: string | null;
}): Promise<B20TransferEligibilityV1> {
  const base = {
    tokenAddress: input.tokenAddress.toLowerCase(),
    wallet: input.wallet.toLowerCase(),
    blockTag: input.blockTag,
    blockNumber: input.blockNumber ?? null,
  };
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.wallet)) {
    return {
      ...base,
      scopes: B20_ELIGIBILITY_SCOPES_V1.map((scope) =>
        unresolvedV1(scope, 'No wallet address was supplied to check.'),
      ),
    };
  }

  const scopeReads = await callManyV1(
    input.reader,
    B20_ELIGIBILITY_SCOPES_V1.map((scope) => ({
      to: input.tokenAddress,
      data: encodeNoArgsV1(SCOPE_SELECTOR_V1[scope]),
      blockTag: input.blockTag,
    })),
  );

  const policyReads = await callManyV1(
    input.reader,
    B20_ELIGIBILITY_SCOPES_V1.map((_scope, index) => {
      const read = scopeReads[index];
      // A token that will not name its scope cannot be asked for its policy.
      // The call still has to occupy this slot so the arrays stay aligned.
      const key = read?.ok ? read.value : `0x${'0'.repeat(64)}`;
      return {
        to: input.tokenAddress,
        data: encodeWordArgV1(B20_SELECTORS_V1.policyId, key),
        blockTag: input.blockTag,
      };
    }),
  );

  const resolved: { scope: B20EligibilityScopeV1; policyId: bigint }[] = [];
  const scopes: B20ScopeEligibilityV1[] = B20_ELIGIBILITY_SCOPES_V1.map((scope, index) => {
    const scopeRead = scopeReads[index];
    if (!scopeRead?.ok) {
      return unresolvedV1(scope, 'This token did not name that transfer policy scope.');
    }
    const policyRead = policyReads[index];
    if (!policyRead?.ok) {
      return unresolvedV1(scope, 'The token did not answer which policy governs that scope.');
    }
    const policyId = decodeUintV1(policyRead.value);
    if (policyId === null) {
      return unresolvedV1(scope, 'The policy identifier could not be read.');
    }
    resolved.push({ scope, policyId });
    return {
      scope,
      verdict: 'not_established' as const,
      policyId: policyId.toString(),
      policyType: policyTypeFromIdV1(policyId),
      reason: null,
    };
  });

  if (resolved.length === 0) return { ...base, scopes };

  const verdicts = await callManyV1(
    input.reader,
    resolved.map((entry) => ({
      to: B20_POLICY_REGISTRY_V1,
      data: encodeIsAuthorizedV1(entry.policyId, input.wallet),
      blockTag: input.blockTag,
    })),
  );

  for (const [index, entry] of resolved.entries()) {
    const target = scopes.find((row) => row.scope === entry.scope);
    if (!target) continue;
    const read = verdicts[index];
    if (!read?.ok) {
      // The registry is documented never to revert, so reaching here means the
      // transport failed. That is OURS, and it is never a denial.
      target.reason = 'The policy registry did not answer, so nothing was established.';
      continue;
    }
    const authorized = decodeBoolV1(read.value);
    if (authorized === null) {
      target.reason = 'The policy registry answered in a shape this build cannot read.';
      continue;
    }
    target.verdict = authorized ? 'authorized' : 'denied';
    target.reason = null;
  }

  return { ...base, scopes };
}

/**
 * The one sentence a holder gets, or null when there is nothing to say.
 *
 * Null rather than a reassuring default: a surface with no verdict must render
 * nothing, because "no restriction found" and "we did not look" are the two
 * states this product exists to keep apart.
 */
export function b20TransferEligibilityNoticeV1(
  eligibility: B20TransferEligibilityV1,
): { verdict: 'authorized' | 'denied' | 'not_established'; sentence: string } | null {
  const denied = eligibility.scopes.filter((scope) => scope.verdict === 'denied');
  if (denied.length > 0) {
    const sending = denied.some((scope) => scope.scope === 'transfer_sender');
    const receiving = denied.some((scope) => scope.scope === 'transfer_receiver');
    const what =
      sending && receiving
        ? 'send or receive'
        : sending
          ? 'send'
          : 'receive';
    return {
      verdict: 'denied',
      sentence: `This token's transfer policy does not currently authorize this wallet to ${what} it. That is the issuer's policy for this contract, read on chain — it says nothing about the market or about any other asset you hold.`,
    };
  }
  const authorized = eligibility.scopes.filter((scope) => scope.verdict === 'authorized');
  if (authorized.length === eligibility.scopes.length && authorized.length > 0) {
    return {
      verdict: 'authorized',
      sentence: `This token's transfer policy authorizes this wallet to send and receive it, as read on chain. A policy can change, and this says nothing about whether a route exists or what it costs.`,
    };
  }
  const reason = eligibility.scopes.find((scope) => scope.reason)?.reason ?? null;
  if (!reason) return null;
  return {
    verdict: 'not_established',
    sentence: `${reason} Nothing about this wallet's permission to move this token was established, which is not the same as being blocked.`,
  };
}
