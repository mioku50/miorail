import type { Request } from 'express';
import type { ToolAggregator } from '@mioagent/tools';
import { decodeEventLog, parseAbi, type Hex } from 'viem';
import { builderCodeFromEnvV1, hashApprovedCallsV1, stableHashV1, type HashV1 } from '@mioagent/route-domain';
import type { SimulationStateV1 } from '@mioagent/route-domain';
import type { BaseReceiptReader, VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { createApiToolAggregatorForUser } from './baseMcpTools.js';
import { verifyBaseMcpWalletMatch } from './baseMcpWalletReconciliation.js';
import { extractBaseMcpApprovalSnapshot, resolveBaseMcpApprovalLifecycle } from './baseMcpApprovalLifecycle.js';
import { createViemBaseReceiptReader } from './baseReceiptReader.js';
import { buildSimulationChainV1, runSimulationChainV1 } from './swapSimulation.js';
import {
  PostgresBaseMcpActionReceiptRepositoryV1, baseMcpActionHashV1, publicBaseMcpActionReceiptV1,
  type BaseMcpActionReceiptRepositoryV1, type StoredBaseMcpActionReceiptV1,
} from './baseMcpActionReceipts.js';
import {
  SUGAR_MAX_ITERATIONS_V1, createAerodromeClaimReadV1, readAerodromeClaimPlanV1, type AerodromeClaimPlanV1,
} from './aerodromeClaimReader.js';

export interface BaseMcpAerodromeClaimResultV1 {
  kind: 'action' | 'failed' | 'answered'; reply: string; errorCode: string | null;
  toolsAvailable: number; receipt: ReturnType<typeof publicBaseMcpActionReceiptV1> | null;
  approvalUrl: string | null;
}
const CLAIM_EVENTS = parseAbi([
  'event Claim(address indexed sender,address indexed recipient,uint256 amount0,uint256 amount1)',
  'event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)',
  'event ClaimRewards(address indexed from,uint256 amount)',
]);

async function simulateClaim(plan: AerodromeClaimPlanV1, wallet: string): Promise<SimulationStateV1> {
  const calls = plan.calls.map(item => item.call);
  const callsHash = hashApprovedCallsV1(calls);
  const requestHash = stableHashV1('aerodrome-claim-simulation/v1', { callsHash, wallet });
  const nowIso = new Date().toISOString();
  const chain = buildSimulationChainV1(process.env);
  // The vertical requires a batch-capable provider even for one claim. No
  // independent eth_calls, overrides or synthetic balances can pass this gate.
  chain.providers = chain.providers.filter(provider => chain.batchCapableIds.has(provider.providerId));
  const answer = await runSimulationChainV1({ chain, request: {
    chainId: 8453, walletAddress: wallet, blueprintHash: requestHash, callsHash, calls,
  }, nowIso, label: 'Aerodrome claim simulation', logContext: { callsHash } });
  if (!answer.ok) return { status: 'unavailable', observedAt: nowIso, blockNumber: null,
    requestHash, responseHash: null, errorCode: answer.errorCode };
  return { status: answer.response.status === 'success' ? 'passed' : 'failed', observedAt: nowIso,
    blockNumber: String(answer.response.blockNumber), requestHash,
    responseHash: stableHashV1('aerodrome-claim-simulation-response/v1', answer.response),
    errorCode: answer.response.status === 'success' ? null : 'reverted' };
}

export const baseMcpAerodromeClaimRuntimeV1 = {
  repository: new PostgresBaseMcpActionReceiptRepositoryV1() as BaseMcpActionReceiptRepositoryV1,
  createTools: createApiToolAggregatorForUser,
  verifyWallet: verifyBaseMcpWalletMatch,
  createReader: createAerodromeClaimReadV1,
  readPlan: readAerodromeClaimPlanV1,
  simulate: simulateClaim,
  receiptReader: createViemBaseReceiptReader as () => BaseReceiptReader,
  builderCode: () => builderCodeFromEnvV1(process.env),
  now: () => new Date().toISOString(),
};
type ClaimInput = { req: Request; userId: string; walletAddress?: string; sessionSecret: string; idempotencyKey?: string };
function result(reply: string, errorCode: string | null = null, receipt: StoredBaseMcpActionReceiptV1 | null = null,
  approvalUrl: string | null = null): BaseMcpAerodromeClaimResultV1 {
  return { kind: errorCode ? 'failed' : receipt ? 'action' : 'answered', reply, errorCode, toolsAvailable: 0,
    receipt: receipt ? publicBaseMcpActionReceiptV1(receipt) : null, approvalUrl };
}
function coverage(plan: AerodromeClaimPlanV1): string {
  const direct = plan.poolsReadDirect > 0
    ? `, ${plan.poolsReadDirect.toLocaleString('en-US')} of them past Sugar's ${SUGAR_MAX_ITERATIONS_V1.toLocaleString('en-US')}-pool limit, read from the pools themselves`
    : '';
  return `Read ${plan.poolsRead.toLocaleString('en-US')} of ${plan.poolsTotal.toLocaleString('en-US')} Aerodrome pools at Base block ${plan.blockNumber}${direct}. ${plan.poolsUnread} pools unread. Checked ${plan.clPositionsRead} of ${plan.clPositionsTotal} concentrated positions held in your wallet. ${plan.managedSkipped} managed or locked positions excluded.`;
}
function repeated(receipt: StoredBaseMcpActionReceiptV1, hash: string): BaseMcpAerodromeClaimResultV1 {
  if (receipt.actionHash !== hash) return result('This request ID belongs to a different action.', 'base_mcp_action_idempotency_conflict');
  return result('This claim already has an Action Receipt. Check that receipt; the approval request was not sent again.', receipt.errorCode, receipt);
}
function activeClaim(receipt: StoredBaseMcpActionReceiptV1): BaseMcpAerodromeClaimResultV1 {
  return result('A claim for this wallet is already in progress. Approve or reject it in your wallet. If its outcome cannot be learned, it stops blocking a new claim one hour after its last update.', receipt.errorCode, receipt);
}

/** How long an open claim may block the next one. A repeated claim is safe to
 * prepare: it is read afresh, and whatever an earlier approval took is no
 * longer claimable. What is not safe is a lock nothing can release: a lost
 * Wallet MCP response leaves no request ID, and only time can end that wait. */
export const AERODROME_CLAIM_OPEN_TTL_MS_V1 = 60 * 60_000;
const FINAL_STATUSES = ['completed', 'rejected', 'failed'];
function claimAged(receipt: StoredBaseMcpActionReceiptV1, now: string): boolean {
  const age = Date.parse(now) - Date.parse(receipt.updatedAt);
  return Number.isFinite(age) && age >= AERODROME_CLAIM_OPEN_TTL_MS_V1;
}
async function expireClaim(receipt: StoredBaseMcpActionReceiptV1): Promise<StoredBaseMcpActionReceiptV1 | null> {
  const now = baseMcpAerodromeClaimRuntimeV1.now();
  return baseMcpAerodromeClaimRuntimeV1.repository.update({ id: receipt.id, tenantId: receipt.tenantId,
    status: 'failed', reconciliationState: 'unavailable', errorCode: 'aerodrome_claim_outcome_expired',
    finalizedAt: now, now });
}
/** The wallet's open claim, if it still blocks. An aged one is asked about
 * once; Wallet MCP's answer wins, and only an unknown or unanswered outcome
 * expires. A completion still waiting for its events keeps blocking. */
async function openClaim(input: ClaimInput, wallet: string): Promise<StoredBaseMcpActionReceiptV1 | null> {
  const runtime = baseMcpAerodromeClaimRuntimeV1;
  const active = await runtime.repository.getActiveAerodromeClaim(input.userId, wallet);
  if (!active || !claimAged(active, runtime.now())) return active;
  if (active.providerRequestId) {
    const checked = await reconcileBaseMcpAerodromeClaimV1({ ...input, receipt: active });
    const status = checked.receipt?.status;
    if (status && (status === 'reconciling' || FINAL_STATUSES.includes(status))) {
      return runtime.repository.getActiveAerodromeClaim(input.userId, wallet);
    }
  }
  const current = await runtime.repository.get(active.id, active.tenantId);
  if (current && !FINAL_STATUSES.includes(current.status) && current.status !== 'reconciling') await expireClaim(current);
  return runtime.repository.getActiveAerodromeClaim(input.userId, wallet);
}
function withBuilderCode(plan: AerodromeClaimPlanV1): AerodromeClaimPlanV1 {
  const code = baseMcpAerodromeClaimRuntimeV1.builderCode();
  if (!code) throw new Error('aerodrome_builder_code_unavailable');
  // ERC-8021 schema 0: ASCII code || byte length || schema id || marker.
  // Wallet MCP send_calls accepts chain+calls, so attribute the exact calldata
  // before simulating it. Solidity ignores the trailing attribution bytes.
  const bytes = Buffer.from(code, 'ascii');
  const suffix = `${bytes.toString('hex')}${bytes.length.toString(16).padStart(2, '0')}0080218021802180218021802180218021`;
  return { ...plan, calls: plan.calls.map(item => ({ ...item,
    call: { ...item.call, data: `${item.call.data}${suffix}` as Hex },
  })) };
}

export async function prepareBaseMcpAerodromeClaimV1(input: ClaimInput): Promise<BaseMcpAerodromeClaimResultV1> {
  const runtime = baseMcpAerodromeClaimRuntimeV1;
  if (!input.idempotencyKey) return result('This action needs a request ID.', 'base_mcp_action_request_id_required');
  if (!input.walletAddress || !/^0x[0-9a-fA-F]{40}$/u.test(input.walletAddress)
    || /^0x0{40}$/u.test(input.walletAddress)) return result('Connect the Base Account that will approve this claim.', 'base_mcp_action_wallet_required');
  const wallet = input.walletAddress.toLowerCase() as Hex;
  const intent = { operation: 'claim' as const, recipient: wallet };
  const hash = baseMcpActionHashV1({ tenantId: input.userId, walletAddress: wallet,
    idempotencyKey: input.idempotencyKey, actionType: 'aerodrome_claim', intent });
  if (!await runtime.repository.available()) return result('Action Receipt storage is unavailable.', 'base_mcp_action_storage_unavailable');
  const existing = await runtime.repository.getByIdempotency(input.userId, input.idempotencyKey);
  if (existing) return repeated(existing, hash);
  const active = await openClaim(input, wallet);
  if (active) return activeClaim(active);
  let tools: ToolAggregator | undefined;
  let preparedTools: ToolAggregator | undefined;
  let stored: StoredBaseMcpActionReceiptV1 | null = null;
  let submitted = false;
  try {
    tools = await runtime.createTools(input.req, input.userId, input.sessionSecret, { baseMcpOnly: true });
    const match = await runtime.verifyWallet(tools, wallet);
    if (!match.checked || !match.match) return result('Reconnect Wallet MCP with the same Base Account before claiming.',
      match.checked ? 'base_mcp_wallet_mismatch' : 'base_mcp_wallet_unverified');
    const rawPlan = await runtime.readPlan(await runtime.createReader(), wallet);
    const summary = coverage(rawPlan);
    if (rawPlan.errorCode) return result(`${summary} The claim was not prepared because the reads or target checks are incomplete.`, rawPlan.errorCode);
    if (!rawPlan.calls.length) return result(`${summary} No claimable fees or AERO were found in the supported positions at that block.`);
    const plan = withBuilderCode(rawPlan);
    const created = await runtime.repository.create({ tenantId: input.userId, walletAddress: wallet,
      idempotencyKey: input.idempotencyKey, actionType: 'aerodrome_claim', intent, now: runtime.now() });
    stored = created.receipt;
    if (!created.created) return repeated(stored, hash);
    const simulation = await runtime.simulate(plan, wallet);
    const proof = { claimPlan: plan, simulation, callsHash: hashApprovedCallsV1(plan.calls.map(item => item.call)) };
    if (simulation.status !== 'passed') {
      stored = await runtime.repository.update({ id: stored.id, tenantId: input.userId, status: 'failed',
        reconciliationState: 'not_started', durableProof: proof, errorCode: 'aerodrome_simulation_required',
        finalizedAt: runtime.now(), now: runtime.now() });
      return result(`${summary} Simulation ${simulation.status}; no wallet approval was requested.`, 'aerodrome_simulation_required', stored);
    }
    stored = await runtime.repository.update({ id: stored.id, tenantId: input.userId, status: 'preparing',
      reconciliationState: 'not_started', durableProof: proof, now: runtime.now() });
    if (!stored) return result('The simulated claim could not be saved.', 'base_mcp_action_storage_failed');
    preparedTools = await runtime.createTools(input.req, input.userId, input.sessionSecret, {
      baseMcpOnly: true, baseMcpPreparedClaim: { actionType: 'aerodrome_claim', walletAddress: wallet, calls: plan.calls.map(({ call }) => ({
        to: call.to, value: call.valueWei, data: call.data,
      })) },
    });
    // Check again on the exact kept connection used to submit, after the read.
    const finalMatch = await runtime.verifyWallet(preparedTools, wallet);
    if (!finalMatch.checked || !finalMatch.match) throw new Error('base_mcp_wallet_mismatch');
    // A long scan may exhaust a simulator's freshness window. Never ask for
    // approval of a simulation measured before the position snapshot.
    const simulationAge = Date.parse(runtime.now()) - Date.parse(simulation.observedAt ?? '');
    if (!simulation.blockNumber || BigInt(simulation.blockNumber) < BigInt(plan.blockNumber)
      || !Number.isFinite(simulationAge) || simulationAge < -5_000 || simulationAge > 60_000) throw new Error('aerodrome_simulation_expired');
    submitted = true;
    const called = await preparedTools.callTool('prepared_aerodrome_claim', {});
    const snapshot = extractBaseMcpApprovalSnapshot(called.content);
    const state = snapshot.state ?? (snapshot.approvalUrl ? 'approval_required' : 'pending');
    const errorCode = called.isError || !snapshot.requestId ? 'base_mcp_claim_outcome_unknown' : null;
    stored = await runtime.repository.update({ id: stored.id, tenantId: input.userId,
      status: errorCode ? 'pending' : state === 'completed' ? 'reconciling' : state,
      reconciliationState: errorCode ? 'unavailable' : state === 'completed' ? 'pending' : 'not_started',
      providerRequestId: snapshot.requestId ?? null,
      durableProof: { ...proof, ...(snapshot.proof ?? {}) }, errorCode,
      ...(['failed', 'rejected'].includes(state) ? { finalizedAt: runtime.now() } : {}), now: runtime.now() });
    if (errorCode) return result('Wallet MCP did not return a durable request ID. The outcome is uncertain; this claim will not be sent again with the same request ID.', errorCode, stored);
    return result(`${summary} ${plan.calls.length} claim calls passed batch simulation. Review fees and AERO in your wallet. Some CL gauges apply an early-claim penalty; actual amounts are determined when the transaction executes.`, stored?.errorCode ?? null, stored, snapshot.approvalUrl ?? null);
  } catch (error) {
    // The partial unique index also protects concurrent requests with DIFFERENT
    // IDs across API workers. A lost create race must not send another approval.
    if (!stored) {
      const active = await runtime.repository.getActiveAerodromeClaim(input.userId, wallet).catch(() => null);
      if (active) return activeClaim(active);
    }
    const errorCode = error instanceof Error && /^(aerodrome|base_mcp)_[a-z_]+$/u.test(error.message)
      ? error.message : 'aerodrome_prepare_unavailable';
    if (stored) stored = await runtime.repository.update({ id: stored.id, tenantId: input.userId,
      status: submitted ? 'pending' : 'failed', reconciliationState: submitted ? 'unavailable' : 'not_started',
      errorCode: submitted ? 'base_mcp_claim_outcome_unknown' : errorCode,
      ...(!submitted ? { finalizedAt: runtime.now() } : {}), now: runtime.now() });
    return result(submitted ? 'The submission outcome is uncertain. This claim will not be resubmitted.'
      : 'Aerodrome claim preparation did not finish. No alternative contracts were used.',
    submitted ? 'base_mcp_claim_outcome_unknown' : errorCode, stored);
  } finally {
    await preparedTools?.close().catch(() => undefined);
    await tools?.close().catch(() => undefined);
  }
}

/** Each claim needs its own event from the validated target, for THIS wallet.
 * Logs are consumed once (two NFTs in one gauge need two reward events).
 * Amounts can change after simulation; a claim event is not a price promise. */
export function aerodromeClaimEventsMatchV1(plan: AerodromeClaimPlanV1, wallet: string, receipt: VerifiedReceiptSourceV1): boolean {
  if (!plan.calls.length || receipt.status !== 'success' || receipt.blockNumber < BigInt(plan.blockNumber)) return false;
  const used = new Set<number>();
  return plan.calls.every(item => receipt.logs.some((log, index) => {
    if (used.has(index) || log.address.toLowerCase() !== item.call.to.toLowerCase()) return false;
    try {
      const decoded = decodeEventLog({ abi: CLAIM_EVENTS, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      const args = decoded.args;
      const ok = item.kind === 'basic_fees' ? decoded.eventName === 'Claim' && 'recipient' in args
        && args.recipient.toLowerCase() === wallet && 'sender' in args && args.sender.toLowerCase() === wallet
        && ('amount0' in args && args.amount0 > 0n || 'amount1' in args && args.amount1 > 0n)
        : item.kind === 'cl_fees' ? decoded.eventName === 'Collect' && 'recipient' in args
          && args.recipient.toLowerCase() === wallet && 'tokenId' in args && String(args.tokenId) === item.tokenId
          && ('amount0' in args && args.amount0 > 0n || 'amount1' in args && args.amount1 > 0n)
          : decoded.eventName === 'ClaimRewards' && 'from' in args && args.from.toLowerCase() === wallet
            && 'amount' in args && args.amount > 0n;
      if (ok) used.add(index);
      return ok;
    } catch { return false; }
  }));
}

export async function reconcileBaseMcpAerodromeClaimV1(input: ClaimInput & { receipt: StoredBaseMcpActionReceiptV1 }): Promise<BaseMcpAerodromeClaimResultV1> {
  const runtime = baseMcpAerodromeClaimRuntimeV1;
  const stored = input.receipt;
  if (stored.tenantId !== input.userId || input.walletAddress?.toLowerCase() !== stored.walletAddress) {
    return result('Connect the Base Account that prepared this claim.', 'base_mcp_wallet_mismatch');
  }
  if (['completed', 'rejected', 'failed'].includes(stored.status)) return result('This Action Receipt is final.', stored.errorCode, stored);
  if (!stored.providerRequestId) {
    if (claimAged(stored, runtime.now())) {
      return result('Miorail could not learn this claim’s outcome, so it no longer blocks a new claim. Check your wallet activity before claiming again.',
        'aerodrome_claim_outcome_expired', await expireClaim(stored) ?? stored);
    }
    return result('The original submission has no request ID. Miorail will not submit it again; it stops blocking a new claim one hour after its last update.', 'base_mcp_claim_outcome_unknown', stored);
  }
  let tools: ToolAggregator | undefined;
  try {
    tools = await runtime.createTools(input.req, input.userId, input.sessionSecret, { baseMcpOnly: true });
    const match = await runtime.verifyWallet(tools, stored.walletAddress);
    if (!match.checked || !match.match) return result('Reconnect the same Wallet MCP account.', 'base_mcp_wallet_mismatch', stored);
    const outcome = await resolveBaseMcpApprovalLifecycle({ initialResult: { requestId: stored.providerRequestId }, tools, pollAttempts: 1 });
    const proof: Record<string, unknown> = { ...stored.durableProof, ...outcome.proof };
    let status: StoredBaseMcpActionReceiptV1['status'] = outcome.state === 'completed' ? 'reconciling' : outcome.state;
    let reconciliationState: StoredBaseMcpActionReceiptV1['reconciliationState'] = stored.reconciliationState;
    let errorCode = outcome.errorCode ?? null;
    let transactionHash: HashV1 | null = stored.transactionHash;
    let blockNumber = stored.blockNumber;
    if (outcome.state === 'completed') {
      reconciliationState = 'pending';
      const hash = proof.txHash;
      const plan = proof.claimPlan as AerodromeClaimPlanV1 | undefined;
      const chainReceipt = typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/u.test(hash)
        ? await runtime.receiptReader().getTransactionReceipt(hash.toLowerCase() as HashV1) : null;
      if (!chainReceipt) { reconciliationState = 'unavailable'; errorCode = 'aerodrome_receipt_unavailable'; }
      else {
        transactionHash = chainReceipt.transactionHash;
        blockNumber = String(chainReceipt.blockNumber);
        const matched = transactionHash.toLowerCase() === String(hash).toLowerCase()
          && plan && aerodromeClaimEventsMatchV1(plan, stored.walletAddress, chainReceipt);
        status = matched ? 'completed' : 'failed';
        reconciliationState = matched ? 'matched' : 'mismatched';
        errorCode = matched ? null : 'aerodrome_claim_events_mismatch';
      }
    }
    const updated = await runtime.repository.update({ id: stored.id, tenantId: input.userId, status,
      reconciliationState, durableProof: proof, transactionHash, blockNumber, errorCode,
      ...(['completed', 'failed', 'rejected'].includes(status) ? { finalizedAt: runtime.now() } : {}), now: runtime.now() });
    return result(status === 'completed' ? 'Confirmed on Base: every prepared claim has a matching event for your wallet.'
      : status === 'reconciling' ? 'Wallet MCP reports completion; the claim events are not verified yet.'
        : status === 'failed' ? 'The onchain claim facts did not match the prepared action.'
          : status === 'rejected' ? 'The wallet approval was rejected.' : 'The wallet approval is still pending.', errorCode, updated, outcome.approvalUrl ?? null);
  } catch { return result('The receipt could not be checked. No claim was resubmitted.', 'aerodrome_reconciliation_unavailable', stored); }
  finally { await tools?.close().catch(() => undefined); }
}
