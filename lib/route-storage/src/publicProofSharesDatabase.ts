import type { PublicProofShareV1 } from '@mioagent/route-domain';

import {
  assertPublicProofShareV1,
  newPublicProofIdV1,
  newPublicProofShareV1,
  type CreatePublicProofShareInputV1,
  type PublicProofShareRepositoryV1,
} from './publicProofShares.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Postgres-backed PublicProofShareRepositoryV1.
//
// `public_proof_shares_active_unique` is a PARTIAL unique index on
// (proof_family, proof_id) WHERE revoked_at IS NULL. That is what makes both
// rules real rather than hoped for: a second Share cannot create a second live
// link, and revoking frees the proof so a new id can be minted later without
// ever resurrecting the old one.
// ---------------------------------------------------------------------------

function rowToShareV1(row: Record<string, unknown>): PublicProofShareV1 {
  return assertPublicProofShareV1(
    {
      schemaVersion: 'public-proof-share/v1',
      publicId: String(row.public_id),
      tenantId: String(row.user_id),
      proofFamily: String(row.proof_family),
      proofId: String(row.proof_id),
      createdAt: new Date(String(row.created_at)).toISOString(),
      revokedAt: row.revoked_at === null ? null : new Date(String(row.revoked_at)).toISOString(),
      bundleSchemaVersion: String(row.bundle_schema_version),
    },
    'read',
  );
}

export function createDatabasePublicProofShareRepository(
  sql: SqlTemplateExecutor,
  options: { newId?: () => string } = {},
): PublicProofShareRepositoryV1 {
  const newId = options.newId ?? newPublicProofIdV1;

  const repository: PublicProofShareRepositoryV1 = {
    async createShare(input: CreatePublicProofShareInputV1): Promise<PublicProofShareV1> {
      const existing = await repository.getActiveShareForProof(
        input.tenantId,
        input.proofFamily,
        input.proofId,
      );
      if (existing) return existing;

      const share = newPublicProofShareV1(newId(), input);
      const rows = await sql`
        INSERT INTO public_proof_shares (
          public_id, user_id, proof_family, proof_id, created_at, revoked_at, bundle_schema_version
        ) VALUES (
          ${share.publicId}, ${share.tenantId}, ${share.proofFamily}, ${share.proofId},
          ${share.createdAt}, ${null}, ${share.bundleSchemaVersion}
        )
        ON CONFLICT DO NOTHING
        RETURNING public_id, user_id, proof_family, proof_id, created_at, revoked_at, bundle_schema_version`;
      if (rows.length === 0) {
        // Lost the race against another Share for the same proof: the winner's
        // link is the answer, exactly as it would be for a repeat request.
        const raced = await repository.getActiveShareForProof(
          input.tenantId,
          input.proofFamily,
          input.proofId,
        );
        if (!raced) throw new Error('The public proof share could not be stored');
        return raced;
      }
      return rowToShareV1(rows[0] as Record<string, unknown>);
    },

    async getLiveShare(publicId: string): Promise<PublicProofShareV1 | null> {
      // No tenant filter — this is the public read. `revoked_at IS NULL` is in
      // the WHERE clause, so a revoked link is not found rather than found and
      // then refused.
      const rows = await sql`
        SELECT public_id, user_id, proof_family, proof_id, created_at, revoked_at, bundle_schema_version
        FROM public_proof_shares
        WHERE public_id = ${publicId} AND revoked_at IS NULL
        LIMIT 1`;
      const row = rows[0];
      return row ? rowToShareV1(row as Record<string, unknown>) : null;
    },

    async getActiveShareForProof(tenantId, proofFamily, proofId): Promise<PublicProofShareV1 | null> {
      const rows = await sql`
        SELECT public_id, user_id, proof_family, proof_id, created_at, revoked_at, bundle_schema_version
        FROM public_proof_shares
        WHERE user_id = ${tenantId} AND proof_family = ${proofFamily} AND proof_id = ${proofId}
          AND revoked_at IS NULL
        LIMIT 1`;
      const row = rows[0];
      return row ? rowToShareV1(row as Record<string, unknown>) : null;
    },

    async revokeShare(tenantId, proofFamily, proofId, now): Promise<boolean> {
      // The tenant is in the WHERE clause: revoking is an owner action, and a
      // non-owner's request updates zero rows rather than being checked
      // afterwards.
      const rows = await sql`
        UPDATE public_proof_shares
        SET revoked_at = ${now.toISOString()}
        WHERE user_id = ${tenantId} AND proof_family = ${proofFamily} AND proof_id = ${proofId}
          AND revoked_at IS NULL
        RETURNING public_id`;
      return rows.length > 0;
    },
  };

  return repository;
}
