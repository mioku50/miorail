import { createPublicClient, http, parseAbi, type Address, type Hash } from 'viem';
import { base } from 'viem/chains';

export const BASE_MAINNET_CHAIN_ID = 8453;

const erc20AllowanceAbi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
]);

export type RevokeApprovalProofContext = {
  wallet: string;
  token: string;
  spender: string;
};

export type StateVerifiedAllowanceZeroProof = {
  type: 'state_verified_allowance_zero';
  chainId: 8453;
  wallet: string;
  token: string;
  spender: string;
  allowanceAfter: '0';
  verifiedAt: string;
  note: string;
  source?: 'state_repair';
};

export type WalletReceiptsProof = {
  type: 'wallet_receipts_success' | 'wallet_getCallsStatus';
  chainId: 8453;
  batchId?: string;
  status: 'success';
  receipts: unknown[];
  txHashes: string[];
  verifiedAt: string;
};

export type BaseReceiptProof = {
  type: 'base_receipt_success';
  chainId: 8453;
  txHash: string;
  verifiedAt: string;
};

export type WalletConfirmationReceiptProof = {
  type: 'wallet_confirmation_receipt';
  chainId: 8453;
  txHash?: string;
  batchId?: string;
  receipts?: unknown[];
  statusCode?: number;
  confirmedAt?: string;
  allowanceAfter?: string;
  source: 'metadata.confirmation';
};

export type NormalizedExecutionProof =
  | WalletConfirmationReceiptProof
  | (StateVerifiedAllowanceZeroProof & {
      source: 'state_repair';
      confirmedAt?: string;
      statusCode?: number;
    });

export type ExecutionProof =
  | StateVerifiedAllowanceZeroProof
  | WalletReceiptsProof
  | BaseReceiptProof
  | WalletConfirmationReceiptProof;

type ActionLike = {
  id?: string;
  status?: string;
  executionPayload?: unknown;
  metadata?: unknown;
};

export const actionProofRuntime = {
  async readErc20Allowance(ctx: RevokeApprovalProofContext): Promise<bigint> {
    const rpcUrl = process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';
    const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
    return publicClient.readContract({
      address: ctx.token as Address,
      abi: erc20AllowanceAbi,
      functionName: 'allowance',
      args: [ctx.wallet as Address, ctx.spender as Address],
    });
  },

  async verifyBaseTransactionReceipt(txHash: string): Promise<{ from: string | null; to: string | null }> {
    const rpcUrl = process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';
    const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hash });
    if (receipt.status !== 'success') {
      throw new Error('Base transaction receipt was not successful');
    }

    try {
      const tx = await publicClient.getTransaction({ hash: txHash as Hash });
      return { from: (tx.from as string) ?? null, to: (tx.to as string) ?? null };
    } catch {
      return { from: null, to: null };
    }
  },
};

