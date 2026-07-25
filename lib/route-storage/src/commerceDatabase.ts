import type {
  CommerceCandidateV1,
  CommerceEvidenceV1,
  CommerceOrderEventV1,
  CommerceOrderV1,
  CommerceRouteCardV1,
  CommerceRouteIntentV1,
  CommerceRouteProofV1,
} from '@mioagent/route-domain';
import {
  RouteStorageConflictError,
  RouteStorageIntegrityError,
  type SqlTemplateExecutor,
} from './types.js';
import {
  assertCommerceTenantV1,
  parseCommerceCandidateV1,
  parseCommerceEvidenceV1,
  parseCommerceIntentV1,
  parseCommerceOrderEventV1,
  parseCommerceOrderV1,
  parseCommerceProofV1,
  parseCommerceRouteCardV1,
  type CommerceHistoryItemV1,
  type CommerceOrderRecordV1,
  type CommerceOrderRowStatusV1,
  type CommerceRouteRunRecordV1,
  type CommerceStorageRepository,
  type ReserveCommerceOrderInputV1,
  type ReserveCommerceOrderResultV1,
} from './commerce.js';

// ---------------------------------------------------------------------------
// Postgres-backed CommerceStorageRepository.
//
// The idempotency guarantee is enforced by the DATABASE, not by application
// logic: `commerce_orders_user_idempotency_unique` plus
// `INSERT … ON CONFLICT DO NOTHING` means two concurrent checkouts race for one
// row, and the loser is told a reservation already exists. Only the winner
// calls the provider, so a second invoice cannot be opened even under a
// double-submit or a retry storm.
// ---------------------------------------------------------------------------

