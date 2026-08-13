import crypto from 'node:crypto';
import { client } from '@mioagent/db';
import { stableHashV1, type HashV1 } from '@mioagent/route-domain';
import {
  BaseMcpActionReceiptV1Schema,
  BaseMcpActionReceiptStatusV1Schema,
} from '@mioagent/api-zod';
import type { z } from 'zod';

export type BaseMcpActionReceiptStatusV1 = z.infer<typeof BaseMcpActionReceiptStatusV1Schema>;
export type BaseMcpActionReconciliationStateV1 =
  | 'not_started'
  | 'pending'
  | 'matched'
  | 'provider_confirmed'
  | 'mismatched'
  | 'unavailable';

export interface BaseMcpSendActionIntentV1 {
  asset: {
    symbol: 'USDC';
    address: `0x${string}`;
    decimals: 6;
  };
  amount: string;
  amountAtomic: string;
  recipient: `0x${string}`;
  /** Original Basename when resolution was used. Null for a literal address;
   * optional only so receipts created before this additive field still parse. */
  recipientName?: string | null;
}

export interface BaseMcpX402ActionIntentV1 {
  method: 'GET';
  url: string;
  maxPayment: string;
  maxPaymentAtomic: string;
  paymentAsset: {
    symbol: 'USDC';
    address: `0x${string}`;
    decimals: 6;
  };
}

export type BaseMcpActionIntentV1 = BaseMcpSendActionIntentV1 | BaseMcpX402ActionIntentV1;
export type BaseMcpActionTypeV1 = 'send' | 'x402';

export function baseMcpActionHashV1(input: {
  tenantId: string;
  walletAddress: `0x${string}`;
  idempotencyKey: string;
  actionType: BaseMcpActionTypeV1;
  intent: BaseMcpActionIntentV1;
}): HashV1 {
  return stableHashV1(`base-mcp-action-${input.actionType}/v1`, {
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: 8453,
    intent: input.intent,
    idempotencyKey: input.idempotencyKey,
  });
}

export interface StoredBaseMcpActionReceiptV1 {
  id: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453;
  schemaVersion: 'base-mcp-action-receipt/v1';
  actionType: BaseMcpActionTypeV1;
  provider: 'base-mcp';
  status: BaseMcpActionReceiptStatusV1;
  idempotencyKey: string;
  actionHash: HashV1;
  providerRequestId: string | null;
  intent: BaseMcpActionIntentV1;
  durableProof: Record<string, unknown> | null;
  reconciliationState: BaseMcpActionReconciliationStateV1;
  transactionHash: HashV1 | null;
  blockNumber: string | null;
  responseHash: HashV1 | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  /** Internal compare-and-swap cursor. Never included in the public schema. */
  nextEventSequence?: number;
}

export interface BaseMcpActionReceiptRepositoryV1 {
  available(): Promise<boolean>;
  create(input: {
    tenantId: string;
    walletAddress: `0x${string}`;
    idempotencyKey: string;
    actionType: BaseMcpActionTypeV1;
    intent: BaseMcpActionIntentV1;
    now: string;
  }): Promise<{ receipt: StoredBaseMcpActionReceiptV1; created: boolean }>;
  get(id: string, tenantId: string): Promise<StoredBaseMcpActionReceiptV1 | null>;
  update(input: {
    id: string;
    tenantId: string;
    status: BaseMcpActionReceiptStatusV1;
    reconciliationState: BaseMcpActionReconciliationStateV1;
    providerRequestId?: string | null;
    durableProof?: Record<string, unknown> | null;
    transactionHash?: HashV1 | null;
    blockNumber?: string | null;
    responseHash?: HashV1 | null;
    errorCode?: string | null;
    finalizedAt?: string | null;
    now: string;
  }): Promise<StoredBaseMcpActionReceiptV1 | null>;
  list(tenantId: string, limit?: number): Promise<StoredBaseMcpActionReceiptV1[]>;
}

const BASE_MCP_ACTION_STATUS_TRANSITIONS_V1: Readonly<
  Record<BaseMcpActionReceiptStatusV1, ReadonlySet<BaseMcpActionReceiptStatusV1>>
