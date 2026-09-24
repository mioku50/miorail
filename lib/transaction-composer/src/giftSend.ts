import { decodeFunctionData, erc20Abi } from 'viem';
import {
  ExecutionBlueprintV1Schema,
  RouteIntentV1Schema,
  RouteProofV1Schema,
  SafetyKernelResultV1Schema,
  ZERO_HASH_V1,
  hashApprovedCallsV1,
  hashExecutionBlueprintV1,
  hashRouteIntentV1,
  hashRouteProofV1,
  stableHashV1,
  type AssetRefV1,
  type ExecutionBlueprintV1,
  type ExecutionCallV1,
  type HashV1,
  type ProviderRefV1,
  type RouteIntentV1,
  type RouteProofV1,
  type SafetyKernelCheckV1,
  type SafetyKernelResultV1,
  type SimulationStateV1,
  type TokenAmountV1,
} from '@mioagent/route-domain';
import type { RouteStorageRepository } from '@mioagent/route-storage';
import {
  appendProofEventIfNewV1,
  approveExecutionBlueprintV1,
  buildApprovedPayload,
  routeProofIdV1,
  type ApproveExecutionBlueprintInput,
  type BlueprintApprovalDependencies,
  type SwapBlueprintApproveResultV1,
} from './approval.js';
import { TransactionComposerBindingError } from './coordinator.js';
import { encodeGiftTransferV1, giftDeclarationFromCallsV1, giftTransferCallV1 } from './gift.js';
import { deriveBlueprintLifecycleV1 } from './lifecycle.js';
import { buildTransactionReviewProjectionV1 } from './reviewProjection.js';
import {
  blockedResultV1,
  preparedResultV1,
  refreshRequiredResultV1,
  type SwapSimulationLookup,
  type TransactionPreparationResultV1,
} from './types.js';

// ---------------------------------------------------------------------------
// A gift from what the wallet already holds.
//
// The first gift was a purchase: swap USDC for the stock, then hand the bought
// amount on. A person who already held the stock was sent through a router to
// buy it again — and on 2026-09-24 that purchase was refused by a rate-limited
// token-risk read about a token they already owned.
//
// A send is the transfer alone: ONE ERC-20 `transfer(recipient, amount)` of a
// reviewed stock, from the giver's wallet. No router, no quote, no slippage,
// no approval — and so no provider guard and no token-risk verdict to ask for,
// because nothing is bought. What it does need, it checks here:
//
//   * the bytes are exactly that transfer — to the declared recipient, for the
//     declared amount, of the reviewed stock, with no native value;
//   * the wallet holds at least that amount, read at prepare AND at approve;
//   * the transfer was simulated from this wallet against Base and did not
//     revert — the issuer's transfer rules apply to a send like any other;
//   * the review has not expired.
//
// Only this kernel ever judges a send Blueprint. The swap approve path refuses
// a Blueprint whose goal is not 'swap', and this one refuses anything else.
// ---------------------------------------------------------------------------

/** Who "routes" a send: nobody. The wallet moves its own tokens. */
export const GIFT_SEND_PROVIDER_V1: ProviderRefV1 = {
  id: 'wallet-transfer',
  displayName: 'Your wallet — a direct transfer',
  kind: 'internal',
  operator: 'Miorail',
};

/**
 * How long a prepared send may be approved.
 *
 * Nothing in a send is quoted, so it is not the twenty seconds of a route
 * card. What ages is the balance and the simulation, and approve reads the
 * balance again; five minutes is the time to read a review and open a wallet.
 */
export const GIFT_SEND_REVIEW_TTL_MS_V1 = 5 * 60_000;

const ZERO_ADDRESS_V1 = '0x0000000000000000000000000000000000000000';
const PERMIT2_ADDRESS_V1 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const CANONICAL_USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
const POSITIVE_ATOMIC_V1 = /^[1-9][0-9]*$/;

