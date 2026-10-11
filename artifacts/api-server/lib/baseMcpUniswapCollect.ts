import type { Request } from 'express';
import type { ToolAggregator } from '@mioagent/tools';
import { decodeEventLog, parseAbi, type Hex } from 'viem';
import { builderCodeFromEnvV1, hashApprovedCallsV1, stableHashV1, type ExecutionCallV1, type HashV1 } from '@mioagent/route-domain';
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
import { aerodromeRewardsRuntimeV1 } from './aerodromeRewards.js';
import { valueUniswapFeesV1 } from './uniswapFees.js';
import {
  UNISWAP_COLLECT_LIMIT_V1, UNISWAP_V3_POSITION_MANAGER_V1, createUniswapFeesReadV1, readUniswapFeesPlanV1,
  uniswapCollectCallV1, type UniswapFeePositionV1, type UniswapFeesPlanV1,
} from './uniswapFeesReader.js';

// ---------------------------------------------------------------------------
// Found's Uniswap collect: every fee the wallet's v3 positions owe, paid to
// the wallet itself, in one approval.
//
// The same discipline as Aerodrome's claim: Miorail writes the calldata from
// its own reading at one block, a closed guard checks its shape (one
// `collect` per position, the pinned manager, the wallet as recipient, all of
// it), a batch simulation must pass before the wallet is asked, and the
// receipt completes only when the manager's Collect events pay this wallet
// for every prepared position.
// ---------------------------------------------------------------------------

export interface UniswapCollectItemV1 extends UniswapFeePositionV1 { call: ExecutionCallV1 }
export interface UniswapCollectPlanV1 {
  blockNumber: string;
  positionsHeld: number;
  /** Positions with fees beyond the ones in this approval. */
  positionsLeft: number;
  calls: UniswapCollectItemV1[];
}

export interface BaseMcpUniswapCollectResultV1 {
  kind: 'action' | 'failed' | 'answered'; reply: string; errorCode: string | null;
  toolsAvailable: number; receipt: ReturnType<typeof publicBaseMcpActionReceiptV1> | null;
  approvalUrl: string | null;
}

const COLLECT_EVENTS = parseAbi(['event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)']);

async function simulateCollect(plan: UniswapCollectPlanV1, wallet: string): Promise<SimulationStateV1> {
  const calls = plan.calls.map(item => item.call);
  const callsHash = hashApprovedCallsV1(calls);
  const requestHash = stableHashV1('uniswap-collect-simulation/v1', { callsHash, wallet });
  const nowIso = new Date().toISOString();
  const chain = buildSimulationChainV1(process.env);
  // Batch-capable providers only, as for Aerodrome's claim: the calls are
  // simulated together, as the wallet will send them.
  chain.providers = chain.providers.filter(provider => chain.batchCapableIds.has(provider.providerId));
  const answer = await runSimulationChainV1({ chain, request: {
    chainId: 8453, walletAddress: wallet, blueprintHash: requestHash, callsHash, calls,
  }, nowIso, label: 'Uniswap collect simulation', logContext: { callsHash } });
  if (!answer.ok) return { status: 'unavailable', observedAt: nowIso, blockNumber: null,
    requestHash, responseHash: null, errorCode: answer.errorCode };
  return { status: answer.response.status === 'success' ? 'passed' : 'failed', observedAt: nowIso,
    blockNumber: String(answer.response.blockNumber), requestHash,
    responseHash: stableHashV1('uniswap-collect-simulation-response/v1', answer.response),
    errorCode: answer.response.status === 'success' ? null : 'reverted' };
}

export const baseMcpUniswapCollectRuntimeV1 = {
  repository: new PostgresBaseMcpActionReceiptRepositoryV1() as BaseMcpActionReceiptRepositoryV1,
  createTools: createApiToolAggregatorForUser,
  verifyWallet: verifyBaseMcpWalletMatch,
  createReader: createUniswapFeesReadV1,
  readPlan: readUniswapFeesPlanV1,
  /** Only consulted when more positions owe fees than one approval holds. */
  rank: async (plan: UniswapFeesPlanV1, wallet: string): Promise<UniswapFeePositionV1[]> =>
    (await valueUniswapFeesV1(plan, {
      tokenMeta: aerodromeRewardsRuntimeV1.tokenMeta,
      value: (asset, amountAtomic) => aerodromeRewardsRuntimeV1.value(asset, amountAtomic, wallet),
    })).positions,
  simulate: simulateCollect,
  receiptReader: createViemBaseReceiptReader as () => BaseReceiptReader,
  builderCode: () => builderCodeFromEnvV1(process.env),
  now: () => new Date().toISOString(),
};

