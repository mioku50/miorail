import type {
  ProviderReliabilitySnapshotV1,
  RouteProviderOutcomeV1,
} from '@mioagent/route-outcomes';

import {
  ProviderOutcomeConflictError,
  assertProviderOutcomeV1,
  assertReliabilitySnapshotV1,
  providerOutcomeInsertEffectV1,
  reliabilitySnapshotInsertEffectV1,
  type OutcomeWriteEffectV1,
  type ProviderOutcomeQueryV1,
  type ProviderOutcomeRepositoryV1,
  type ReliabilitySnapshotQueryV1,
} from './providerOutcomes.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Postgres-backed outcome and snapshot storage.
//
// Both insert paths use `ON CONFLICT DO NOTHING` and then RE-READ. The unique
// indexes are the real arbiter of a race, and re-reading is how this file finds
// out which side won instead of assuming it did.
//
// `SqlTemplateExecutor` has no `.unsafe`, so every column list below is spelled
// out inline. It is verbose and it is the only option.
// ---------------------------------------------------------------------------

const OUTCOME_COLUMNS = `id, proof_id, proof_hash, user_id, wallet_address, chain_id, provider_id,
  from_asset, to_asset, expected_output_atomic, minimum_output_atomic, actual_output_atomic,
  estimated_gas_atomic, actual_gas_atomic, quote_deviation_bps, adverse_shortfall_bps,
  floor_breached, confirmation_ms, proof_final_status, receipt_verification,
  occurred_at, derived_at, derivation_version, outcome_hash`;

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function rowToOutcomeV1(row: Record<string, unknown>): RouteProviderOutcomeV1 {
  return assertProviderOutcomeV1({
    schemaVersion: 'route-provider-outcome/v1',
    id: String(row.id),
    tenantId: String(row.user_id),
    walletAddress: String(row.wallet_address),
    chainId: Number(row.chain_id),
    status: 'derived',
    outcomeHash: String(row.outcome_hash),
    proofId: String(row.proof_id),
    proofHash: String(row.proof_hash),
    providerId: String(row.provider_id),
    fromAsset: String(row.from_asset),
    toAsset: String(row.to_asset),
    // numeric(78,0) comes back as a string; keeping it one avoids ever routing
    // an atomic amount through a JS number.
    expectedOutputAtomic: String(row.expected_output_atomic),
    minimumOutputAtomic: String(row.minimum_output_atomic),
    actualOutputAtomic: stringOrNull(row.actual_output_atomic),
    estimatedGasAtomic: stringOrNull(row.estimated_gas_atomic),
    actualGasAtomic: stringOrNull(row.actual_gas_atomic),
    quoteDeviationBps: numberOrNull(row.quote_deviation_bps),
    adverseShortfallBps: numberOrNull(row.adverse_shortfall_bps),
    floorBreached: row.floor_breached === null ? null : Boolean(row.floor_breached),
    confirmationMs: numberOrNull(row.confirmation_ms),
    proofFinalStatus: String(row.proof_final_status),
    receiptVerification: String(row.receipt_verification),
    occurredAt: iso(row.occurred_at),
    derivedAt: iso(row.derived_at),
    derivationVersion: String(row.derivation_version),
  });
}

