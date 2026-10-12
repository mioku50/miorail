import type { Hex } from 'viem';
import { hashApprovedCallsV1, type ExecutionCallV1, type HashV1 } from '@mioagent/route-domain';
import type { BaseReceiptReader, VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { validateAerodromeClaimCallsV1 } from '@mioagent/security/aerodromeClaimGuard';
import { validateUniswapCollectCallsV1 } from '@mioagent/security/uniswapCollectGuard';

import type { AerodromeClaimPlanV1 } from './aerodromeClaimReader.js';
import {
  PostgresBaseMcpActionReceiptRepositoryV1, baseMcpActionHashV1, publicBaseMcpActionReceiptV1,
  type BaseMcpActionReceiptRepositoryV1, type StoredBaseMcpActionReceiptV1,
} from './baseMcpActionReceipts.js';
import {
  aerodromeClaimCoverageV1, aerodromeClaimEventsMatchV1, aerodromeClaimWithBuilderCodeV1, baseMcpAerodromeClaimRuntimeV1,
} from './baseMcpAerodromeClaim.js';
import {
  baseMcpUniswapCollectRuntimeV1, uniswapCollectCoverageV1, uniswapCollectEventsMatchV1, uniswapCollectPlanV1,
  type UniswapCollectPlanV1,
} from './baseMcpUniswapCollect.js';
import { createViemBaseReceiptReader } from './baseReceiptReader.js';

// ---------------------------------------------------------------------------
// Found's claim, carried by the wallet the person is using on the page.
//
// Wallet MCP is Coinbase's server for a Base Account: connecting it and every
// approval go through keys.coinbase.com. Inside Farcaster that meant a trip to
// the browser, and a Farcaster wallet is another address, so the claim was
// refused by design (operator, 2026-10-11). Here the page's own wallet sends
// the calls: Farcaster's wallet, Base App's, Rabby or MetaMask, in one batch
// where the wallet can (EIP-5792, not atomic: each claim stands alone) and
// one transaction at a time where it cannot.
//
// Nothing about the protection moves. Miorail writes the calls from its own
// reading at one block, the same closed guards check them, a batch simulation
// must pass before they are handed out, and the receipt completes only when
// the transactions' events pay this wallet for every prepared claim. The
// wallet reports which transactions it sent; the chain says what they did.
// ---------------------------------------------------------------------------

export type FoundProtocolV1 = 'aerodrome' | 'uniswap';

export interface FoundWalletCallV1 { to: Hex; value: '0'; data: Hex }

export interface FoundWalletClaimResultV1 {
  kind: 'action' | 'answered' | 'failed';
  reply: string;
  errorCode: string | null;
  receipt: ReturnType<typeof publicBaseMcpActionReceiptV1> | null;
  /** The exact calls to send, while the receipt waits for the wallet. */
  calls: FoundWalletCallV1[] | null;
}

export const foundWalletClaimRuntimeV1 = {
  repository: new PostgresBaseMcpActionReceiptRepositoryV1() as BaseMcpActionReceiptRepositoryV1,
  receiptReader: createViemBaseReceiptReader as () => BaseReceiptReader,
  now: () => new Date().toISOString(),
};

/** A receipt whose wallet never reported a transaction stops waiting after this. */
export const FOUND_WALLET_CLAIM_UNSENT_TTL_MS_V1 = 60 * 60_000;
/** A prepare takes seconds; one still "preparing" after this was cut short. */
export const FOUND_WALLET_CLAIM_PREPARE_STALE_MS_V1 = 2 * 60_000;
const FINAL = ['completed', 'rejected', 'failed'];

function result(reply: string, errorCode: string | null = null, receipt: StoredBaseMcpActionReceiptV1 | null = null,
  calls: FoundWalletCallV1[] | null = null): FoundWalletClaimResultV1 {
  return { kind: errorCode ? 'failed' : receipt ? 'action' : 'answered', reply, errorCode,
    receipt: receipt ? publicBaseMcpActionReceiptV1(receipt) : null, calls };
}

function actionTypeOf(protocol: FoundProtocolV1): 'aerodrome_claim' | 'uniswap_collect' {
  return protocol === 'aerodrome' ? 'aerodrome_claim' : 'uniswap_collect';
}

function planOf(receipt: StoredBaseMcpActionReceiptV1): { calls: { call: ExecutionCallV1 }[] } | null {
  const proof = receipt.durableProof ?? {};
  const plan = (receipt.actionType === 'aerodrome_claim' ? proof.claimPlan : proof.collectPlan) as { calls?: { call: ExecutionCallV1 }[] } | undefined;
  return plan && Array.isArray(plan.calls) ? { calls: plan.calls } : null;
}

/** The calls a stored, unsent claim hands to the wallet: exactly the ones the
 * guard and the simulation saw. */
export function foundWalletCallsOfV1(receipt: StoredBaseMcpActionReceiptV1): FoundWalletCallV1[] | null {
  const plan = planOf(receipt);
  return plan ? plan.calls.map(({ call }) => ({ to: call.to as Hex, value: '0', data: call.data as Hex })) : null;
}

function aged(receipt: StoredBaseMcpActionReceiptV1, now: string, ms: number): boolean {
  const age = Date.parse(now) - Date.parse(receipt.updatedAt);
  return Number.isFinite(age) && age >= ms;
}

/** Nothing of it reached the chain, so a fresh reading may take its place:
 * calls handed out and never reported sent, or a prepare that was cut short. */
function replaceableV1(receipt: StoredBaseMcpActionReceiptV1, now: string): boolean {
  if (receipt.provider !== 'wallet' || receipt.durableProof?.submitted) return false;
  return receipt.status === 'approval_required'
    || (receipt.status === 'preparing' && aged(receipt, now, FOUND_WALLET_CLAIM_PREPARE_STALE_MS_V1));
}

/**
 * Reads, checks and simulates one protocol's claim for the signed-in wallet,
 * and hands back the calls for that wallet to send. Nothing is sent here.
 */
export async function prepareFoundWalletClaimV1(input: {
  userId: string;
  walletAddress?: string;
  idempotencyKey?: string;
  protocol: FoundProtocolV1;
}): Promise<FoundWalletClaimResultV1> {
  const runtime = foundWalletClaimRuntimeV1;
  if (!input.idempotencyKey) return result('This action needs a request ID.', 'base_mcp_action_request_id_required');
  if (!input.walletAddress || !/^0x[0-9a-fA-F]{40}$/u.test(input.walletAddress) || /^0x0{40}$/u.test(input.walletAddress)) {
    return result('Sign in with the wallet that will claim.', 'base_mcp_action_wallet_required');
  }
  const wallet = input.walletAddress.toLowerCase() as Hex;
  const actionType = actionTypeOf(input.protocol);
  const intent = input.protocol === 'aerodrome'
    ? { operation: 'claim' as const, recipient: wallet }
    : { operation: 'collect' as const, recipient: wallet };
  const hash = baseMcpActionHashV1({ tenantId: input.userId, walletAddress: wallet, idempotencyKey: input.idempotencyKey, actionType, intent });
  if (!await runtime.repository.available()) return result('Action Receipt storage is unavailable.', 'base_mcp_action_storage_unavailable');
  const existing = await runtime.repository.getByIdempotency(input.userId, input.idempotencyKey);
  if (existing) {
    if (existing.actionHash !== hash) return result('This request ID belongs to a different action.', 'base_mcp_action_idempotency_conflict');
    const waiting = existing.provider === 'wallet' && existing.status === 'approval_required';
    return result(waiting ? 'This claim is ready: confirm it in your wallet.' : 'This claim already has an Action Receipt.',
      existing.errorCode, existing, waiting ? foundWalletCallsOfV1(existing) : null);
  }
  const active = await runtime.repository.getActiveClaim(input.userId, wallet, actionType);
  if (active) {
    // One that was sent waits for its events; one still being prepared is
    // left to finish.
    if (!replaceableV1(active, runtime.now())) {
      return result(active.status === 'preparing'
        ? 'A claim for this wallet is being prepared in another window. Use that one, or ask again in a minute.'
        : 'A claim for this wallet is already on its way. Check its status; a new one waits until it settles.', active.errorCode, active);
    }
    await runtime.repository.update({ id: active.id, tenantId: active.tenantId, status: 'failed', reconciliationState: 'not_started',
      errorCode: 'found_claim_replaced', finalizedAt: runtime.now(), now: runtime.now() });
  }

  let summary: string;
  let calls: ExecutionCallV1[];
  let proof: Record<string, unknown>;
  let simulate: () => Promise<{ status: string; observedAt: string | null; blockNumber: string | null }>;
  try {
    if (input.protocol === 'aerodrome') {
      const aero = baseMcpAerodromeClaimRuntimeV1;
      const raw = await aero.readPlan(await aero.createReader(), wallet);
      summary = aerodromeClaimCoverageV1(raw);
      if (raw.errorCode) return result(`${summary} The claim was not prepared because the reads or target checks are incomplete.`, raw.errorCode);
      if (!raw.calls.length) return result(`${summary} No claimable fees or AERO were found in the supported positions at that block.`);
      const code = aero.builderCode();
      if (!code) throw new Error('aerodrome_builder_code_unavailable');
      const plan: AerodromeClaimPlanV1 = aerodromeClaimWithBuilderCodeV1(raw);
      calls = plan.calls.map((item) => item.call);
      validateAerodromeClaimCallsV1(wallet, calls.map((call) => ({ to: call.to, value: call.valueWei, data: call.data })));
      proof = { claimPlan: plan, channel: 'wallet' };
      simulate = () => aero.simulate(plan, wallet);
    } else {
      const uni = baseMcpUniswapCollectRuntimeV1;
      const read = await uni.readPlan(await uni.createReader(), wallet);
      summary = uniswapCollectCoverageV1(read);
      if (read.errorCode) return result(`${summary} The collect was not prepared because the positions could not all be read.`, read.errorCode);
      if (!read.positions.length) return result(`${summary} No fees to collect in this wallet's Uniswap v3 positions at that block.`);
      const code = uni.builderCode();
      if (!code) throw new Error('uniswap_builder_code_unavailable');
      const plan: UniswapCollectPlanV1 = await uniswapCollectPlanV1(read, wallet, { builderCode: code, rank: uni.rank });
      calls = plan.calls.map((item) => item.call);
      validateUniswapCollectCallsV1(wallet, calls.map((call) => ({ to: call.to, value: call.valueWei, data: call.data })));
      proof = { collectPlan: plan, channel: 'wallet' };
      simulate = () => uni.simulate(plan, wallet);
    }
  } catch (error) {
    const code = error instanceof Error && /^(aerodrome|uniswap)_[a-z_]+$/u.test(error.message) ? error.message : `${input.protocol}_prepare_unavailable`;
    return result('The claim could not be prepared just now. Nothing was sent to your wallet.', code);
  }

  let stored: StoredBaseMcpActionReceiptV1 | null = null;
  try {
    const created = await runtime.repository.create({ tenantId: input.userId, walletAddress: wallet, idempotencyKey: input.idempotencyKey,
      actionType, intent, now: runtime.now(), provider: 'wallet' });
    if (!created.created) {
      // The same request twice at once: the first one hands out the calls.
      return created.receipt.actionHash === hash ? result('This claim is being prepared.', null, created.receipt)
        : result('This request ID belongs to a different action.', 'base_mcp_action_idempotency_conflict');
    }
    stored = created.receipt;
    const simulation = await simulate();
    const durable = { ...proof, simulation, callsHash: hashApprovedCallsV1(calls) };
    if (simulation.status !== 'passed') {
      stored = await runtime.repository.update({ id: stored.id, tenantId: input.userId, status: 'failed', reconciliationState: 'not_started',
        durableProof: durable, errorCode: `${input.protocol}_simulation_required`, finalizedAt: runtime.now(), now: runtime.now() });
      return result(`${summary} Simulation ${simulation.status}; nothing was handed to your wallet.`, `${input.protocol}_simulation_required`, stored);
    }
    stored = await runtime.repository.update({ id: stored.id, tenantId: input.userId, status: 'approval_required',
      reconciliationState: 'not_started', durableProof: durable, now: runtime.now() });
    if (!stored || stored.status !== 'approval_required') return result('The simulated claim could not be saved.', 'base_mcp_action_storage_failed', stored);
  } catch (error) {
    // The partial unique index also guards two prepares with different IDs
    // across API workers: the one that lost hands out nothing.
    if (!stored) {
      const open = await runtime.repository.getActiveClaim(input.userId, wallet, actionType).catch(() => null);
      if (open) return result('A claim for this wallet is being prepared in another window. Use that one, or ask again in a minute.', open.errorCode, open);
    }
    const code = error instanceof Error && /^(aerodrome|uniswap)_[a-z_]+$/u.test(error.message) ? error.message : `${input.protocol}_prepare_unavailable`;
    if (stored) stored = await runtime.repository.update({ id: stored.id, tenantId: input.userId, status: 'failed', reconciliationState: 'not_started',
      errorCode: code, finalizedAt: runtime.now(), now: runtime.now() });
    return result('The claim could not be prepared just now. Nothing was handed to your wallet.', code, stored);
  }
  const n = calls.length;
  return result(`${summary} ${n} call${n === 1 ? '' : 's'} passed batch simulation. Confirm ${n === 1 ? 'it' : 'them'} in your wallet: each pays only this wallet, and the amounts are set when the transaction executes.`,
    null, stored, foundWalletCallsOfV1(stored));
}

/** The wallet's word on what it sent: transaction hashes, kept until the
 * chain confirms or refutes them. A hash proves nothing by itself. */
export async function recordFoundWalletSubmissionV1(input: {
  userId: string;
  walletAddress?: string;
  receiptId: string;
  transactionHashes: readonly string[];
}): Promise<FoundWalletClaimResultV1> {
  const runtime = foundWalletClaimRuntimeV1;
  const receipt = await runtime.repository.get(input.receiptId, input.userId);
  if (!receipt || receipt.provider !== 'wallet' || receipt.walletAddress !== input.walletAddress?.toLowerCase()) {
    return result('That claim was not found for this wallet.', 'base_mcp_action_receipt_not_found');
  }
  const hashes = [...new Set(input.transactionHashes.map((hash) => hash.toLowerCase()))];
  if (hashes.length < 1 || hashes.length > 20 || hashes.some((hash) => !/^0x[0-9a-f]{64}$/u.test(hash))) {
    return result('The wallet reported no transaction this claim can be checked against.', 'found_claim_hashes_invalid', receipt);
  }
  const submitted = (receipt.durableProof?.submitted as { transactionHashes?: string[] } | undefined)?.transactionHashes;
  if (submitted) {
    return submitted.join() === hashes.join() ? result('Already recorded; checking it on Base.', null, receipt)
      : result('This claim already names its transactions.', 'found_claim_already_submitted', receipt);
  }
  if (receipt.status !== 'approval_required') return result('This claim is not waiting for its wallet.', 'found_claim_not_waiting', receipt);
  const updated = await runtime.repository.update({ id: receipt.id, tenantId: input.userId, status: 'pending', reconciliationState: 'pending',
    durableProof: { ...receipt.durableProof, submitted: { transactionHashes: hashes, at: runtime.now() } },
    transactionHash: hashes.at(-1) as HashV1, now: runtime.now() });
  return result('Sent. Miorail checks it on Base.', null, updated);
}

/** The transactions a wallet-carried claim names, read from Base as one
 * receipt: every one must have succeeded, and the logs are taken together. */
export async function foundWalletChainReceiptV1(
  receipt: StoredBaseMcpActionReceiptV1,
  reader: BaseReceiptReader,
): Promise<VerifiedReceiptSourceV1 | 'missing' | 'reverted'> {
  const hashes = (receipt.durableProof?.submitted as { transactionHashes?: string[] } | undefined)?.transactionHashes ?? [];
  if (!hashes.length) return 'missing';
  const receipts = await Promise.all(hashes.map((hash) => reader.getTransactionReceipt(hash as HashV1)));
  if (receipts.some((one) => !one)) return 'missing';
  const all = receipts as VerifiedReceiptSourceV1[];
  if (all.some((one) => one.status !== 'success')) return 'reverted';
  return {
    ...all.at(-1)!,
    status: 'success',
    // The earliest block is the one the plan's block must not follow.
    blockNumber: all.reduce((lowest, one) => (one.blockNumber < lowest ? one.blockNumber : lowest), all[0]!.blockNumber),
    logs: all.flatMap((one) => one.logs),
  };
}

export async function reconcileFoundWalletClaimV1(input: {
  userId: string;
  walletAddress?: string;
  receipt: StoredBaseMcpActionReceiptV1;
}): Promise<FoundWalletClaimResultV1> {
  const runtime = foundWalletClaimRuntimeV1;
  const stored = input.receipt;
  if (stored.tenantId !== input.userId || stored.walletAddress !== input.walletAddress?.toLowerCase()) {
    return result('Connect the wallet that prepared this claim.', 'base_mcp_wallet_mismatch');
  }
  if (FINAL.includes(stored.status)) return result('This Action Receipt is final.', stored.errorCode, stored);
  if (stored.status === 'approval_required' || stored.status === 'preparing') {
    if (aged(stored, runtime.now(), FOUND_WALLET_CLAIM_UNSENT_TTL_MS_V1)) {
      // The page may have closed before the wallet answered: say what is
      // known, which is that no transaction was reported.
      const expired = await runtime.repository.update({ id: stored.id, tenantId: stored.tenantId, status: 'failed',
        reconciliationState: 'not_started', errorCode: 'found_claim_not_reported', finalizedAt: runtime.now(), now: runtime.now() });
      return result('Your wallet never reported sending this claim, so it no longer waits. If you did send it, your wallet\'s activity shows it; ask again to read what is left.',
        'found_claim_not_reported', expired);
    }
    return stored.status === 'preparing' ? result('This claim is still being prepared.', null, stored)
      : result('Waiting for your wallet: confirm the claim there.', null, stored, foundWalletCallsOfV1(stored));
  }
  try {
    const chain = await foundWalletChainReceiptV1(stored, runtime.receiptReader());
    if (chain === 'missing') {
      const waiting = await runtime.repository.update({ id: stored.id, tenantId: stored.tenantId, status: 'reconciling',
        reconciliationState: 'pending', now: runtime.now() });
      return result('Sent; not on Base yet. Check again in a few seconds.', null, waiting);
    }
    if (chain === 'reverted') {
      const failed = await runtime.repository.update({ id: stored.id, tenantId: stored.tenantId, status: 'failed',
        reconciliationState: 'mismatched', errorCode: 'found_claim_reverted', finalizedAt: runtime.now(), now: runtime.now() });
      return result('A transaction of this claim reverted on Base, so it is not counted as claimed.', 'found_claim_reverted', failed);
    }
    const proof = stored.durableProof ?? {};
    const matched = stored.actionType === 'aerodrome_claim'
      ? aerodromeClaimEventsMatchV1(proof.claimPlan as AerodromeClaimPlanV1, stored.walletAddress, chain)
      : uniswapCollectEventsMatchV1(proof.collectPlan as UniswapCollectPlanV1, stored.walletAddress, chain);
    const updated = await runtime.repository.update({ id: stored.id, tenantId: stored.tenantId,
      status: matched ? 'completed' : 'failed', reconciliationState: matched ? 'matched' : 'mismatched',
      errorCode: matched ? null : `${stored.actionType === 'aerodrome_claim' ? 'aerodrome_claim' : 'uniswap_collect'}_events_mismatch`,
      transactionHash: chain.transactionHash, blockNumber: String(chain.blockNumber),
      finalizedAt: runtime.now(), now: runtime.now() });
    return result(matched ? 'Confirmed on Base: every prepared claim has an event paying your wallet.'
      : 'The onchain facts did not match the prepared claim.', updated?.errorCode ?? null, updated);
  } catch {
    return result('The claim could not be checked just now. Nothing was resent.', 'found_claim_reconciliation_unavailable', stored);
  }
}