type CollectInput = { req: Request; userId: string; walletAddress?: string; sessionSecret: string; idempotencyKey?: string };
function result(reply: string, errorCode: string | null = null, receipt: StoredBaseMcpActionReceiptV1 | null = null,
  approvalUrl: string | null = null): BaseMcpUniswapCollectResultV1 {
  return { kind: errorCode ? 'failed' : receipt ? 'action' : 'answered', reply, errorCode, toolsAvailable: 0,
    receipt: receipt ? publicBaseMcpActionReceiptV1(receipt) : null, approvalUrl };
}
function coverage(plan: UniswapFeesPlanV1): string {
  const v4 = plan.v4PositionsHeld ? ` ${plan.v4PositionsHeld} v4 position${plan.v4PositionsHeld === 1 ? ' is' : 's are'} not read here.` : '';
  const unread = plan.unreadable ? ` ${plan.unreadable} position${plan.unreadable === 1 ? '' : 's'} could not be read and ${plan.unreadable === 1 ? 'is' : 'are'} left out.` : '';
  return `Read ${plan.positionsHeld} Uniswap v3 position${plan.positionsHeld === 1 ? '' : 's'} at Base block ${plan.blockNumber}; ${plan.positions.length} owe${plan.positions.length === 1 ? 's' : ''} fees.${unread}${v4}`;
}
function repeated(receipt: StoredBaseMcpActionReceiptV1, hash: string): BaseMcpUniswapCollectResultV1 {
  if (receipt.actionHash !== hash) return result('This request ID belongs to a different action.', 'base_mcp_action_idempotency_conflict');
  return result('This collect already has an Action Receipt. Check that receipt; the approval request was not sent again.', receipt.errorCode, receipt);
}
function activeCollect(receipt: StoredBaseMcpActionReceiptV1): BaseMcpUniswapCollectResultV1 {
  return result('A collect for this wallet is already in progress. Approve or reject it in your wallet. If its outcome cannot be learned, it stops blocking a new one an hour after its last update.', receipt.errorCode, receipt);
}

/** How long an open collect may block the next one, as for the claim. */
export const UNISWAP_COLLECT_OPEN_TTL_MS_V1 = 60 * 60_000;
const FINAL_STATUSES = ['completed', 'rejected', 'failed'];
function collectAged(receipt: StoredBaseMcpActionReceiptV1, now: string): boolean {
  const age = Date.parse(now) - Date.parse(receipt.updatedAt);
  return Number.isFinite(age) && age >= UNISWAP_COLLECT_OPEN_TTL_MS_V1;
}
async function expireCollect(receipt: StoredBaseMcpActionReceiptV1): Promise<StoredBaseMcpActionReceiptV1 | null> {
  const now = baseMcpUniswapCollectRuntimeV1.now();
  return baseMcpUniswapCollectRuntimeV1.repository.update({ id: receipt.id, tenantId: receipt.tenantId,
    status: 'failed', reconciliationState: 'unavailable', errorCode: 'uniswap_collect_outcome_expired',
    finalizedAt: now, now });
}
async function openCollect(input: CollectInput, wallet: string): Promise<StoredBaseMcpActionReceiptV1 | null> {
  const runtime = baseMcpUniswapCollectRuntimeV1;
  const active = await runtime.repository.getActiveClaim(input.userId, wallet, 'uniswap_collect');
  if (!active || !collectAged(active, runtime.now())) return active;
  if (active.providerRequestId) {
    const checked = await reconcileBaseMcpUniswapCollectV1({ ...input, receipt: active });
    const status = checked.receipt?.status;
    if (status && (status === 'reconciling' || FINAL_STATUSES.includes(status))) {
      return runtime.repository.getActiveClaim(input.userId, wallet, 'uniswap_collect');
    }
  }
  const current = await runtime.repository.get(active.id, active.tenantId);
  if (current && !FINAL_STATUSES.includes(current.status) && current.status !== 'reconciling') await expireCollect(current);
  return runtime.repository.getActiveClaim(input.userId, wallet, 'uniswap_collect');
}

/** The approval's calls: the positions owing fees, the largest first when
 * there are more than one approval holds, each with ERC-8021 attribution. */