export function parseMaybeJson<T = any>(value: unknown): T | null {
  if (!value) return null;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function metadataOf(action: ActionLike): Record<string, any> {
  return action.metadata && typeof action.metadata === 'object'
    ? action.metadata as Record<string, any>
    : {};
}

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function extractApproveSpender(data: unknown): string | null {
  if (typeof data !== 'string') return null;
  const clean = data.toLowerCase();
  if (!clean.startsWith('0x095ea7b3') || clean.length < 74) return null;
  const firstArg = clean.slice(10, 74);
  const spender = `0x${firstArg.slice(24)}`;
  return isAddress(spender) ? spender : null;
}

export function getActionType(action: ActionLike): string | null {
  const meta = metadataOf(action);
  const payload = parseMaybeJson<Record<string, any>>(action.executionPayload);
  return typeof meta.actionType === 'string'
    ? meta.actionType
    : typeof payload?.actionType === 'string'
      ? payload.actionType
      : null;
}

export function extractRevokeApprovalProofContext(
  action: ActionLike,
  fallbackWallet?: string | null,
): { context: RevokeApprovalProofContext | null; error?: string } {
  const meta = metadataOf(action);
  const payload = parseMaybeJson<Record<string, any>>(action.executionPayload);
  const firstCall = Array.isArray(payload?.calls) ? payload.calls[0] : null;

  const wallet = meta.walletAddress || meta.wallet || fallbackWallet;
  const token = meta.tokenAddress || firstCall?.to;
  const spender = meta.spender || meta.spenderAddress || extractApproveSpender(firstCall?.data);

  if (!isAddress(wallet)) return { context: null, error: 'Missing revoke wallet address' };
  if (!isAddress(token)) return { context: null, error: 'Missing revoke token address' };
  if (!isAddress(spender)) return { context: null, error: 'Missing revoke spender address' };

  return {
    context: {
      wallet,
      token,
      spender,
    },
  };
}

export function buildStateVerifiedAllowanceZeroProof(
  context: RevokeApprovalProofContext,
  verifiedAt = new Date().toISOString(),
): StateVerifiedAllowanceZeroProof {
  return {
    type: 'state_verified_allowance_zero',
    chainId: BASE_MAINNET_CHAIN_ID,
    wallet: context.wallet,
    token: context.token,
    spender: context.spender,
    allowanceAfter: '0',
    verifiedAt,
    note: 'No wallet tx proof was persisted; final onchain allowance state verified.',
    source: 'state_repair',
  };
}

function receiptStatusSucceeded(status: unknown): boolean {
  if (status === true || status === 1) return true;
  if (typeof status === 'bigint') return status === 1n;
  if (typeof status !== 'string') return false;
  const s = status.toLowerCase();
  return s === 'success' || s === 'successful' || s === 'confirmed' || s === '0x1' || s === '1';
}

export function receiptsAreSuccessful(receipts: unknown): receipts is Record<string, any>[] {
  if (!Array.isArray(receipts) || receipts.length === 0) return false;
  return receipts.every((receipt) => {
    if (!receipt || typeof receipt !== 'object') return false;
    const r = receipt as Record<string, unknown>;
    return receiptStatusSucceeded(r.status ?? r.receiptStatus ?? r.transactionStatus);
  });
}

export function receiptTxHashes(receipts: unknown): string[] {
  if (!Array.isArray(receipts)) return [];
  return receipts
    .map((receipt) => {
      if (!receipt || typeof receipt !== 'object') return null;
      const r = receipt as Record<string, unknown>;
      const hash = r.transactionHash ?? r.txHash ?? r.hash;
      return typeof hash === 'string' && hash.trim().length > 0 ? hash : null;
    })
    .filter((hash): hash is string => Boolean(hash));
}

export function buildWalletReceiptsProof(args: {
  batchId?: string | null;
  receipts: Record<string, any>[];
  verifiedAt?: string;
}): WalletReceiptsProof {
  const batchId = args.batchId?.trim();
  return {
    type: batchId ? 'wallet_getCallsStatus' : 'wallet_receipts_success',
    chainId: BASE_MAINNET_CHAIN_ID,
    ...(batchId ? { batchId } : {}),
    status: 'success',
    receipts: args.receipts,
    txHashes: receiptTxHashes(args.receipts),
    verifiedAt: args.verifiedAt || new Date().toISOString(),
  };
}

export function buildBaseReceiptProof(txHash: string, verifiedAt = new Date().toISOString()): BaseReceiptProof {
  return {
    type: 'base_receipt_success',
    chainId: BASE_MAINNET_CHAIN_ID,
    txHash,
    verifiedAt,
  };
}

function objectOf(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    const s = stringOrUndefined(value);
    if (s) return s;
  }
  return undefined;
}