function decimalV1(atomic: string, decimals: number): string {
  if (decimals === 0) return atomic;
  const padded = atomic.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** What was read before the send was offered, bound into its Blueprint. */
export interface GiftSendObservationsV1 {
  /** The wallet's balance of the token, and the block it was read at. */
  balance: { balanceAtomic: string; blockNumber: string };
  /** What the amount fetches in USDC right now — the gift range is in dollars. */
  valuation: { usdcAtomic: string; provider: string; observedAt: string };
}

/** The run a send is: its id is the request, so a double click replays it. */
export function giftSendRunIdV1(input: {
  tenantId: string;
  walletAddress: string;
  requestId: string;
  tokenAddress: string;
  amountAtomic: string;
  recipient: string;
}): string {
  return `gift-send:${stableHashV1('gift-send-request/v1', {
    tenantId: input.tenantId,
    walletAddress: input.walletAddress.toLowerCase(),
    requestId: input.requestId,
    tokenAddress: input.tokenAddress.toLowerCase(),
    amountAtomic: input.amountAtomic,
    recipient: input.recipient.toLowerCase(),
  }).slice(2)}`;
}

/** A send, as a RouteIntentV1: one asset out, none in, nothing to optimise. */
export function giftSendIntentV1(input: {
  id: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  token: AssetRefV1;
  amountAtomic: string;
  now: Date;
}): RouteIntentV1 {
  const timestamp = input.now.toISOString();
  const draft: RouteIntentV1 = {
    schemaVersion: 'route-intent/v1',
    id: input.id,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress.toLowerCase() as `0x${string}`,
    chainId: 8453,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'ready',
    intentHash: ZERO_HASH_V1,
    goal: 'send',
    fromAsset: input.token,
    toAsset: null,
    amount: {
      asset: input.token,
      amountAtomic: input.amountAtomic,
      amountDecimal: decimalV1(input.amountAtomic, input.token.decimals),
    },
    optimizationMode: 'simplest_route',
    verificationDepth: 'enhanced',
    protocolConstraint: { mode: 'any', protocols: [] },
    // Nothing is exchanged, so nothing can slip.
    slippageConstraint: { maxBps: 0, source: 'policy' },
    executionRequested: true,
  };
  return RouteIntentV1Schema.parse({ ...draft, intentHash: hashRouteIntentV1(draft) });
}

/**
 * The send's declaration — what the person asked for — as the hash a
 * Blueprint's `selectedCandidateHash` carries. A swap binds the candidate the
 * person chose; a send binds the recipient and amount they typed.
 */
export function giftSendDeclarationHashV1(input: {
  intentHash: string;
  tokenAddress: string;
  recipient: string;
  amountAtomic: string;
}): HashV1 {
  return stableHashV1('gift-send-declaration/v1', {
    intentHash: input.intentHash,
    tokenAddress: input.tokenAddress.toLowerCase(),
    recipient: input.recipient.toLowerCase(),
    amountAtomic: input.amountAtomic,
  });
}

/** The reads a send was offered on, as the hash a Blueprint's
 * `evidenceSetHash` carries. */
export function giftSendEvidenceHashV1(observations: GiftSendObservationsV1): HashV1 {
  return stableHashV1('gift-send-evidence/v1', observations);
}

export function giftSendBlueprintIdV1(input: { runId: string; declarationHash: string }): string {
  return `blueprint:${stableHashV1('gift-send-blueprint/v1', input).slice(2)}`;
}

/** The one call a send is. */
export function giftSendCallsV1(input: { token: AssetRefV1; recipient: `0x${string}`; amountAtomic: string }): ExecutionCallV1[] {
  return [giftTransferCallV1({ index: 0, token: input.token, recipient: input.recipient, amountAtomic: input.amountAtomic })];
}

export function buildGiftSendBlueprintV1(input: {
  id: string;
  intent: RouteIntentV1;
  recipient: `0x${string}`;
  declarationHash: HashV1;
  evidenceHash: HashV1;
  simulationState: SimulationStateV1;
  now: Date;
}): ExecutionBlueprintV1 {
  const token = input.intent.fromAsset;
  if (!token || token.kind !== 'erc20' || !token.address) {
    throw new TransactionComposerBindingError('gift_send_not_erc20', 'A send moves one ERC-20 token');
  }
  const amountAtomic = input.intent.amount.amountAtomic;
  const calls = giftSendCallsV1({ token, recipient: input.recipient, amountAtomic });
  const nowIso = input.now.toISOString();
  const draft: ExecutionBlueprintV1 = {
    schemaVersion: 'execution-blueprint/v1',
    goal: 'send',
    id: input.id,
    tenantId: input.intent.tenantId,
    walletAddress: input.intent.walletAddress,
    chainId: 8453,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'ready_for_review',
    intentHash: input.intent.intentHash,
    selectedCandidateHash: input.declarationHash,
    evidenceSetHash: input.evidenceHash,
    blueprintHash: ZERO_HASH_V1,
    callsHash: hashApprovedCallsV1(calls),
    approvedCallsHash: null,
    quoteExpiry: new Date(input.now.getTime() + GIFT_SEND_REVIEW_TTL_MS_V1).toISOString(),
    calls,
    // The wallet's own movement: the amount leaves it, exactly. What the
    // recipient receives is the transfer itself, which the proof reads from
    // the receipt.
    expectedAssetChanges: [
      {
        asset: token,
        direction: 'debit',
        amountAtomic,
        minimumAmountAtomic: amountAtomic,
        maximumAmountAtomic: amountAtomic,
      },
    ],
    requiredApprovals: [],
    simulationState: input.simulationState,
    atomicRequired: true,
  };
  return ExecutionBlueprintV1Schema.parse({ ...draft, blueprintHash: hashExecutionBlueprintV1(draft) });
}

// ---------------------------------------------------------------------------
// The Gift Send kernel
// ---------------------------------------------------------------------------

export interface GiftSendKernelInputV1 {
  blueprint: ExecutionBlueprintV1;
  intent: RouteIntentV1;
  walletAddress: string;
  /** The recipient the person declared, as the server resolved it. */
  recipient: string;
  /** A Coinbase-issued B20 in the reviewed corpus: read by the caller. */
  reviewedStock: boolean;
  /** The wallet's balance of the token, read now. Null: the read failed. */
  balanceAtomic: string | null;
  now: Date;
}

/** Pure: prepare and approve reach the same verdict over the same facts. */
export function runGiftSendKernelV1(input: GiftSendKernelInputV1): SafetyKernelResultV1 {
  const { blueprint, intent } = input;
  const wallet = input.walletAddress.toLowerCase();
  const recipient = input.recipient.toLowerCase();
  const token = intent.fromAsset?.kind === 'erc20' ? (intent.fromAsset.address?.toLowerCase() ?? null) : null;
  const amount = intent.amount.amountAtomic;
  const checks: SafetyKernelCheckV1[] = [];
  const check = (id: string, description: string, passed: boolean, failure: string) =>
    checks.push({ id, description, status: passed ? 'passed' : 'failed', detail: passed ? null : failure });

  check(
    'send_goal',
    'A gift from your holdings, checked by the gift-send rules only',
    blueprint.goal === 'send' && intent.goal === 'send',
    'This Blueprint is not a gift from holdings',
  );

  const declarationHash = token
    ? giftSendDeclarationHashV1({ intentHash: intent.intentHash, tokenAddress: token, recipient, amountAtomic: amount })
    : null;
  check(
    'send_binding',
    'Bound to this wallet, this send and this recipient',
    blueprint.intentHash === intent.intentHash &&
      blueprint.selectedCandidateHash === declarationHash &&
      blueprint.walletAddress.toLowerCase() === wallet &&
      intent.walletAddress.toLowerCase() === wallet &&
      blueprint.chainId === 8453 &&
      intent.chainId === 8453,
    'The Blueprint is not bound to the send and recipient that were reviewed',
  );

  const call = blueprint.calls.length === 1 ? blueprint.calls[0]! : null;
  check(
    'send_single_transfer',
    'Exactly one call — an ERC-20 transfer — with no approval and no ETH attached',
    Boolean(
      call &&
        call.index === 0 &&
        call.callType === 'transfer' &&
        call.valueWei === '0' &&
        call.spender === null &&
        blueprint.requiredApprovals.length === 0,
    ),
    'A gift from holdings is one transfer call and nothing else',
  );

  check(
    'send_reviewed_stock',
    'The token is a Coinbase-issued stock Miorail has reviewed',
    Boolean(
      input.reviewedStock &&
        token &&
        ADDRESS_V1.test(token) &&
        call &&
        call.to.toLowerCase() === token &&
        call.asset?.assetId === intent.fromAsset?.assetId &&
        intent.amount.asset.assetId === intent.fromAsset?.assetId,
    ),
    'Only a Coinbase-issued tokenized stock Miorail has reviewed can be given here',
  );

  const reserved = new Set(
    [ZERO_ADDRESS_V1, PERMIT2_ADDRESS_V1, CANONICAL_USDC_V1, wallet, token ?? ''].map((address) => address.toLowerCase()),
  );
  check(
    'send_recipient',
    'The recipient is someone else — not this wallet, the token, USDC or the zero address',
    ADDRESS_V1.test(recipient) && !reserved.has(recipient),
    'The recipient must be another person’s address',
  );

  // The bytes, not the labels: decode what the wallet will actually sign.
  let calldataExact = false;
  if (call && token && POSITIVE_ATOMIC_V1.test(amount) && ADDRESS_V1.test(recipient)) {
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data as `0x${string}` });
      const [to, value] = decoded.args as readonly [string, bigint];
      calldataExact =
        decoded.functionName === 'transfer' &&
        call.data.toLowerCase() === encodeGiftTransferV1(recipient as `0x${string}`, amount) &&
        to.toLowerCase() === recipient &&
        value.toString() === amount &&
        call.recipient?.toLowerCase() === recipient &&
        call.amountAtomic === amount;
    } catch {
      calldataExact = false;
    }
  }
  const changes = blueprint.expectedAssetChanges;
  const debitExact =
    changes.length === 1 &&
    changes[0]!.direction === 'debit' &&
    changes[0]!.asset.assetId === intent.fromAsset?.assetId &&
    changes[0]!.amountAtomic === amount &&
    changes[0]!.minimumAmountAtomic === amount &&
    changes[0]!.maximumAmountAtomic === amount;
  check(
    'send_calldata_exact',
    'The calldata transfers exactly the reviewed amount to the reviewed recipient',
    calldataExact && debitExact,
    'The transfer calldata does not send the reviewed amount to the reviewed recipient',
  );

  const balance = input.balanceAtomic;
  const covered = balance !== null && /^[0-9]+$/.test(balance) && POSITIVE_ATOMIC_V1.test(amount) && BigInt(balance) >= BigInt(amount);
  check(
    'send_balance',
    'Your wallet holds at least the amount it gives',
    covered,
    balance === null
      ? 'Miorail could not read this wallet’s balance just now, so nothing is offered to sign. This says nothing about the wallet; try again in a moment.'
      : `This wallet holds ${intent.fromAsset ? decimalV1(balance, intent.fromAsset.decimals) : balance} ${intent.fromAsset?.symbol ?? ''}, less than the ${intent.amount.amountDecimal} this gift sends.`.replace(/\s+,/, ','),
  );

  check(
    'send_not_expired',
    'The review has not expired',
    Date.parse(blueprint.quoteExpiry) > input.now.getTime(),
    'This review has expired; start the gift again',
  );

  check(
    'send_simulation_passed',
    'The transfer was simulated from your wallet against Base and did not revert',
    blueprint.simulationState.status === 'passed',
    blueprint.simulationState.status === 'failed'
      ? 'The transfer reverted in simulation — the token’s own rules refused it, so nothing is offered to sign'
      : 'The transfer could not be simulated just now, and Miorail writes this calldata itself, so it is not offered unsimulated',
  );

  const failed = checks.find((entry) => entry.status === 'failed');
  return SafetyKernelResultV1Schema.parse({
    schemaVersion: 'safety-kernel-result/v1',
    verdict: failed ? 'blocked' : 'allowed',
    checks,
    blockedReason: failed ? failed.detail : null,
  });
}