export async function uniswapCollectPlanV1(plan: UniswapFeesPlanV1, wallet: string, input: {
  builderCode: string;
  rank: (plan: UniswapFeesPlanV1, wallet: string) => Promise<UniswapFeePositionV1[]>;
}): Promise<UniswapCollectPlanV1> {
  const chosen = plan.positions.length > UNISWAP_COLLECT_LIMIT_V1
    ? (await input.rank(plan, wallet)).slice(0, UNISWAP_COLLECT_LIMIT_V1)
    : plan.positions;
  // ERC-8021 schema 0: ASCII code || byte length || schema id || marker.
  const bytes = Buffer.from(input.builderCode, 'ascii');
  const suffix = `${bytes.toString('hex')}${bytes.length.toString(16).padStart(2, '0')}0080218021802180218021802180218021`;
  return {
    blockNumber: plan.blockNumber,
    positionsHeld: plan.positionsHeld,
    positionsLeft: plan.positions.length - chosen.length,
    calls: chosen.map((position, index) => {
      const call = uniswapCollectCallV1(position.tokenId, wallet, index);
      return { tokenId: position.tokenId, token0: position.token0, token1: position.token1, fee: position.fee,
        amount0: position.amount0, amount1: position.amount1, call: { ...call, data: `${call.data}${suffix}` as Hex } };
    }),
  };
}