> = {
  preparing: new Set(['preparing', 'approval_required', 'pending', 'reconciling', 'completed', 'rejected', 'failed']),
  approval_required: new Set(['approval_required', 'pending', 'reconciling', 'completed', 'rejected', 'failed']),
  pending: new Set(['approval_required', 'pending', 'reconciling', 'completed', 'rejected', 'failed']),
  reconciling: new Set(['reconciling', 'completed', 'failed']),
  completed: new Set(['completed']),
  rejected: new Set(['rejected']),
  failed: new Set(['failed']),
};

/** Terminal receipts and onchain reconciliation never move backwards when two
 * browser checks race each other. */
export function baseMcpActionStatusTransitionAllowedV1(
  from: BaseMcpActionReceiptStatusV1,
  to: BaseMcpActionReceiptStatusV1,
): boolean {
  return BASE_MCP_ACTION_STATUS_TRANSITIONS_V1[from].has(to);
}

function rowToStored(row: Record<string, unknown>): StoredBaseMcpActionReceiptV1 {
  const value = (camel: string, snake: string) => row[camel] ?? row[snake];
  return {
    id: String(row.id),
    tenantId: String(value('tenantId', 'tenant_id')),
    walletAddress: String(value('walletAddress', 'wallet_address')).toLowerCase() as `0x${string}`,
    chainId: 8453,
    schemaVersion: 'base-mcp-action-receipt/v1',
    actionType: String(value('actionType', 'action_type')) as BaseMcpActionTypeV1,
    provider: 'base-mcp',
    status: String(row.status) as BaseMcpActionReceiptStatusV1,
    idempotencyKey: String(value('idempotencyKey', 'idempotency_key')),
    actionHash: String(value('actionHash', 'action_hash')) as HashV1,
    providerRequestId: value('providerRequestId', 'provider_request_id') == null
      ? null
      : String(value('providerRequestId', 'provider_request_id')),
    intent: (typeof value('intent', 'intent_payload') === 'string'
      ? JSON.parse(String(value('intent', 'intent_payload')))
      : value('intent', 'intent_payload')) as BaseMcpActionIntentV1,
    durableProof: value('durableProof', 'durable_proof') == null
      ? null
      : (typeof value('durableProof', 'durable_proof') === 'string'
        ? JSON.parse(String(value('durableProof', 'durable_proof')))
        : value('durableProof', 'durable_proof')) as Record<string, unknown>,
    reconciliationState: String(value('reconciliationState', 'reconciliation_state')) as BaseMcpActionReconciliationStateV1,
    transactionHash: value('transactionHash', 'transaction_hash') == null
      ? null
      : String(value('transactionHash', 'transaction_hash')) as HashV1,
    blockNumber: value('blockNumber', 'block_number') == null ? null : String(value('blockNumber', 'block_number')),
    responseHash: value('responseHash', 'response_hash') == null
      ? null
      : String(value('responseHash', 'response_hash')) as HashV1,
    errorCode: value('errorCode', 'error_code') == null ? null : String(value('errorCode', 'error_code')),
    createdAt: new Date(String(value('createdAt', 'created_at'))).toISOString(),
    updatedAt: new Date(String(value('updatedAt', 'updated_at'))).toISOString(),
    finalizedAt: value('finalizedAt', 'finalized_at') == null
      ? null
      : new Date(String(value('finalizedAt', 'finalized_at'))).toISOString(),
    nextEventSequence: Number(value('nextEventSequence', 'next_event_sequence') ?? 0),
  };
}

function receiptEventV1(receipt: StoredBaseMcpActionReceiptV1) {
  const id = `base-mcp-action-event:${crypto.randomUUID()}`;
  const eventHash = stableHashV1('base-mcp-action-receipt-event/v1', {
    id,
    receiptId: receipt.id,
    tenantId: receipt.tenantId,
    status: receipt.status,
    reconciliationState: receipt.reconciliationState,
    transactionHash: receipt.transactionHash,
    errorCode: receipt.errorCode,
    createdAt: receipt.updatedAt,
  });
  return {
    id,
    eventHash,
    payload: {
      reconciliationState: receipt.reconciliationState,
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      responseHash: receipt.responseHash,
      errorCode: receipt.errorCode,
    },
  };
}