function rowToSnapshotV1(row: Record<string, unknown>): ProviderReliabilitySnapshotV1 {
  return assertReliabilitySnapshotV1({
    schemaVersion: 'provider-reliability-snapshot/v1',
    id: String(row.id),
    status: 'sealed',
    createdAt: iso(row.created_at),
    scope: String(row.scope),
    tenantId: stringOrNull(row.user_id),
    walletAddress: stringOrNull(row.wallet_address),
    providerId: String(row.provider_id),
    chainId: Number(row.chain_id),
    fromAsset: String(row.from_asset),
    toAsset: String(row.to_asset),
    windowDays: Number(row.window_days),
    cutoffAt: iso(row.cutoff_at),
    sampleSize: Number(row.sample_size),
    uniqueWalletCount: Number(row.unique_wallet_count),
    completedCount: Number(row.completed_count),
    failedCount: Number(row.failed_count),
    partialFailureCount: Number(row.partial_failure_count),
    successRateBps: Number(row.success_rate_bps),
    medianAdverseShortfallBps: Number(row.median_adverse_shortfall_bps),
    p90AdverseShortfallBps: Number(row.p90_adverse_shortfall_bps),
    floorBreachRateBps: Number(row.floor_breach_rate_bps),
    medianGasErrorBps: numberOrNull(row.median_gas_error_bps),
    p90ConfirmationMs: numberOrNull(row.p90_confirmation_ms),
    outcomeSetHash: String(row.outcome_set_hash),
    snapshotHash: String(row.snapshot_hash),
    aggregationVersion: String(row.aggregation_version),
  });
}