export function normalizeStateVerifiedAllowanceZeroProof(proof: Record<string, any>): NormalizedExecutionProof | null {
  if (proof.type !== 'state_verified_allowance_zero') return null;
  if (String(proof.allowanceAfter ?? '') !== '0') return null;

  return {
    type: 'state_verified_allowance_zero',
    chainId: BASE_MAINNET_CHAIN_ID,
    wallet: proof.wallet,
    token: proof.token,
    spender: proof.spender,
    allowanceAfter: '0',
    verifiedAt: stringOrUndefined(proof.verifiedAt) || new Date().toISOString(),
    confirmedAt: stringOrUndefined(proof.confirmedAt) || stringOrUndefined(proof.verifiedAt),
    statusCode: numberOrUndefined(proof.statusCode),
    note: stringOrUndefined(proof.note) || 'No wallet tx proof was persisted; final onchain allowance state verified.',
    source: 'state_repair',
  };
}

export function normalizeWalletConfirmationReceiptProof(action: ActionLike): WalletConfirmationReceiptProof | null {
  const meta = metadataOf(action);
  const confirmation = objectOf(meta.confirmation);
  const legacyProof = objectOf(meta.executionProof);
  const receipts = Array.isArray(confirmation.receipts)
    ? confirmation.receipts
    : Array.isArray(meta.receipts)
      ? meta.receipts
      : Array.isArray(legacyProof.receipts)
        ? legacyProof.receipts
        : undefined;
  const receiptHashes = receiptTxHashes(receipts);
  const legacyTxHashes = Array.isArray(legacyProof.txHashes) ? legacyProof.txHashes : [];
  const txHash = firstString([
    confirmation.txHash,
    meta.txHash,
    meta.transactionHash,
    legacyProof.txHash,
    legacyTxHashes[0],
    receiptHashes[0],
  ]);
  const batchId = firstString([
    confirmation.batchId,
    meta.batchId,
    meta.callBatchId,
    legacyProof.batchId,
  ]);
  const statusCode = numberOrUndefined(confirmation.statusCode ?? legacyProof.statusCode);
  const legacyType = stringOrUndefined(legacyProof.type);
  const legacyReceiptProof =
    (legacyType === 'wallet_getCallsStatus' || legacyType === 'wallet_receipts_success') &&
    receiptsAreSuccessful(receipts) &&
    (txHash || batchId);
  const legacyBaseReceiptProof = legacyType === 'base_receipt_success' && Boolean(txHash);
  const confirmationReceiptProof =
    receiptsAreSuccessful(receipts) &&
    (txHash || batchId) &&
    (statusCode === undefined || statusCode === 200);

  if (!confirmationReceiptProof && !legacyReceiptProof && !legacyBaseReceiptProof) {
    return null;
  }

  return {
    type: 'wallet_confirmation_receipt',
    chainId: BASE_MAINNET_CHAIN_ID,
    ...(txHash ? { txHash } : {}),
    ...(batchId ? { batchId } : {}),
    ...(receipts ? { receipts } : {}),
    statusCode: statusCode ?? 200,
    confirmedAt: stringOrUndefined(confirmation.confirmedAt) || stringOrUndefined(legacyProof.verifiedAt),
    allowanceAfter: stringOrUndefined(confirmation.allowanceAfter) || stringOrUndefined(meta.allowanceAfter) || stringOrUndefined(legacyProof.allowanceAfter),
    source: 'metadata.confirmation',
  };
}

export function normalizeExecutedActionProof(action: ActionLike): NormalizedExecutionProof | null {
  const meta = metadataOf(action);
  const stateProof = normalizeStateVerifiedAllowanceZeroProof(objectOf(meta.executionProof));
  if (stateProof) return stateProof;
  return normalizeWalletConfirmationReceiptProof(action);
}

function proofAliases(proof: NormalizedExecutionProof | null): {
  txHash?: string;
  batchId?: string;
  receipts?: unknown[];
} {
  if (!proof) return {};
  return {
    ...('txHash' in proof && proof.txHash ? { txHash: proof.txHash } : {}),
    ...('batchId' in proof && proof.batchId ? { batchId: proof.batchId } : {}),
    ...('receipts' in proof && Array.isArray(proof.receipts) ? { receipts: proof.receipts } : {}),
  };
}