export class PostgresBaseMcpActionReceiptRepositoryV1 implements BaseMcpActionReceiptRepositoryV1 {
  async available(): Promise<boolean> {
    try {
      const rows = await client`SELECT to_regclass('public.base_mcp_action_receipts') AS name`;
      return Boolean(rows[0]?.name);
    } catch {
      return false;
    }
  }

  async create(input: {
    tenantId: string;
    walletAddress: `0x${string}`;
    idempotencyKey: string;
    actionType: BaseMcpActionTypeV1;
    intent: BaseMcpActionIntentV1;
    now: string;
  }): Promise<{ receipt: StoredBaseMcpActionReceiptV1; created: boolean }> {
    const id = `base-mcp-action:${crypto.randomUUID()}`;
    const actionHash = baseMcpActionHashV1(input);
    const preparingReceipt: StoredBaseMcpActionReceiptV1 = {
      id,
      tenantId: input.tenantId,
      walletAddress: input.walletAddress,
      chainId: 8453,
      schemaVersion: 'base-mcp-action-receipt/v1',
      actionType: input.actionType,
      provider: 'base-mcp',
      status: 'preparing',
      idempotencyKey: input.idempotencyKey,
      actionHash,
      providerRequestId: null,
      intent: input.intent,
      durableProof: null,
      reconciliationState: 'not_started',
      transactionHash: null,
      blockNumber: null,
      responseHash: null,
      errorCode: null,
      createdAt: input.now,
      updatedAt: input.now,
      finalizedAt: null,
      nextEventSequence: 1,
    };
    const event = receiptEventV1(preparingReceipt);
    const rows = await client`
      WITH inserted AS (
        INSERT INTO base_mcp_action_receipts (
          id, tenant_id, wallet_address, chain_id, schema_version, action_type,
          provider, status, idempotency_key, action_hash, intent_payload,
          reconciliation_state, next_event_sequence, created_at, updated_at
        ) VALUES (
          ${id}, ${input.tenantId}, ${input.walletAddress}, 8453,
          'base-mcp-action-receipt/v1', ${input.actionType}, 'base-mcp', 'preparing',
          ${input.idempotencyKey}, ${actionHash}, ${JSON.stringify(input.intent)}::jsonb,
          'not_started', 1, ${input.now}::timestamptz, ${input.now}::timestamptz
        )
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING *
      ), event_inserted AS (
        INSERT INTO base_mcp_action_receipt_events (
          id, receipt_id, tenant_id, sequence, event_hash, status, payload, created_at
        )
        SELECT
          ${event.id}, inserted.id, inserted.tenant_id, 0,
          ${event.eventHash}, inserted.status, ${JSON.stringify(event.payload)}::jsonb,
          inserted.updated_at
        FROM inserted
        RETURNING receipt_id
      )
      SELECT inserted.*
      FROM inserted
      JOIN event_inserted ON event_inserted.receipt_id = inserted.id
    `;
    const created = rows.length > 0;
    const receipt = created
      ? rowToStored(rows[0])
      : await this.getByIdempotency(input.tenantId, input.idempotencyKey);
    if (!receipt) throw new Error('base_mcp_action_receipt_create_failed');
    return { receipt, created };
  }

  private async getByIdempotency(tenantId: string, idempotencyKey: string): Promise<StoredBaseMcpActionReceiptV1 | null> {
    const rows = await client`
      SELECT *
      FROM base_mcp_action_receipts
      WHERE tenant_id = ${tenantId} AND idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return rows[0] ? rowToStored(rows[0]) : null;
  }

  async get(id: string, tenantId: string): Promise<StoredBaseMcpActionReceiptV1 | null> {
    const rows = await client`
      SELECT *
      FROM base_mcp_action_receipts
      WHERE id = ${id} AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    return rows[0] ? rowToStored(rows[0]) : null;
  }