export async function prepareBaseMcpUniswapCollectV1(input: CollectInput): Promise<BaseMcpUniswapCollectResultV1> {
  const runtime = baseMcpUniswapCollectRuntimeV1;
  if (!input.idempotencyKey) return result('This action needs a request ID.', 'base_mcp_action_request_id_required');
  if (!input.walletAddress || !/^0x[0-9a-fA-F]{40}$/u.test(input.walletAddress)
    || /^0x0{40}$/u.test(input.walletAddress)) return result('Connect the Base Account that will approve this collect.', 'base_mcp_action_wallet_required');
  const wallet = input.walletAddress.toLowerCase() as Hex;
  const intent = { operation: 'collect' as const, recipient: wallet };
  const hash = baseMcpActionHashV1({ tenantId: input.userId, walletAddress: wallet,
    idempotencyKey: input.idempotencyKey, actionType: 'uniswap_collect', intent });
  if (!await runtime.repository.available()) return result('Action Receipt storage is unavailable.', 'base_mcp_action_storage_unavailable');
  const existing = await runtime.repository.getByIdempotency(input.userId, input.idempotencyKey);
  if (existing) return repeated(existing, hash);
  const active = await openCollect(input, wallet);
  if (active) return activeCollect(active);
  let tools: ToolAggregator | undefined;
  let preparedTools: ToolAggregator | undefined;
  let stored: StoredBaseMcpActionReceiptV1 | null = null;
  let submitted = false;
  try {
    tools = await runtime.createTools(input.req, input.userId, input.sessionSecret, { baseMcpOnly: true });
    const match = await runtime.verifyWallet(tools, wallet);
    if (!match.checked || !match.match) return result('Reconnect Wallet MCP with the same Base Account before collecting.',
      match.checked ? 'base_mcp_wallet_mismatch' : 'base_mcp_wallet_unverified');
    const read = await runtime.readPlan(await runtime.createReader(), wallet);
    const summary = coverage(read);
    if (read.errorCode) return result(`${summary} The collect was not prepared because the positions could not all be read.`, read.errorCode);
    if (!read.positions.length) return result(`${summary} No fees to collect in this wallet's Uniswap v3 positions at that block.`);
    const code = runtime.builderCode();
    if (!code) throw new Error('uniswap_builder_code_unavailable');
    const plan = await uniswapCollectPlanV1(read, wallet, { builderCode: code, rank: runtime.rank });
    const created = await runtime.repository.create({ tenantId: input.userId, walletAddress: wallet,
      idempotencyKey: input.idempotencyKey, actionType: 'uniswap_collect', intent, now: runtime.now() });
    stored = created.receipt;
    if (!created.created) return repeated(stored, hash);
    const simulation = await runtime.simulate(plan, wallet);
    const proof = { collectPlan: plan, simulation, callsHash: hashApprovedCallsV1(plan.calls.map(item => item.call)) };
    if (simulation.status !== 'passed') {
      stored = await runtime.repository.update({ id: stored.id, tenantId: input.userId, status: 'failed',
        reconciliationState: 'not_started', durableProof: proof, errorCode: 'uniswap_simulation_required',
        finalizedAt: runtime.now(), now: runtime.now() });
      return result(`${summary} Simulation ${simulation.status}; no wallet approval was requested.`, 'uniswap_simulation_required', stored);
    }
    stored = await runtime.repository.update({ id: stored.id, tenantId: input.userId, status: 'preparing',
      reconciliationState: 'not_started', durableProof: proof, now: runtime.now() });
    if (!stored) return result('The simulated collect could not be saved.', 'base_mcp_action_storage_failed');
    preparedTools = await runtime.createTools(input.req, input.userId, input.sessionSecret, {
      baseMcpOnly: true, baseMcpPreparedClaim: { actionType: 'uniswap_collect', walletAddress: wallet, calls: plan.calls.map(({ call }) => ({
        to: call.to, value: call.valueWei, data: call.data,
      })) },
    });
    // Check again on the exact kept connection used to submit, after the read.
    const finalMatch = await runtime.verifyWallet(preparedTools, wallet);
    if (!finalMatch.checked || !finalMatch.match) throw new Error('base_mcp_wallet_mismatch');
    const simulationAge = Date.parse(runtime.now()) - Date.parse(simulation.observedAt ?? '');
    if (!simulation.blockNumber || BigInt(simulation.blockNumber) < BigInt(plan.blockNumber)
      || !Number.isFinite(simulationAge) || simulationAge < -5_000 || simulationAge > 60_000) throw new Error('uniswap_simulation_expired');
    submitted = true;
    const called = await preparedTools.callTool('prepared_uniswap_collect', {});
    const snapshot = extractBaseMcpApprovalSnapshot(called.content);
    const state = snapshot.state ?? (snapshot.approvalUrl ? 'approval_required' : 'pending');
    const errorCode = called.isError || !snapshot.requestId ? 'base_mcp_claim_outcome_unknown' : null;
    stored = await runtime.repository.update({ id: stored.id, tenantId: input.userId,
      status: errorCode ? 'pending' : state === 'completed' ? 'reconciling' : state,
      reconciliationState: errorCode ? 'unavailable' : state === 'completed' ? 'pending' : 'not_started',
      providerRequestId: snapshot.requestId ?? null,
      durableProof: { ...proof, ...(snapshot.proof ?? {}) }, errorCode,
      ...(['failed', 'rejected'].includes(state) ? { finalizedAt: runtime.now() } : {}), now: runtime.now() });
    if (errorCode) return result('Wallet MCP did not return a durable request ID. The outcome is uncertain; this collect will not be sent again with the same request ID.', errorCode, stored);
    const left = plan.positionsLeft ? ` ${plan.positionsLeft} more position${plan.positionsLeft === 1 ? '' : 's'} owe${plan.positionsLeft === 1 ? 's' : ''} fees; ask again after this one.` : '';
    return result(`${summary} ${plan.calls.length} collect call${plan.calls.length === 1 ? '' : 's'} passed batch simulation. Review the fees in your wallet: they arrive as each pool's own tokens, WETH as WETH, and the amounts are set when the transaction executes.${left}`,
      stored?.errorCode ?? null, stored, snapshot.approvalUrl ?? null);
  } catch (error) {
    // The partial unique index also protects concurrent requests with
    // DIFFERENT IDs across API workers. A lost race must not send another approval.
    if (!stored) {
      const active = await runtime.repository.getActiveClaim(input.userId, wallet, 'uniswap_collect').catch(() => null);
      if (active) return activeCollect(active);
    }
    const errorCode = error instanceof Error && /^(uniswap|base_mcp)_[a-z_]+$/u.test(error.message)
      ? error.message : 'uniswap_prepare_unavailable';
    if (stored) stored = await runtime.repository.update({ id: stored.id, tenantId: input.userId,
      status: submitted ? 'pending' : 'failed', reconciliationState: submitted ? 'unavailable' : 'not_started',
      errorCode: submitted ? 'base_mcp_claim_outcome_unknown' : errorCode,
      ...(!submitted ? { finalizedAt: runtime.now() } : {}), now: runtime.now() });
    return result(submitted ? 'The submission outcome is uncertain. This collect will not be resubmitted.'
      : 'Uniswap collect preparation did not finish. Nothing was sent to your wallet.',
    submitted ? 'base_mcp_claim_outcome_unknown' : errorCode, stored);
  } finally {
    await preparedTools?.close().catch(() => undefined);
    await tools?.close().catch(() => undefined);
  }
}