export function getNormalizedProofAliases(action: ActionLike): {
  txHash?: string;
  batchId?: string;
  receipts?: unknown[];
} {
  return proofAliases(normalizeExecutedActionProof(action));
}

function hasAnyPersistedProofField(action: ActionLike): boolean {
  const meta = metadataOf(action);
  const confirmation = meta.confirmation && typeof meta.confirmation === 'object'
    ? meta.confirmation as Record<string, any>
    : {};
  return Boolean(
    meta.executionProof ||
    meta.txHash ||
    meta.transactionHash ||
    meta.batchId ||
    meta.callBatchId ||
    meta.receipts ||
    confirmation.txHash ||
    confirmation.batchId ||
    confirmation.receipts,
  );
}

export function isPollutedExecutedRevokeApproval(action: ActionLike): boolean {
  return action.status === 'executed' &&
    getActionType(action) === 'revoke_approval' &&
    !hasAnyPersistedProofField(action);
}

export async function buildExecutedActionProofRepair(
  action: ActionLike,
  fallbackWallet?: string | null,
): Promise<{
  status: 'executed' | 'submitted_unknown' | 'failed';
  metadata: Record<string, any>;
  executedAt?: Date | null;
} | null> {
  if (action.status !== 'executed') return null;

  const meta = metadataOf(action);
  const normalizedProof = normalizeExecutedActionProof(action);
  if (normalizedProof) {
    const nextMetadata = {
      ...meta,
      executionProof: normalizedProof,
    };
    return JSON.stringify(meta.executionProof) === JSON.stringify(normalizedProof)
      ? null
      : {
          status: 'executed',
          metadata: nextMetadata,
        };
  }

  const verifiedAt = new Date().toISOString();
  if (getActionType(action) !== 'revoke_approval') {
    return {
      status: 'submitted_unknown',
      executedAt: null,
      metadata: {
        ...meta,
        repairError: {
          message: 'Executed action has no durable execution proof.',
          verifiedAt,
        },
      },
    };
  }

  const { context, error } = extractRevokeApprovalProofContext(action, fallbackWallet);
  if (!context) {
    return {
      status: 'submitted_unknown',
      executedAt: null,
      metadata: {
        ...meta,
        repairError: {
          message: error || 'Missing revoke proof context',
          verifiedAt,
        },
      },
    };
  }

  try {
    const allowanceAfter = await actionProofRuntime.readErc20Allowance(context);
    if (allowanceAfter === 0n) {
      return {
        status: 'executed',
        metadata: {
          ...meta,
          executionProof: buildStateVerifiedAllowanceZeroProof(context, verifiedAt),
        },
      };
    }

    return {
      status: 'failed',
      executedAt: null,
      metadata: {
        ...meta,
        repairError: {
          message: 'Revoke action was marked executed, but current allowance is not zero.',
          allowanceAfter: allowanceAfter.toString(),
          verifiedAt,
        },
      },
    };
  } catch (err) {
    return {
      status: 'submitted_unknown',
      executedAt: null,
      metadata: {
        ...meta,
        repairError: {
          message: err instanceof Error ? err.message : 'Allowance read failed during repair',
          verifiedAt,
        },
      },
    };
  }
}

export async function buildPollutedRevokeApprovalRepair(
  action: ActionLike,
  fallbackWallet?: string | null,
): Promise<{
  status: 'executed' | 'submitted_unknown' | 'failed';
  metadata: Record<string, any>;
  executedAt?: Date | null;
} | null> {
  return isPollutedExecutedRevokeApproval(action)
    ? buildExecutedActionProofRepair(action, fallbackWallet)
    : null;
}
