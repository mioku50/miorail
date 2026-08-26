import { randomUUID } from 'node:crypto';

import {
  assertIssuerMembershipCheckV1,
  assertIssuerRepresentationV1,
  type IssuerMembershipCheckRecordV1,
  type IssuerRepresentationRepositoryV1,
  type IssuerRepresentationRowV1,
  type MembershipReadOutcomeV1,
} from './issuerRepresentation.js';
import type { SqlTemplateExecutor } from './types.js';

function rowToRepresentationV1(row: Record<string, unknown>): IssuerRepresentationRowV1 {
  return assertIssuerRepresentationV1(
    {
      chainId: Number(row.chain_id),
      tokenAddress: String(row.token_address),
      issuerId: String(row.issuer_id),
      rootKey: String(row.root_key),
      rootAddress: String(row.root_address),
      membership: String(row.membership),
      blockNumber: String(row.block_number),
      blockHash: String(row.block_hash),
      evidenceHash: String(row.evidence_hash),
      firstSeenAt: new Date(row.first_seen_at as string).toISOString(),
      lastCheckedAt: new Date(row.last_checked_at as string).toISOString(),
      lastChangedAt: row.last_changed_at ? new Date(row.last_changed_at as string).toISOString() : null,
      reads: Number(row.reads),
      changes: Number(row.changes),
    },
    'read',
  );
}

function rowToCheckV1(row: Record<string, unknown>): IssuerMembershipCheckRecordV1 {
  const parsed = assertIssuerMembershipCheckV1(
    {
      issuerId: String(row.issuer_id),
      rootKey: String(row.root_key),
      chainId: Number(row.chain_id),
      rootAddress: String(row.root_address),
      predicateSelector: String(row.predicate_selector),
      status: String(row.status),
      blockNumber: row.block_number === null ? null : String(row.block_number),
      blockHash: row.block_hash === null ? null : String(row.block_hash),
      candidates: Number(row.candidates),
      established: Number(row.established),
      refuted: Number(row.refuted),
      unread: Number(row.unread),
      observedAt: new Date(row.observed_at as string).toISOString(),
      detail: row.detail === null ? null : String(row.detail),
    },
    'read',
  );
  return { ...parsed, checkId: String(row.id) };
}

export function createDatabaseIssuerRepresentationRepository(
  sql: SqlTemplateExecutor,
): IssuerRepresentationRepositoryV1 {
  return {
    async recordMembership(input) {
      const address = input.tokenAddress.toLowerCase();
      const rootAddress = input.rootAddress.toLowerCase();

      // Read before writing rather than inferring from the upsert: an
      // ON CONFLICT clause sees only the row it is about to overwrite, and the
      // difference between a first sighting and a change is exactly what a
      // caller is asking this method for.
      const previous = (await sql`
        SELECT membership FROM issuer_representation
         WHERE chain_id = ${input.chainId}
           AND token_address = ${address}
           AND issuer_id = ${input.issuerId}
           AND root_key = ${input.rootKey}
      `) as Record<string, unknown>[];
      const before = previous[0] ? String(previous[0].membership) : null;
      const moved = before !== null && before !== input.membership;
      const outcome: MembershipReadOutcomeV1 =
        before === null ? 'first_observation' : moved ? 'changed' : 'unchanged';

      const written = (await sql`
        INSERT INTO issuer_representation (
          chain_id, token_address, issuer_id, root_key, root_address, membership,
          block_number, block_hash, evidence_hash,
          first_seen_at, last_checked_at, last_changed_at, reads, changes
        ) VALUES (
          ${input.chainId}, ${address}, ${input.issuerId}, ${input.rootKey}, ${rootAddress},
          ${input.membership}, ${input.blockNumber}, ${input.blockHash}, ${input.evidenceHash},
          ${input.observedAt}::timestamptz, ${input.observedAt}::timestamptz, NULL, 1, 0
        )
        ON CONFLICT (chain_id, token_address, issuer_id, root_key) DO UPDATE SET
          root_address = EXCLUDED.root_address,
          membership = EXCLUDED.membership,
          block_number = EXCLUDED.block_number,
          block_hash = EXCLUDED.block_hash,
          evidence_hash = EXCLUDED.evidence_hash,
          last_checked_at = GREATEST(issuer_representation.last_checked_at, EXCLUDED.last_checked_at),
          last_changed_at = CASE WHEN ${moved} THEN EXCLUDED.last_checked_at
                                 ELSE issuer_representation.last_changed_at END,
          reads = issuer_representation.reads + 1,
          changes = issuer_representation.changes + CASE WHEN ${moved} THEN 1 ELSE 0 END
        RETURNING *
      `) as Record<string, unknown>[];

      return { outcome, row: rowToRepresentationV1(written[0]) };
    },

    async recordCheck(input) {
      const parsed = assertIssuerMembershipCheckV1(input, 'write');
      const id = randomUUID();
      await sql`
        INSERT INTO issuer_membership_check (
          id, issuer_id, root_key, chain_id, root_address, predicate_selector, status,
          block_number, block_hash, candidates, established, refuted, unread, observed_at, detail
        ) VALUES (
          ${id}, ${parsed.issuerId}, ${parsed.rootKey}, ${parsed.chainId},
          ${parsed.rootAddress.toLowerCase()}, ${parsed.predicateSelector}, ${parsed.status},
          ${parsed.blockNumber}, ${parsed.blockHash}, ${parsed.candidates}, ${parsed.established},
          ${parsed.refuted}, ${parsed.unread}, ${parsed.observedAt}::timestamptz, ${parsed.detail}
        )
      `;
      return { ...parsed, checkId: id };
    },

    async latestCheck(input) {
      const successfulOnly = input.successfulOnly === true;
      const rows = (await sql`
        SELECT * FROM issuer_membership_check
         WHERE issuer_id = ${input.issuerId}
           AND root_key = ${input.rootKey}
           AND (${successfulOnly} = false OR status = 'ok')
         ORDER BY observed_at DESC, id DESC
         LIMIT 1
      `) as Record<string, unknown>[];
      return rows[0] ? rowToCheckV1(rows[0]) : null;
    },

    async membershipFor(input) {
      const wanted = input.tokenAddresses.map((value) => value.toLowerCase());
      if (wanted.length === 0) return [];
      const rows = (await sql`
        SELECT * FROM issuer_representation
         WHERE chain_id = ${input.chainId}
           AND token_address = ANY(${wanted})
         ORDER BY token_address ASC, issuer_id ASC
      `) as Record<string, unknown>[];
      return rows.map(rowToRepresentationV1);
    },

    async establishedRepresentations(input) {
      const issuerId = input.issuerId ?? null;
      const rows = (await sql`
        SELECT * FROM issuer_representation
         WHERE chain_id = ${input.chainId}
           AND membership = 'established'
           AND (${issuerId}::text IS NULL OR issuer_id = ${issuerId}::text)
         ORDER BY issuer_id ASC, token_address ASC
         LIMIT ${Math.max(1, Math.min(1_000, input.limit))}
      `) as Record<string, unknown>[];
      return rows.map(rowToRepresentationV1);
    },
  };
}