  async update(input: {
    id: string;
    tenantId: string;
    status: BaseMcpActionReceiptStatusV1;
    reconciliationState: BaseMcpActionReconciliationStateV1;
    providerRequestId?: string | null;
    durableProof?: Record<string, unknown> | null;
    transactionHash?: HashV1 | null;
    blockNumber?: string | null;
    responseHash?: HashV1 | null;
    errorCode?: string | null;
    finalizedAt?: string | null;
    now: string;
  }): Promise<StoredBaseMcpActionReceiptV1 | null> {
    const current = await this.get(input.id, input.tenantId);
    if (!current) return null;
    if (!baseMcpActionStatusTransitionAllowedV1(current.status, input.status)) return current;
    const next: StoredBaseMcpActionReceiptV1 = {
      ...current,
      status: input.status,
      reconciliationState: input.reconciliationState,
      providerRequestId: input.providerRequestId ?? current.providerRequestId,
      durableProof: input.durableProof ?? current.durableProof,
      transactionHash: input.transactionHash ?? current.transactionHash,
      blockNumber: input.blockNumber ?? current.blockNumber,
      responseHash: input.responseHash ?? current.responseHash,
      errorCode: input.errorCode === undefined ? current.errorCode : input.errorCode,
      finalizedAt: input.finalizedAt ?? current.finalizedAt,
      updatedAt: input.now,
      nextEventSequence: (current.nextEventSequence ?? 0) + 1,
    };
    const event = receiptEventV1(next);
    const durableProof = next.durableProof === null ? null : JSON.stringify(next.durableProof);
    const rows = await client`
      WITH updated AS (
        UPDATE base_mcp_action_receipts
        SET status = ${next.status},
            reconciliation_state = ${next.reconciliationState},
            provider_request_id = ${next.providerRequestId},
            durable_proof = ${durableProof}::jsonb,
            transaction_hash = ${next.transactionHash},
            block_number = ${next.blockNumber},
            response_hash = ${next.responseHash},
            error_code = ${next.errorCode},
            finalized_at = ${next.finalizedAt}::timestamptz,
            updated_at = ${next.updatedAt}::timestamptz,
            next_event_sequence = next_event_sequence + 1
        WHERE id = ${input.id}
          AND tenant_id = ${input.tenantId}
          AND status = ${current.status}
          AND next_event_sequence = ${current.nextEventSequence ?? 0}
        RETURNING *
      ), event_inserted AS (
        INSERT INTO base_mcp_action_receipt_events (
          id, receipt_id, tenant_id, sequence, event_hash, status, payload, created_at
        )
        SELECT
          ${event.id}, updated.id, updated.tenant_id,
          updated.next_event_sequence - 1,
          ${event.eventHash}, updated.status, ${JSON.stringify(event.payload)}::jsonb,
          updated.updated_at
        FROM updated
        RETURNING receipt_id
      )
      SELECT updated.*
      FROM updated
      JOIN event_inserted ON event_inserted.receipt_id = updated.id
    `;
    // A concurrent request may already have advanced the same receipt. Return
    // that newer state instead of treating a refused regression as missing.
    if (!rows[0]) return this.get(input.id, input.tenantId);
    return rowToStored(rows[0]);
  }

  async list(tenantId: string, limit = 20): Promise<StoredBaseMcpActionReceiptV1[]> {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await client`
      SELECT *
      FROM base_mcp_action_receipts
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT ${bounded}
    `;
    return rows.map(rowToStored);
  }
}

export class InMemoryBaseMcpActionReceiptRepositoryV1 implements BaseMcpActionReceiptRepositoryV1 {
  availableValue = true;
  private rows = new Map<string, StoredBaseMcpActionReceiptV1>();

  async available(): Promise<boolean> {
    return this.availableValue;
  }