/** The review a send is shown with, in the shape every review has. */
export function giftSendReviewV1(input: {
  routeRunId: string;
  intent: RouteIntentV1;
  blueprint: ExecutionBlueprintV1;
  safety: SafetyKernelResultV1;
}) {
  // What leaves the wallet is what arrives: the same token, the same amount.
  const moved: TokenAmountV1 = input.intent.amount;
  return buildTransactionReviewProjectionV1({
    routeRunId: input.routeRunId,
    provider: GIFT_SEND_PROVIDER_V1,
    input: moved,
    expectedOutput: moved,
    minimumOutput: moved,
    cardExpectedOutput: moved,
    cardMinimumOutput: moved,
    blueprint: input.blueprint,
    safety: input.safety,
    // Nothing is bought, so no token-risk provider was asked. The stock is one
    // the reviewed corpus names, which the kernel checked above.
    contractSecurity: { provider: 'none', required: false, status: 'skipped', verdicts: [] },
    simulationWarning: null,
  });
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

export interface GiftSendPrepareDependenciesV1 {
  repository: RouteStorageRepository;
  simulate: SwapSimulationLookup;
}

export interface GiftSendPrepareInputV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  requestId: string;
  token: AssetRefV1;
  amountAtomic: string;
  recipient: `0x${string}`;
  /** Read by the gift policy before anything was built. */
  observations: GiftSendObservationsV1;
  reviewedStock: boolean;
  now: Date;
}