export function createDatabaseProviderOutcomeRepository(
  sql: SqlTemplateExecutor,
): ProviderOutcomeRepositoryV1 {
  const repository: ProviderOutcomeRepositoryV1 = {
    async insertProviderOutcome(outcome): Promise<OutcomeWriteEffectV1> {
      const parsed = assertProviderOutcomeV1(outcome);
      const existing = await repository.getProviderOutcomeByProofId({
        tenantId: parsed.tenantId,
        proofId: parsed.proofId,
      });
      const decided = providerOutcomeInsertEffectV1(existing, parsed);
      if (decided.kind !== 'insert') return decided;

      const inserted = await sql`
        INSERT INTO route_provider_outcomes (
          id, proof_id, proof_hash, user_id, wallet_address, chain_id, provider_id,
          from_asset, to_asset, expected_output_atomic, minimum_output_atomic, actual_output_atomic,
          estimated_gas_atomic, actual_gas_atomic, quote_deviation_bps, adverse_shortfall_bps,
          floor_breached, confirmation_ms, proof_final_status, receipt_verification,
          occurred_at, derived_at, derivation_version, outcome_hash
        ) VALUES (
          ${parsed.id}, ${parsed.proofId}, ${parsed.proofHash}, ${parsed.tenantId},
          ${parsed.walletAddress}, ${parsed.chainId}, ${parsed.providerId},
          ${parsed.fromAsset}, ${parsed.toAsset}, ${parsed.expectedOutputAtomic},
          ${parsed.minimumOutputAtomic}, ${parsed.actualOutputAtomic},
          ${parsed.estimatedGasAtomic}, ${parsed.actualGasAtomic}, ${parsed.quoteDeviationBps},
          ${parsed.adverseShortfallBps}, ${parsed.floorBreached}, ${parsed.confirmationMs},
          ${parsed.proofFinalStatus}, ${parsed.receiptVerification},
          ${parsed.occurredAt}, ${parsed.derivedAt}, ${parsed.derivationVersion}, ${parsed.outcomeHash}
        )
        ON CONFLICT DO NOTHING
        RETURNING id`;

      if (inserted.length === 0) {
        // A unique index refused it. Either another request derived the same
        // proof concurrently — in which case the stored row decides — or the
        // proof hash is already bound to a different proof, which is a genuine
        // conflict and must not be papered over.
        const raced = await repository.getProviderOutcomeByProofId({
          tenantId: parsed.tenantId,
          proofId: parsed.proofId,
        });
        const recheck = providerOutcomeInsertEffectV1(raced, parsed);
        if (recheck.kind === 'insert') {
          return { kind: 'conflict', reason: 'proof_hash_already_recorded' };
        }
        return recheck;
      }
      return { kind: 'insert' };
    },

    async getProviderOutcomeByProofId({ tenantId, proofId }) {
      const rows = (await sql`
        SELECT id, proof_id, proof_hash, user_id, wallet_address, chain_id, provider_id,
          from_asset, to_asset, expected_output_atomic, minimum_output_atomic, actual_output_atomic,
          estimated_gas_atomic, actual_gas_atomic, quote_deviation_bps, adverse_shortfall_bps,
          floor_breached, confirmation_ms, proof_final_status, receipt_verification,
          occurred_at, derived_at, derivation_version, outcome_hash
        FROM route_provider_outcomes
        WHERE proof_id = ${proofId} AND user_id = ${tenantId}
        LIMIT 1`) as Record<string, unknown>[];
      return rows[0] ? rowToOutcomeV1(rows[0]) : null;
    },

    async listProviderOutcomes(query: ProviderOutcomeQueryV1) {
      // Every filter is applied in the WHERE clause rather than in JS: the
      // network aggregation reads across tenants, so a filter that ran after
      // the fetch would mean rows crossing a boundary they never needed to.
      const rows = (await sql`
        SELECT id, proof_id, proof_hash, user_id, wallet_address, chain_id, provider_id,
          from_asset, to_asset, expected_output_atomic, minimum_output_atomic, actual_output_atomic,
          estimated_gas_atomic, actual_gas_atomic, quote_deviation_bps, adverse_shortfall_bps,
          floor_breached, confirmation_ms, proof_final_status, receipt_verification,
          occurred_at, derived_at, derivation_version, outcome_hash
        FROM route_provider_outcomes
        WHERE (${query.tenantId ?? null}::text IS NULL OR user_id = ${query.tenantId ?? null})
          AND (${query.walletAddress?.toLowerCase() ?? null}::text IS NULL OR wallet_address = ${query.walletAddress?.toLowerCase() ?? null})
          AND (${query.providerId ?? null}::text IS NULL OR provider_id = ${query.providerId ?? null})
          AND (${query.fromAsset ?? null}::text IS NULL OR from_asset = ${query.fromAsset ?? null})
          AND (${query.toAsset ?? null}::text IS NULL OR to_asset = ${query.toAsset ?? null})
          AND (${query.from?.toISOString() ?? null}::timestamptz IS NULL OR occurred_at >= ${query.from?.toISOString() ?? null})
          AND (${query.to?.toISOString() ?? null}::timestamptz IS NULL OR occurred_at <= ${query.to?.toISOString() ?? null})
        ORDER BY occurred_at ASC, outcome_hash ASC
        LIMIT ${query.limit ?? 100_000}`) as Record<string, unknown>[];
      return rows.map(rowToOutcomeV1);
    },

    async insertReliabilitySnapshot(snapshot, memberOutcomeIds): Promise<OutcomeWriteEffectV1> {
      const parsed = assertReliabilitySnapshotV1(snapshot);
      if (memberOutcomeIds.length !== parsed.sampleSize) {
        throw new ProviderOutcomeConflictError('member_count_disagrees_with_sample_size');
      }
      const existingRows = (await sql`
        SELECT id, scope, user_id, wallet_address, provider_id, chain_id, from_asset, to_asset,
          window_days, cutoff_at, sample_size, unique_wallet_count, completed_count, failed_count,
          partial_failure_count, success_rate_bps, median_adverse_shortfall_bps,
          p90_adverse_shortfall_bps, floor_breach_rate_bps, median_gas_error_bps,
          p90_confirmation_ms, outcome_set_hash, snapshot_hash, aggregation_version, created_at
        FROM provider_reliability_snapshots
        WHERE snapshot_hash = ${parsed.snapshotHash} LIMIT 1`) as Record<string, unknown>[];
      const decided = reliabilitySnapshotInsertEffectV1(
        existingRows[0] ? rowToSnapshotV1(existingRows[0]) : null,
        parsed,
      );
      if (decided.kind !== 'insert') return decided;

      const inserted = await sql`
        INSERT INTO provider_reliability_snapshots (
          id, scope, user_id, wallet_address, provider_id, chain_id, from_asset, to_asset,
          window_days, cutoff_at, sample_size, unique_wallet_count, completed_count, failed_count,
          partial_failure_count, success_rate_bps, median_adverse_shortfall_bps,
          p90_adverse_shortfall_bps, floor_breach_rate_bps, median_gas_error_bps,
          p90_confirmation_ms, outcome_set_hash, snapshot_hash, aggregation_version, created_at
        ) VALUES (
          ${parsed.id}, ${parsed.scope}, ${parsed.tenantId}, ${parsed.walletAddress},
          ${parsed.providerId}, ${parsed.chainId}, ${parsed.fromAsset}, ${parsed.toAsset},
          ${parsed.windowDays}, ${parsed.cutoffAt}, ${parsed.sampleSize}, ${parsed.uniqueWalletCount},
          ${parsed.completedCount}, ${parsed.failedCount}, ${parsed.partialFailureCount},
          ${parsed.successRateBps}, ${parsed.medianAdverseShortfallBps},
          ${parsed.p90AdverseShortfallBps}, ${parsed.floorBreachRateBps}, ${parsed.medianGasErrorBps},
          ${parsed.p90ConfirmationMs}, ${parsed.outcomeSetHash}, ${parsed.snapshotHash},
          ${parsed.aggregationVersion}, ${parsed.createdAt}
        )
        ON CONFLICT DO NOTHING
        RETURNING id`;
      if (inserted.length === 0) return { kind: 'return_existing' };

      // Membership is written after the snapshot exists, one row per member, in
      // snapshot order. Without these rows the snapshot would be an
      // unfalsifiable claim, which is the one thing it must not be.
      for (const [ordinal, outcomeId] of memberOutcomeIds.entries()) {
        await sql`
          INSERT INTO provider_reliability_snapshot_members (snapshot_id, outcome_id, ordinal)
          VALUES (${parsed.id}, ${outcomeId}, ${ordinal})
          ON CONFLICT DO NOTHING`;
      }
      return { kind: 'insert' };
    },

    async getLatestReliabilitySnapshot(query: ReliabilitySnapshotQueryV1) {
      const rows = (await sql`
        SELECT id, scope, user_id, wallet_address, provider_id, chain_id, from_asset, to_asset,
          window_days, cutoff_at, sample_size, unique_wallet_count, completed_count, failed_count,
          partial_failure_count, success_rate_bps, median_adverse_shortfall_bps,
          p90_adverse_shortfall_bps, floor_breach_rate_bps, median_gas_error_bps,
          p90_confirmation_ms, outcome_set_hash, snapshot_hash, aggregation_version, created_at
        FROM provider_reliability_snapshots
        WHERE scope = ${query.scope}
          AND provider_id = ${query.providerId}
          AND from_asset = ${query.fromAsset}
          AND to_asset = ${query.toAsset}
          AND (${query.scope === 'personal' ? (query.tenantId ?? null) : null}::text IS NULL OR user_id = ${query.tenantId ?? null})
          AND (${query.scope === 'personal' ? (query.walletAddress?.toLowerCase() ?? null) : null}::text IS NULL OR wallet_address = ${query.walletAddress?.toLowerCase() ?? null})
          AND (${query.cutoffAtOrBefore?.toISOString() ?? null}::timestamptz IS NULL OR cutoff_at <= ${query.cutoffAtOrBefore?.toISOString() ?? null})
        ORDER BY cutoff_at DESC, id DESC
        LIMIT 1`) as Record<string, unknown>[];
      return rows[0] ? rowToSnapshotV1(rows[0]) : null;
    },

    async listSnapshotMemberIds(snapshotId) {
      const rows = (await sql`
        SELECT outcome_id FROM provider_reliability_snapshot_members
        WHERE snapshot_id = ${snapshotId}
        ORDER BY ordinal ASC`) as Record<string, unknown>[];
      return rows.map((row) => String(row.outcome_id));
    },
  };

  return repository;
}

export { OUTCOME_COLUMNS };
