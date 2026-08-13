import { decodeFunctionData, erc20Abi } from 'viem';
import {
  SafetyKernelResultV1Schema,
  type EarnCandidateV1,
  type EarnRouteIntentV1,
  type ExecutionCallV1,
  type HashV1,
  type SafetyKernelCheckV1,
  type SafetyKernelResultV1,
} from '@mioagent/route-domain';
import { isCanonicalBaseUsdcV1, isPinnedEarnTargetV1, pinnedEarnVenueV1 } from '@mioagent/earn-engine';
import { MOONWELL_MINT_ABI, MORPHO_DEPOSIT_ABI, YO_GATEWAY_DEPOSIT_ABI } from './earnComposition.js';

// ---------------------------------------------------------------------------
// T61 §7 — the earn deposit Safety Kernel. Runs over ALREADY server-built,
// unsigned calls and re-DECODES their calldata (never trusts the classified
// ExecutionCallV1 label fields) to prove every guarantee the user was shown:
//   • Base mainnet + canonical USDC + pinned deposit target/approval spender
//   • an EXACT approval (== intent amount, never unlimited) to the pinned target
//   • an EXACT deposit of that same amount into the pinned market/vault
//   • receiver == the authenticated wallet (Morpho arg; Moonwell = msg.sender)
//   • no arbitrary calldata (both calls must decode to the exact pinned function)
//   • unexpired quote/evidence + present intent/candidate linkage
// Any failed check blocks the whole batch — the composer never partially trusts
// a deposit. The result reuses the goal-agnostic SafetyKernelResultV1 so the
// existing approve/submission surfaces render it unchanged.
// ---------------------------------------------------------------------------

/** 2^256 - 1. The canonical "infinite" ERC-20 allowance we always reject — an
 * earn deposit needs an EXACT, single-use approval, never a standing one. */
const MAX_UINT256 = (1n << 256n) - 1n;

export interface RunEarnSafetyKernelInputV1 {
  walletAddress: `0x${string}`;
  intent: EarnRouteIntentV1;
  candidate: EarnCandidateV1;
  calls: ExecutionCallV1[];
  quoteExpiry: string;
  now: Date;
  intentHash: HashV1;
  selectedCandidateHash: HashV1;
}

function check(
  id: string,
  description: string,
  ok: boolean,
  failDetail: string,
): SafetyKernelCheckV1 {
  return { id, description, status: ok ? 'passed' : 'failed', detail: ok ? null : failDetail };
}

interface DecodedApproval {
  spender: string;
  amount: bigint;
}

/** Decodes an ERC-20 approve; returns null on anything that is not exactly a
 * well-formed approve(address,uint256) — an undecodable/mismatched call is
 * never trusted as an approval. */
function decodeApprove(call: ExecutionCallV1): DecodedApproval | null {
  if (call.data.slice(0, 10).toLowerCase() !== '0x095ea7b3') return null;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
    if (decoded.functionName !== 'approve') return null;
    const [spender, amount] = decoded.args as readonly [`0x${string}`, bigint];
    return { spender: spender.toLowerCase(), amount };
  } catch {
    return null;
  }
}

interface DecodedDeposit {
  amount: bigint;
  /** null for Moonwell (mint credits msg.sender — no receiver arg). */
  receiver: string | null;
  vault: string | null;
  minimumShares: bigint | null;
  partnerId: number | null;
}

function decodeDeposit(call: ExecutionCallV1, protocol: EarnCandidateV1['protocol']): DecodedDeposit | null {
  try {
    if (protocol === 'moonwell') {
      const decoded = decodeFunctionData({ abi: MOONWELL_MINT_ABI, data: call.data });
      if (decoded.functionName !== 'mint') return null;
      const [amount] = decoded.args as readonly [bigint];
      return { amount, receiver: null, vault: null, minimumShares: null, partnerId: null };
    }
    if (protocol === 'morpho') {
      const decoded = decodeFunctionData({ abi: MORPHO_DEPOSIT_ABI, data: call.data });
      if (decoded.functionName !== 'deposit') return null;
      const [assets, receiver] = decoded.args as readonly [bigint, `0x${string}`];
      return { amount: assets, receiver: receiver.toLowerCase(), vault: null, minimumShares: null, partnerId: null };
    }
    const decoded = decodeFunctionData({ abi: YO_GATEWAY_DEPOSIT_ABI, data: call.data });
    const [vault, assets, minimumShares, receiver, partnerId] =
      decoded.args as readonly [`0x${string}`, bigint, bigint, `0x${string}`, number];
    return {
      amount: assets,
      receiver: receiver.toLowerCase(),
      vault: vault.toLowerCase(),
      minimumShares,
      partnerId,
    };
  } catch {
    return null;
  }
}