  async create(input: {
    tenantId: string;
    walletAddress: `0x${string}`;
    idempotencyKey: string;
    actionType: BaseMcpActionTypeV1;
    intent: BaseMcpActionIntentV1;
    now: string;
  }): Promise<{ receipt: StoredBaseMcpActionReceiptV1; created: boolean }> {
    const existing = [...this.rows.values()].find(
      (row) => row.tenantId === input.tenantId && row.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return { receipt: structuredClone(existing), created: false };
    const id = `base-mcp-action:${crypto.randomUUID()}`;
    const receipt: StoredBaseMcpActionReceiptV1 = {
      id,
      tenantId: input.tenantId,
      walletAddress: input.walletAddress,
      chainId: 8453,
      schemaVersion: 'base-mcp-action-receipt/v1',
      actionType: input.actionType,
      provider: 'base-mcp',
      status: 'preparing',
      idempotencyKey: input.idempotencyKey,
      actionHash: baseMcpActionHashV1(input),
      providerRequestId: null,
      intent: structuredClone(input.intent),
      durableProof: null,
      reconciliationState: 'not_started',
      transactionHash: null,
      blockNumber: null,
      responseHash: null,
      errorCode: null,
      createdAt: input.now,
      updatedAt: input.now,
      finalizedAt: null,
      nextEventSequence: 1,
    };
    this.rows.set(id, receipt);
    return { receipt: structuredClone(receipt), created: true };
  }

  async get(id: string, tenantId: string): Promise<StoredBaseMcpActionReceiptV1 | null> {
    const row = this.rows.get(id);
    return row?.tenantId === tenantId ? structuredClone(row) : null;
  }

  async update(input: {
    id: string;
    tenantId: string;
    status: BaseMcpActionReceiptStatusV1;
    reconciliationState: BaseMcpActionReconciliationStateV1;
    providerRequestId?: string | null;
    durableProof?: Record<string, unknown> | null;
    transactionHash?: HashV1 | null;
    blockNumber?: string | null;
    responseHash?: HashV1 | null;
    errorCode?: string | null;
    finalizedAt?: string | null;
    now: string;
  }): Promise<StoredBaseMcpActionReceiptV1 | null> {
    const row = this.rows.get(input.id);
    if (!row || row.tenantId !== input.tenantId) return null;
    if (!baseMcpActionStatusTransitionAllowedV1(row.status, input.status)) {
      return structuredClone(row);
    }
    const updated: StoredBaseMcpActionReceiptV1 = {
      ...row,
      status: input.status,
      reconciliationState: input.reconciliationState,
      providerRequestId: input.providerRequestId ?? row.providerRequestId,
      durableProof: input.durableProof ?? row.durableProof,
      transactionHash: input.transactionHash ?? row.transactionHash,
      blockNumber: input.blockNumber ?? row.blockNumber,
      responseHash: input.responseHash ?? row.responseHash,
      errorCode: input.errorCode === undefined ? row.errorCode : input.errorCode,
      finalizedAt: input.finalizedAt ?? row.finalizedAt,
      updatedAt: input.now,
      nextEventSequence: (row.nextEventSequence ?? 0) + 1,
    };
    this.rows.set(input.id, updated);
    return structuredClone(updated);
  }

  async list(tenantId: string, limit = 20): Promise<StoredBaseMcpActionReceiptV1[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }
}

export function publicBaseMcpActionReceiptV1(receipt: StoredBaseMcpActionReceiptV1) {
  const common = {
    schemaVersion: receipt.schemaVersion,
    id: receipt.id,
    actionHash: receipt.actionHash,
    actionType: receipt.actionType,
    provider: receipt.provider,
    chainId: receipt.chainId,
    walletAddress: receipt.walletAddress,
    status: receipt.status,
    capabilityPolicy: 'passed',
    approvalRequired: true,
    reconciliationState: receipt.reconciliationState,
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    errorCode: receipt.errorCode,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
    finalizedAt: receipt.finalizedAt,
    routeVerified: false,
  };
  if (receipt.actionType === 'x402') {
    const intent = receipt.intent as BaseMcpX402ActionIntentV1;
    return BaseMcpActionReceiptV1Schema.parse({
      ...common,
      actionType: 'x402',
      method: intent.method,
      url: intent.url,
      maxPayment: intent.maxPayment,
      paymentAsset: intent.paymentAsset,
      responseHash: receipt.responseHash,
      reconciliationBasis: 'x402_endpoint_response',
    });
  }
  const intent = receipt.intent as BaseMcpSendActionIntentV1;
  return BaseMcpActionReceiptV1Schema.parse({
    ...common,
    actionType: 'send',
    asset: intent.asset,
    amount: intent.amount,
    recipient: intent.recipient,
    recipientName: intent.recipientName ?? null,
    reconciliationBasis: 'erc20_transfer_event',
  });
}