function jsonb(value: unknown): string {
  return JSON.stringify(value);
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function iso(value: unknown): string {
  return isoOrNull(value) ?? new Date(0).toISOString();
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function orderFromRow(row: Record<string, unknown>): CommerceOrderRecordV1 {
  const payload = row.payload;
  return {
    id: String(row.id),
    routeRunId: String(row.route_run_id),
    userId: String(row.user_id),
    walletAddress: String(row.wallet_address),
    routeCardHash: String(row.route_card_hash),
    candidateHash: String(row.candidate_hash),
    productId: String(row.product_id),
    packageValue: String(row.package_value),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as CommerceOrderRowStatusV1,
    providerStatus: String(row.provider_status) as CommerceOrderRecordV1['providerStatus'],
    invoiceId: textOrNull(row.invoice_id),
    exactAmountAtomic: textOrNull(row.exact_amount_atomic),
    estimatedAmountAtomic: textOrNull(row.estimated_amount_atomic),
    payTo: textOrNull(row.pay_to),
    refundAddress: String(row.refund_address),
    order: payload ? parseCommerceOrderV1(payload as CommerceOrderV1) : null,
    expiresAt: isoOrNull(row.expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function runFromRow(row: Record<string, unknown>): CommerceRouteRunRecordV1 {
  const intent = parseCommerceIntentV1(row.intent_payload as CommerceRouteIntentV1);
  return {
    id: String(row.id),
    userId: String(row.user_id),
    walletAddress: String(row.wallet_address),
    chainId: Number(row.chain_id),
    goal: 'commerce',
    status: String(row.status),
    intentHash: String(row.intent_hash),
    idempotencyKey: String(row.idempotency_key),
    intent,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function createDatabaseCommerceStorageRepository(
  sql: SqlTemplateExecutor,
): CommerceStorageRepository {
  async function requireRun(runId: string, userId: string): Promise<CommerceRouteRunRecordV1> {
    const rows = await sql`
      SELECT id, user_id, wallet_address, chain_id, status, intent_hash, intent_payload,
             idempotency_key, created_at, updated_at
      FROM route_runs
      WHERE id = ${runId} AND goal = 'commerce'
      LIMIT 1
    `;
    if (!rows[0]) throw new RouteStorageIntegrityError('Commerce route run not found');
    const record = runFromRow(rows[0]);
    assertCommerceTenantV1(record.userId, userId);
    return record;
  }

  async function readOrder(orderId: string, userId: string): Promise<CommerceOrderRecordV1 | null> {
    const rows = await sql`
      SELECT id, route_run_id, user_id, wallet_address, route_card_hash, candidate_hash,
             product_id, package_value, idempotency_key, status, provider_status, invoice_id,
             exact_amount_atomic, estimated_amount_atomic, pay_to, refund_address, payload,
             expires_at, created_at, updated_at
      FROM commerce_orders
      WHERE id = ${orderId} AND user_id = ${userId}
      LIMIT 1
    `;
    return rows[0] ? orderFromRow(rows[0]) : null;
  }

  async function ownedOrder(orderId: string, userId: string): Promise<CommerceOrderRecordV1> {
    const record = await readOrder(orderId, userId);
    if (!record) throw new RouteStorageIntegrityError('Commerce order not found for this tenant');
    return record;
  }

  return {
    async createCommerceRouteRun(input: CommerceRouteIntentV1, idempotencyKey: string) {
      const intent = parseCommerceIntentV1(input);
      if (idempotencyKey.trim().length === 0) {
        throw new RouteStorageIntegrityError('Commerce route run idempotency key must not be empty');
      }
      const inserted = await sql`
        INSERT INTO route_runs (
          id, user_id, wallet_address, chain_id, goal, schema_version, status,
          intent_hash, intent_payload, idempotency_key, created_at, updated_at
        ) VALUES (
          ${intent.id}, ${intent.tenantId}, ${intent.walletAddress}, ${intent.chainId},
          'commerce', ${intent.schemaVersion}, ${intent.status}, ${intent.intentHash},
          CAST(${jsonb(intent)} AS jsonb), ${idempotencyKey},
          ${new Date(intent.createdAt)}, ${new Date(intent.updatedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id, user_id, wallet_address, chain_id, status, intent_hash, intent_payload,
                  idempotency_key, created_at, updated_at
      `;
      if (inserted[0]) return runFromRow(inserted[0]);
      const existing = await sql`
        SELECT id, user_id, wallet_address, chain_id, status, intent_hash, intent_payload,
               idempotency_key, created_at, updated_at
        FROM route_runs
        WHERE user_id = ${intent.tenantId} AND goal = 'commerce'
          AND (id = ${intent.id} OR idempotency_key = ${idempotencyKey})
        ORDER BY id
        LIMIT 1
      `;
      if (!existing[0]) {
        throw new RouteStorageConflictError('Commerce route run ID is already owned by another tenant');
      }
      const record = runFromRow(existing[0]);
      if (record.intentHash !== intent.intentHash) {
        throw new RouteStorageConflictError('Commerce idempotency key has different content');
      }
      return record;
    },

    async getCommerceRouteRun(id: string, userId: string) {
      const rows = await sql`
        SELECT id, user_id, wallet_address, chain_id, status, intent_hash, intent_payload,
               idempotency_key, created_at, updated_at
        FROM route_runs
        WHERE id = ${id} AND user_id = ${userId} AND goal = 'commerce'
        LIMIT 1
      `;
      return rows[0] ? runFromRow(rows[0]) : null;
    },

    async insertCommerceCandidate(runId: string, input: CommerceCandidateV1) {
      const candidate = parseCommerceCandidateV1(input);
      const run = await requireRun(runId, candidate.tenantId);
      if (candidate.intentHash !== run.intentHash) {
        throw new RouteStorageIntegrityError('Commerce candidate intentHash does not match its run');
      }
      await sql`
        INSERT INTO commerce_candidates (
          id, route_run_id, user_id, schema_version, status, candidate_hash,
          product_id, package_value, payload, observed_at, expires_at
        ) VALUES (
          ${candidate.id}, ${runId}, ${candidate.tenantId}, ${candidate.schemaVersion},
          ${candidate.status}, ${candidate.candidateHash}, ${candidate.product.productId},
          ${candidate.product.packageValue}, CAST(${jsonb(candidate)} AS jsonb),
          ${new Date(candidate.observedAt)}, ${new Date(candidate.expiresAt)}
        )
        ON CONFLICT DO NOTHING
      `;
    },

    async listCommerceCandidates(runId: string, userId: string) {
      await requireRun(runId, userId);
      const rows = await sql`
        SELECT payload FROM commerce_candidates
        WHERE route_run_id = ${runId} AND user_id = ${userId}
        ORDER BY created_at, id
      `;
      return rows.map((row) => parseCommerceCandidateV1(row.payload as CommerceCandidateV1));
    },

    async insertCommerceEvidence(runId: string, candidateHash: string | null, input: CommerceEvidenceV1) {
      const evidence = parseCommerceEvidenceV1(input);
      await requireRun(runId, evidence.tenantId);
      let candidateId: string | null = null;
      if (candidateHash !== null) {
        const rows = await sql`
          SELECT id FROM commerce_candidates
          WHERE route_run_id = ${runId} AND candidate_hash = ${candidateHash}
          LIMIT 1
        `;
        if (!rows[0]) {
          throw new RouteStorageIntegrityError('Commerce evidence references an unknown candidate');
        }
        candidateId = String(rows[0].id);
      }
      await sql`
        INSERT INTO commerce_evidence (
          id, route_run_id, candidate_id, user_id, schema_version, status,
          evidence_hash, provider_id, payload
        ) VALUES (
          ${evidence.id}, ${runId}, ${candidateId}, ${evidence.tenantId}, ${evidence.schemaVersion},
          ${evidence.status}, ${evidence.evidenceHash}, ${evidence.provider.id},
          CAST(${jsonb(evidence)} AS jsonb)
        )
        ON CONFLICT DO NOTHING
      `;
    },

    async listCommerceEvidence(runId: string, userId: string) {
      await requireRun(runId, userId);
      const rows = await sql`
        SELECT payload FROM commerce_evidence
        WHERE route_run_id = ${runId} AND user_id = ${userId}
        ORDER BY created_at, id
      `;
      return rows.map((row) => parseCommerceEvidenceV1(row.payload as CommerceEvidenceV1));
    },

    async insertCommerceRouteCard(runId: string, input: CommerceRouteCardV1) {
      const card = parseCommerceRouteCardV1(input);
      const run = await requireRun(runId, card.tenantId);
      if (card.intentHash !== run.intentHash) {
        throw new RouteStorageIntegrityError('Commerce route card intentHash does not match its run');
      }
      await sql`
        INSERT INTO commerce_route_cards (
          id, route_run_id, user_id, schema_version, status, route_card_hash, payload, expires_at
        ) VALUES (
          ${card.id}, ${runId}, ${card.tenantId}, ${card.schemaVersion}, ${card.status},
          ${card.routeCardHash}, CAST(${jsonb(card)} AS jsonb), ${new Date(card.expiresAt)}
        )
        ON CONFLICT DO NOTHING
      `;
    },

    async listCommerceRouteCards(runId: string, userId: string) {
      await requireRun(runId, userId);
      const rows = await sql`
        SELECT payload FROM commerce_route_cards
        WHERE route_run_id = ${runId} AND user_id = ${userId}
        ORDER BY created_at, id
      `;
      return rows.map((row) => parseCommerceRouteCardV1(row.payload as CommerceRouteCardV1));
    },

    async reserveCommerceOrder(input: ReserveCommerceOrderInputV1): Promise<ReserveCommerceOrderResultV1> {
      await requireRun(input.routeRunId, input.userId);
      const id = `commerce-order:${input.idempotencyKey.slice(-64)}`;
      // The unique index does the work. A concurrent duplicate inserts nothing
      // and falls through to the SELECT below.
      const inserted = await sql`
        INSERT INTO commerce_orders (
          id, route_run_id, user_id, wallet_address, route_card_hash, candidate_hash,
          product_id, package_value, idempotency_key, status, provider_status,
          estimated_amount_atomic, refund_address
        ) VALUES (
          ${id}, ${input.routeRunId}, ${input.userId}, ${input.walletAddress.toLowerCase()},
          ${input.routeCardHash}, ${input.candidateHash}, ${input.productId}, ${input.packageValue},
          ${input.idempotencyKey}, 'pending', 'unknown', ${input.estimatedAmountAtomic},
          ${input.refundAddress.toLowerCase()}
        )
        ON CONFLICT DO NOTHING
        RETURNING id, route_run_id, user_id, wallet_address, route_card_hash, candidate_hash,
          product_id, package_value, idempotency_key, status, provider_status, invoice_id,
          exact_amount_atomic, estimated_amount_atomic, pay_to, refund_address, payload,
          expires_at, created_at, updated_at
      `;
      if (inserted[0]) return { outcome: 'reserved', record: orderFromRow(inserted[0]) };

      const existing = await sql`
        SELECT id, route_run_id, user_id, wallet_address, route_card_hash, candidate_hash,
               product_id, package_value, idempotency_key, status, provider_status, invoice_id,
               exact_amount_atomic, estimated_amount_atomic, pay_to, refund_address, payload,
               expires_at, created_at, updated_at
        FROM commerce_orders
        WHERE user_id = ${input.userId} AND idempotency_key = ${input.idempotencyKey}
        LIMIT 1
      `;
      if (!existing[0]) {
        throw new RouteStorageConflictError('Commerce order id is already owned by another tenant');
      }
      return { outcome: 'existing', record: orderFromRow(existing[0]) };
    },

    async confirmCommerceOrder(orderId: string, userId: string, input: CommerceOrderV1) {
      const record = await ownedOrder(orderId, userId);
      const order = parseCommerceOrderV1(input);
      if (record.invoiceId !== null && record.invoiceId !== order.invoiceId) {
        throw new RouteStorageConflictError('Commerce order already holds a different invoice');
      }
      if (order.candidateHash !== record.candidateHash) {
        throw new RouteStorageIntegrityError('Commerce order candidateHash does not match its reservation');
      }
      const exact = order.invoice?.amountAtomic ?? order.amount.amountAtomic;
      await sql`
        UPDATE commerce_orders
        SET status = 'created',
            provider_status = ${order.providerStatus},
            invoice_id = ${order.invoiceId},
            exact_amount_atomic = ${exact},
            pay_to = ${order.payTo},
            payload = CAST(${jsonb(order)} AS jsonb),
            expires_at = ${new Date(order.expiresAt)},
            updated_at = now()
        WHERE id = ${orderId} AND user_id = ${userId}
      `;
      return ownedOrder(orderId, userId);
    },

    async markCommerceOrderUnknown(orderId: string, userId: string, detail: string) {
      const record = await ownedOrder(orderId, userId);
      // An invoice that already exists is never erased by a later uncertainty.
      if (record.invoiceId !== null) return record;
      void detail;
      await sql`
        UPDATE commerce_orders
        SET status = 'creation_unknown', provider_status = 'unknown', updated_at = now()
        WHERE id = ${orderId} AND user_id = ${userId} AND invoice_id IS NULL
      `;
      return ownedOrder(orderId, userId);
    },

    async updateCommerceOrderStatus(input) {
      const record = await ownedOrder(input.orderId, input.userId);
      const order = parseCommerceOrderV1(input.order);
      if (record.invoiceId !== null && order.invoiceId !== record.invoiceId) {
        throw new RouteStorageConflictError('Commerce order status update targets another invoice');
      }
      await sql`
        UPDATE commerce_orders
        SET status = ${input.status},
            provider_status = ${input.providerStatus},
            payload = CAST(${jsonb(order)} AS jsonb),
            exact_amount_atomic = COALESCE(${order.invoice?.amountAtomic ?? null}, exact_amount_atomic),
            updated_at = now()
        WHERE id = ${input.orderId} AND user_id = ${input.userId}
      `;
      return ownedOrder(input.orderId, input.userId);
    },

    async getCommerceOrder(orderId: string, userId: string) {
      return readOrder(orderId, userId);
    },

    async getCommerceOrderByInvoice(invoiceId: string, userId: string) {
      const rows = await sql`
        SELECT id, route_run_id, user_id, wallet_address, route_card_hash, candidate_hash,
               product_id, package_value, idempotency_key, status, provider_status, invoice_id,
               exact_amount_atomic, estimated_amount_atomic, pay_to, refund_address, payload,
               expires_at, created_at, updated_at
        FROM commerce_orders
        WHERE invoice_id = ${invoiceId} AND user_id = ${userId}
        LIMIT 1
      `;
      return rows[0] ? orderFromRow(rows[0]) : null;
    },

    async appendCommerceOrderEvent(orderId: string, userId: string, input: CommerceOrderEventV1) {
      await ownedOrder(orderId, userId);
      const event = parseCommerceOrderEventV1(input);
      await sql`
        INSERT INTO commerce_order_events (
          id, order_id, user_id, schema_version, status, payment_state, delivery_state,
          detail, observed_at
        ) VALUES (
          ${`${orderId}:${event.observedAt}:${event.status}`}, ${orderId}, ${userId},
          ${event.schemaVersion}, ${event.status}, ${event.paymentState}, ${event.deliveryState},
          ${event.detail}, ${new Date(event.observedAt)}
        )
        ON CONFLICT DO NOTHING
      `;
    },

    async listCommerceOrderEvents(orderId: string, userId: string) {
      await ownedOrder(orderId, userId);
      const rows = await sql`
        SELECT schema_version, status, payment_state, delivery_state, detail, observed_at
        FROM commerce_order_events
        WHERE order_id = ${orderId} AND user_id = ${userId}
        ORDER BY observed_at, id
      `;
      return rows.map((row) =>
        parseCommerceOrderEventV1({
          schemaVersion: String(row.schema_version) as CommerceOrderEventV1['schemaVersion'],
          invoiceId: orderId,
          status: String(row.status) as CommerceOrderEventV1['status'],
          paymentState: String(row.payment_state) as CommerceOrderEventV1['paymentState'],
          deliveryState: String(row.delivery_state) as CommerceOrderEventV1['deliveryState'],
          detail: textOrNull(row.detail),
          observedAt: iso(row.observed_at),
        }),
      );
    },

    async upsertCommerceProof(orderId: string, userId: string, input: CommerceRouteProofV1) {
      const record = await ownedOrder(orderId, userId);
      const proof = parseCommerceProofV1(input);
      if (record.order && proof.orderHash !== record.order.orderHash) {
        throw new RouteStorageIntegrityError('Commerce proof is not bound to its order');
      }
      await sql`
        INSERT INTO commerce_proofs (
          id, order_id, user_id, schema_version, final_status, proof_hash, order_hash, payload
        ) VALUES (
          ${proof.id}, ${orderId}, ${userId}, ${proof.schemaVersion}, ${proof.finalStatus},
          ${proof.proofHash}, ${proof.orderHash}, CAST(${jsonb(proof)} AS jsonb)
        )
        ON CONFLICT (order_id) DO UPDATE
        SET final_status = EXCLUDED.final_status,
            proof_hash = EXCLUDED.proof_hash,
            payload = EXCLUDED.payload,
            updated_at = now()
      `;
    },

    async getCommerceProof(orderId: string, userId: string) {
      const rows = await sql`
        SELECT payload FROM commerce_proofs
        WHERE order_id = ${orderId} AND user_id = ${userId}
        LIMIT 1
      `;
      return rows[0] ? parseCommerceProofV1(rows[0].payload as CommerceRouteProofV1) : null;
    },

    async listCommerceHistory(userId: string, limit: number) {
      const bounded = Math.max(1, Math.min(limit, 100));
      const rows = await sql`
        SELECT o.id, o.invoice_id, o.product_id, o.package_value, o.status, o.provider_status,
               o.exact_amount_atomic, o.estimated_amount_atomic, o.created_at, o.updated_at,
               p.final_status AS proof_final_status
        FROM commerce_orders o
        LEFT JOIN commerce_proofs p ON p.order_id = o.id AND p.user_id = o.user_id
        WHERE o.user_id = ${userId}
        ORDER BY o.created_at DESC
        LIMIT ${bounded}
      `;
      return rows.map(
        (row): CommerceHistoryItemV1 => ({
          orderId: String(row.id),
          invoiceId: textOrNull(row.invoice_id),
          productId: String(row.product_id),
          packageValue: String(row.package_value),
          status: String(row.status) as CommerceOrderRowStatusV1,
          providerStatus: String(row.provider_status) as CommerceOrderRecordV1['providerStatus'],
          exactAmountAtomic: textOrNull(row.exact_amount_atomic),
          estimatedAmountAtomic: textOrNull(row.estimated_amount_atomic),
          proofFinalStatus: textOrNull(row.proof_final_status) as CommerceHistoryItemV1['proofFinalStatus'],
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        }),
      );
    },
  };
}