/**
 * Runs the strict earn Safety Kernel. Pure and synchronous — no live calls; it
 * only inspects the bytes of the calls it is handed against the pinned config
 * and the stored intent/candidate.
 */
export function runEarnSafetyKernelV1(input: RunEarnSafetyKernelInputV1): { result: SafetyKernelResultV1 } {
  const checks: SafetyKernelCheckV1[] = [];
  const wallet = input.walletAddress.toLowerCase();
  const expectedAmount = input.intent.amount.amountAtomic;
  const pinned = pinnedEarnVenueV1(input.candidate.protocol);
  const target = input.candidate.contracts.target.toLowerCase();

  checks.push(
    check(
      'tenant_wallet_binding',
      'Wallet address matches the authenticated tenant and stored earn intent',
      wallet === input.intent.walletAddress.toLowerCase(),
      'walletAddress does not match the stored earn intent',
    ),
  );

  checks.push(
    check(
      'base_chain_pinned',
      'Chain is pinned to Base mainnet (8453)',
      input.intent.chainId === 8453 && input.candidate.asset.chainId === 8453,
      'Earn deposits are only supported on Base mainnet (8453)',
    ),
  );

  checks.push(
    check(
      'canonical_usdc',
      'Deposit asset is canonical Base USDC on the intent, candidate, and approval',
      isCanonicalBaseUsdcV1(input.intent.asset.address ?? '') &&
        isCanonicalBaseUsdcV1(input.candidate.contracts.asset) &&
        input.candidate.asset.assetId === input.intent.asset.assetId,
      'Earn V1 only deposits canonical Base USDC',
    ),
  );

  checks.push(
    check(
      'pinned_deposit_target',
      'Deposit target is the pinned Moonwell market / Morpho vault for this protocol',
      isPinnedEarnTargetV1(target) &&
        target === pinned.target &&
        input.candidate.venue.address.toLowerCase() === target,
      'Deposit target is not the pinned venue for this protocol (no dynamic discovery)',
    ),
  );

  checks.push(
    check(
      'pinned_approval_spender',
      'USDC approval spender is the pinned deposit target',
      input.candidate.contracts.approvalSpender.toLowerCase() === pinned.approvalSpender &&
        isPinnedEarnTargetV1(pinned.approvalSpender),
      'Approval spender is not the pinned protocol spender',
    ),
  );

  checks.push(
    check(
      'intent_candidate_amount_match',
      'Candidate amount exactly equals the stored intent amount',
      input.candidate.amount.amountAtomic === expectedAmount &&
        input.candidate.amount.asset.assetId === input.intent.amount.asset.assetId,
      'Candidate amount does not exactly match the stored intent amount',
    ),
  );

  const approvalCalls = input.calls.filter((call) => call.callType === 'approval');
  const depositCalls = input.calls.filter((call) => call.callType === 'deposit');
  const otherCalls = input.calls.filter((call) => call.callType !== 'approval' && call.callType !== 'deposit');
  const shapeOk =
    approvalCalls.length === 1 &&
    depositCalls.length === 1 &&
    otherCalls.length === 0 &&
    approvalCalls[0]!.index < depositCalls[0]!.index;
  checks.push(
    check(
      'call_order_and_count',
      'Calls are exactly one exact approval followed by exactly one deposit',
      shapeOk,
      'Earn calls must be exactly one approval then one deposit, nothing else',
    ),
  );

  // --- Exact approval: decode the bytes; reject unlimited / wrong amount ------
  const approval = approvalCalls[0] ? decodeApprove(approvalCalls[0]) : null;
  const approvalToUsdc = approvalCalls[0]
    ? isCanonicalBaseUsdcV1(approvalCalls[0].to)
    : false;
  const approvalExact =
    !!approval &&
    approvalToUsdc &&
    approval.spender === pinned.approvalSpender &&
    approval.amount === BigInt(expectedAmount) &&
    approval.amount !== MAX_UINT256;
  checks.push(
    check(
      'exact_approval',
      'USDC approval is decodable, targets the pinned spender, and equals the exact intent amount',
      approvalExact,
      'Approval must be an exact-amount USDC approve() to the pinned target',
    ),
  );

  checks.push(
    check(
      'no_unlimited_approval',
      'USDC approval is never unlimited (rejects MaxUint256)',
      !approval || approval.amount !== MAX_UINT256,
      'Unlimited (MaxUint256) approvals are forbidden for earn deposits',
    ),
  );

  // --- Deposit: decode by protocol; verify exact amount + receiver ------------
  const deposit = depositCalls[0] ? decodeDeposit(depositCalls[0], input.candidate.protocol) : null;
  const depositCallTarget = input.candidate.protocol === 'yo' ? pinned.approvalSpender : target;
  const depositToTarget = depositCalls[0] ? depositCalls[0].to.toLowerCase() === depositCallTarget : false;
  const expectedYoShares = input.candidate.expectedPositionAtomic
    ? (BigInt(input.candidate.expectedPositionAtomic) * 9_950n) / 10_000n
    : null;
  const yoSemantics =
    input.candidate.protocol !== 'yo' ||
    (deposit?.vault === target &&
      deposit.minimumShares === expectedYoShares &&
      deposit.partnerId === 0);
  const depositExact = !!deposit && depositToTarget && deposit.amount === BigInt(expectedAmount) && yoSemantics;
  checks.push(
    check(
      'deposit_calldata_pinned',
      'Deposit calldata decodes to the exact pinned mint/deposit for the exact amount (no arbitrary calldata)',
      depositExact,
      'Deposit call is not the exact pinned deposit for the exact intent amount',
    ),
  );

  // Morpho carries an explicit receiver arg that MUST be the wallet; Moonwell
  // mint credits msg.sender, so the wallet is the receiver by construction.
  const receiverOk = !!deposit && (deposit.receiver === null || deposit.receiver === wallet);
  checks.push(
    check(
      'receiver_is_wallet',
      'Deposit position is credited to the authenticated wallet',
      receiverOk,
      'Deposit receiver is not the authenticated wallet',
    ),
  );

  const candidateExpiryMs = Date.parse(input.candidate.expiresAt);
  const quoteExpiryMs = Date.parse(input.quoteExpiry);
  const nowMs = input.now.getTime();
  const unexpired =
    Number.isFinite(candidateExpiryMs) &&
    candidateExpiryMs > nowMs &&
    Number.isFinite(quoteExpiryMs) &&
    quoteExpiryMs > nowMs;
  checks.push(
    check(
      'quote_evidence_unexpired',
      'Candidate evidence and Blueprint quote have not expired',
      unexpired,
      'Candidate evidence or Blueprint quote is expired or has an invalid expiry',
    ),
  );

  const zeroHash = `0x${'0'.repeat(64)}`;
  checks.push(
    check(
      'linkage_hashes_present',
      'Intent and selected-candidate hashes are bound to this deposit',
      Boolean(input.intentHash) &&
        Boolean(input.selectedCandidateHash) &&
        input.intentHash !== zeroHash &&
        input.selectedCandidateHash !== zeroHash,
      'Missing intent or candidate linkage hash',
    ),
  );

  const failed = checks.filter((entry) => entry.status === 'failed');
  const verdict: SafetyKernelResultV1['verdict'] = failed.length === 0 ? 'allowed' : 'blocked';
  const result = SafetyKernelResultV1Schema.parse({
    schemaVersion: 'safety-kernel-result/v1',
    verdict,
    checks,
    blockedReason:
      verdict === 'blocked' ? failed.map((entry) => `${entry.id}: ${entry.detail}`).join('; ') : null,
  });
  return { result };
}