/** Each prepared position needs its own Collect event from the pinned
 * manager, paying THIS wallet something. Logs are consumed once. Amounts can
 * grow after simulation (fees keep accruing); an event is not a price promise. */
export function uniswapCollectEventsMatchV1(plan: UniswapCollectPlanV1, wallet: string, receipt: VerifiedReceiptSourceV1): boolean {
  if (!plan.calls.length || receipt.status !== 'success' || receipt.blockNumber < BigInt(plan.blockNumber)) return false;
  const used = new Set<number>();
  return plan.calls.every(item => receipt.logs.some((log, index) => {
    if (used.has(index) || log.address.toLowerCase() !== UNISWAP_V3_POSITION_MANAGER_V1) return false;
    try {
      const decoded = decodeEventLog({ abi: COLLECT_EVENTS, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      const ok = decoded.eventName === 'Collect' && String(decoded.args.tokenId) === item.tokenId
        && decoded.args.recipient.toLowerCase() === wallet.toLowerCase()
        && (decoded.args.amount0 > 0n || decoded.args.amount1 > 0n);
      if (ok) used.add(index);
      return ok;
    } catch { return false; }
  }));
}

export async function reconcileBaseMcpUniswapCollectV1(input: CollectInput & { receipt: StoredBaseMcpActionReceiptV1 }): Promise<BaseMcpUniswapCollectResultV1> {
  const runtime = baseMcpUniswapCollectRuntimeV1;
  const stored = input.receipt;
  if (stored.tenantId !== input.userId || input.walletAddress?.toLowerCase() !== stored.walletAddress) {
    return result('Connect the Base Account that prepared this collect.', 'base_mcp_wallet_mismatch');
  }
  if (FINAL_STATUSES.includes(stored.status)) return result('This Action Receipt is final.', stored.errorCode, stored);
  if (!stored.providerRequestId) {
    if (collectAged(stored, runtime.now())) {
      return result('Miorail could not learn this collect’s outcome, so it no longer blocks a new one. Check your wallet activity before collecting again.',
        'uniswap_collect_outcome_expired', await expireCollect(stored) ?? stored);
    }
    return result('The original submission has no request ID. Miorail will not submit it again; it stops blocking a new collect an hour after its last update.', 'base_mcp_claim_outcome_unknown', stored);
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
      const txHash = proof.txHash;
      const plan = proof.collectPlan as UniswapCollectPlanV1 | undefined;
      const chainReceipt = typeof txHash === 'string' && /^0x[0-9a-fA-F]{64}$/u.test(txHash)
        ? await runtime.receiptReader().getTransactionReceipt(txHash.toLowerCase() as HashV1) : null;
      if (!chainReceipt) { reconciliationState = 'unavailable'; errorCode = 'uniswap_receipt_unavailable'; }
      else {
        transactionHash = chainReceipt.transactionHash;
        blockNumber = String(chainReceipt.blockNumber);
        const matched = transactionHash.toLowerCase() === String(txHash).toLowerCase()
          && plan && uniswapCollectEventsMatchV1(plan, stored.walletAddress, chainReceipt);
        status = matched ? 'completed' : 'failed';
        reconciliationState = matched ? 'matched' : 'mismatched';
        errorCode = matched ? null : 'uniswap_collect_events_mismatch';
      }
    }
    const updated = await runtime.repository.update({ id: stored.id, tenantId: input.userId, status,
      reconciliationState, durableProof: proof, transactionHash, blockNumber, errorCode,
      ...(FINAL_STATUSES.includes(status) ? { finalizedAt: runtime.now() } : {}), now: runtime.now() });
    return result(status === 'completed' ? 'Confirmed on Base: every prepared position has a Collect event paying your wallet.'
      : status === 'reconciling' ? 'Wallet MCP reports completion; the Collect events are not verified yet.'
        : status === 'failed' ? 'The onchain collect facts did not match the prepared action.'
          : status === 'rejected' ? 'The wallet approval was rejected.' : 'The wallet approval is still pending.', errorCode, updated, outcome.approvalUrl ?? null);
  } catch { return result('The receipt could not be checked. No collect was resubmitted.', 'uniswap_reconciliation_unavailable', stored); }
  finally { await tools?.close().catch(() => undefined); }
}