export async function prepareGiftSendV1(
  deps: GiftSendPrepareDependenciesV1,
  input: GiftSendPrepareInputV1,
): Promise<TransactionPreparationResultV1> {
  const token = input.token;
  if (token.kind !== 'erc20' || !token.address || token.chainId !== 8453) {
    throw new TransactionComposerBindingError('gift_send_not_erc20', 'A send moves one ERC-20 token on Base');
  }
  const recipient = input.recipient.toLowerCase() as `0x${string}`;
  const runId = giftSendRunIdV1({
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    requestId: input.requestId,
    tokenAddress: token.address,
    amountAtomic: input.amountAtomic,
    recipient,
  });

  // A replay of the same request finds its own run, and its own Blueprint.
  const existing = await deps.repository.getSendRouteRun(runId, input.tenantId);
  const run =
    existing ??
    (await deps.repository.createSendRouteRun(
      giftSendIntentV1({
        id: runId,
        tenantId: input.tenantId,
        walletAddress: input.walletAddress,
        token,
        amountAtomic: input.amountAtomic,
        now: input.now,
      }),
      runId,
    ));
  if (run.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
    throw new TransactionComposerBindingError('wallet_binding_mismatch', 'walletAddress does not match the send run');
  }
  const intent = run.intent;
  const declarationHash = giftSendDeclarationHashV1({
    intentHash: intent.intentHash,
    tokenAddress: token.address,
    recipient,
    amountAtomic: intent.amount.amountAtomic,
  });
  const blueprintId = giftSendBlueprintIdV1({ runId: run.id, declarationHash });

  const stored = (await deps.repository.listBlueprints(run.id, input.tenantId)).find(
    (entry) => entry.blueprint.id === blueprintId,
  )?.blueprint;
  if (stored) {
    if (Date.parse(stored.quoteExpiry) <= input.now.getTime()) {
      return refreshRequiredResultV1(run.id, 'blueprint_expired', 'This gift’s review expired. Start it again to read the balance anew.');
    }
    const safety = runGiftSendKernelV1({
      blueprint: stored,
      intent,
      walletAddress: input.walletAddress,
      recipient,
      reviewedStock: input.reviewedStock,
      balanceAtomic: input.observations.balance.balanceAtomic,
      now: input.now,
    });
    if (safety.verdict === 'blocked') return blockedResultV1(run.id, safety, stored.simulationState);
    return preparedResultV1({ routeRunId: run.id, blueprint: stored, review: giftSendReviewV1({ routeRunId: run.id, intent, blueprint: stored, safety }) });
  }

  // The calls exist before the Blueprint does, so they are simulated first and
  // the Blueprint is built around the simulation of exactly these bytes.
  const calls = giftSendCallsV1({ token, recipient, amountAtomic: intent.amount.amountAtomic });
  const simulationState = await deps.simulate({
    chainId: 8453,
    walletAddress: input.walletAddress.toLowerCase() as `0x${string}`,
    blueprintId,
    callsHash: hashApprovedCallsV1(calls),
    calls,
  });
  const blueprint = buildGiftSendBlueprintV1({
    id: blueprintId,
    intent,
    recipient,
    declarationHash,
    evidenceHash: giftSendEvidenceHashV1(input.observations),
    simulationState,
    now: input.now,
  });
  const safety = runGiftSendKernelV1({
    blueprint,
    intent,
    walletAddress: input.walletAddress,
    recipient,
    reviewedStock: input.reviewedStock,
    balanceAtomic: input.observations.balance.balanceAtomic,
    now: input.now,
  });
  // A refused send is not stored: there is nothing anyone may approve.
  if (safety.verdict === 'blocked') return blockedResultV1(run.id, safety, simulationState);
  await deps.repository.insertSendBlueprint(run.id, blueprint);
  return preparedResultV1({ routeRunId: run.id, blueprint, review: giftSendReviewV1({ routeRunId: run.id, intent, blueprint, safety }) });
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

export interface GiftSendApprovalDependenciesV1 {
  repository: RouteStorageRepository;
  /** The wallet's balance of the token now; null when it cannot be read. */
  readBalance: (input: { tokenAddress: `0x${string}`; walletAddress: `0x${string}` }) => Promise<string | null>;
  reviewedStock: (tokenAddress: string) => Promise<boolean>;
}

function pendingSendProofV1(blueprint: ExecutionBlueprintV1, now: Date): RouteProofV1 {
  const debit = blueprint.expectedAssetChanges[0]!;
  const nowIso = now.toISOString();
  const draft: RouteProofV1 = {
    schemaVersion: 'route-proof/v1',
    id: routeProofIdV1(blueprint.id),
    tenantId: blueprint.tenantId,
    walletAddress: blueprint.walletAddress,
    chainId: blueprint.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'pending',
    intentHash: blueprint.intentHash,
    selectedCandidateHash: blueprint.selectedCandidateHash,
    evidenceSetHash: blueprint.evidenceSetHash,
    blueprintHash: blueprint.blueprintHash,
    approvedCallsHash: blueprint.approvedCallsHash!,
    proofHash: ZERO_HASH_V1,
    approvedCalls: blueprint.calls,
    // The output of a gift is what the recipient receives: the same token and
    // amount that leaves the wallet, delivered by the one transfer.
    expectedResult: {
      assetChanges: blueprint.expectedAssetChanges,
      outputAmountAtomic: debit.amountAtomic,
      outputAsset: debit.asset,
    },
    actualResult: null,
    // Not estimated: nothing quoted this transfer. The receipt's gas is what
    // the proof records once it is read — the same convention as every
    // provider that returns no estimate.
    estimatedGas: { gasUnits: '0', maxFeePerGasWei: null, estimatedCostNative: null, estimatedCostUsd: null },
    actualGas: null,
    deviation: { outputBps: null, gasCostUsd: null, withinTolerance: null },
    transactionHashes: [],
    receipts: [],
    finalStatus: 'pending',
    reconciliationState: 'pending',
  };
  return RouteProofV1Schema.parse({ ...draft, proofHash: hashRouteProofV1(draft) });
}

/**
 * Re-validates a STORED send Blueprint through the Gift Send kernel — with the
 * wallet's balance read again, now — and, if it still holds, approves it and
 * opens its pending Route Proof. The server never signs or broadcasts here;
 * the response carries only the stored calls, bound to their hash.
 */
export async function approveGiftSendBlueprintV1(
  deps: GiftSendApprovalDependenciesV1,
  input: ApproveExecutionBlueprintInput,
): Promise<SwapBlueprintApproveResultV1> {
  const { repository } = deps;
  const run = await repository.getSendRouteRun(input.routeRunId, input.tenantId);
  if (!run) {
    throw new TransactionComposerBindingError('route_run_not_found', 'Send run does not exist for this tenant');
  }
  if (run.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
    throw new TransactionComposerBindingError('wallet_binding_mismatch', 'walletAddress does not match the send run');
  }
  if (run.chainId !== 8453) {
    throw new TransactionComposerBindingError('unsupported_chain', 'Send run is not on Base mainnet');
  }
  const stored = (await repository.listBlueprints(input.routeRunId, input.tenantId)).find(
    (entry) => entry.blueprint.id === input.blueprintId,
  );
  if (!stored) {
    throw new TransactionComposerBindingError('blueprint_not_found', 'Blueprint was not found for this send run');
  }
  const blueprint = stored.blueprint;
  if (blueprint.goal !== 'send') {
    throw new TransactionComposerBindingError('goal_mismatch', 'Blueprint goal is not send');
  }
  if (blueprint.blueprintHash !== input.blueprintHash) {
    throw new TransactionComposerBindingError('blueprint_hash_mismatch', 'blueprintHash does not match the stored Blueprint');
  }
  if (blueprint.intentHash !== run.intentHash) {
    throw new TransactionComposerBindingError('blueprint_intent_mismatch', 'Blueprint intent hash does not match the send run');
  }
  if (blueprint.blueprintHash !== hashExecutionBlueprintV1(blueprint)) {
    throw new TransactionComposerBindingError('blueprint_hash_invalid', 'Stored Blueprint content hash is invalid');
  }
  const callsHash = hashApprovedCallsV1(blueprint.calls);
  if (blueprint.callsHash !== callsHash) {
    throw new TransactionComposerBindingError('blueprint_calls_hash_invalid', 'Stored Blueprint calls hash is invalid');
  }
  if (Date.parse(blueprint.quoteExpiry) <= input.now.getTime()) {
    return { outcome: 'expired', reason: 'This gift’s review has expired and can no longer be approved' };
  }

  let approved: ExecutionBlueprintV1;
  if (blueprint.status === 'approved' && blueprint.approvedCallsHash === callsHash) {
    approved = blueprint;
  } else {
    if (blueprint.status !== 'ready_for_review') {
      const detail = `Blueprint status ${blueprint.status} is not approvable`;
      return {
        outcome: 'blocked',
        reason: detail,
        safety: SafetyKernelResultV1Schema.parse({
          schemaVersion: 'safety-kernel-result/v1',
          verdict: 'blocked',
          checks: [{ id: 'blueprint_status', description: 'Blueprint must be ready_for_review or already approved to be approvable', status: 'failed', detail }],
          blockedReason: detail,
        }),
      };
    }
    const declaration = giftDeclarationFromCallsV1(blueprint.calls);
    const token = run.intent.fromAsset?.kind === 'erc20' ? run.intent.fromAsset.address : null;
    const balanceAtomic = token
      ? await deps.readBalance({
          tokenAddress: token.toLowerCase() as `0x${string}`,
          walletAddress: input.walletAddress.toLowerCase() as `0x${string}`,
        }).catch(() => null)
      : null;
    const safety = runGiftSendKernelV1({
      blueprint,
      intent: run.intent,
      walletAddress: input.walletAddress,
      // The stored call's own recipient: the binding check then proves it is
      // the one the declaration hash was made from.
      recipient: declaration?.recipient ?? '',
      reviewedStock: token ? await deps.reviewedStock(token).catch(() => false) : false,
      balanceAtomic,
      now: input.now,
    });
    if (safety.verdict === 'blocked') {
      return { outcome: 'blocked', reason: safety.blockedReason ?? 'The gift-send rules refused this Blueprint', safety };
    }
    approved = ExecutionBlueprintV1Schema.parse({
      ...blueprint,
      status: 'approved',
      approvedCallsHash: callsHash,
      updatedAt: input.now.toISOString(),
    });
    await repository.approveBlueprint(input.routeRunId, blueprint.id, input.tenantId, approved);
  }

  // Pending proof + calls_approved, idempotent: a retry never regresses a
  // proof that has already recorded a submission.
  const proofId = routeProofIdV1(approved.id);
  let proof = await repository.getProofProjection(proofId, input.tenantId);
  if (!proof) {
    proof = pendingSendProofV1(approved, input.now);
    await repository.upsertProofProjection(input.routeRunId, proof);
  }
  const existingEvents = await repository.listProofEvents(proof.id, input.tenantId);
  const events = await appendProofEventIfNewV1(
    repository,
    proof,
    existingEvents,
    'calls_approved',
    { blueprintId: approved.id, blueprintHash: approved.blueprintHash, approvedCallsHash: approved.approvedCallsHash },
    input.now,
  );
  const lifecycle = deriveBlueprintLifecycleV1({ blueprint: approved, proof, events });
  return { outcome: 'approved', payload: buildApprovedPayload(approved, run.walletAddress as `0x${string}`), lifecycle };
}

/**
 * The one approve route for route-family Blueprints: a send run goes to the
 * Gift Send kernel, and everything else to the swap kernel — which refuses a
 * Blueprint whose goal is not 'swap' on its own as well. Decided by the RUN,
 * which only createSendRouteRun can make a send.
 */
export async function approveRouteBlueprintV1(
  deps: {
    repository: RouteStorageRepository;
    swap: Omit<BlueprintApprovalDependencies, 'repository'>;
    send: Omit<GiftSendApprovalDependenciesV1, 'repository'>;
  },
  input: ApproveExecutionBlueprintInput,
): Promise<SwapBlueprintApproveResultV1> {
  if (await deps.repository.getSendRouteRun(input.routeRunId, input.tenantId)) {
    return approveGiftSendBlueprintV1({ repository: deps.repository, ...deps.send }, input);
  }
  return approveExecutionBlueprintV1({ repository: deps.repository, ...deps.swap }, input);
}
