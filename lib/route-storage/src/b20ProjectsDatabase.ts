import {
  B20ProjectClaimRequiredError,
  assertProjectClaimV1,
  assertProjectEvidenceV1,
  claimPermitsEvidenceV1,
  type B20ProjectClaimRowV1,
  type B20ProjectEvidenceRowV1,
  type B20ProjectRecordV1,
  type B20ProjectRepositoryV1,
} from './b20Projects.js';
import type { SqlTemplateExecutor } from './types.js';

function rowToClaimV1(row: Record<string, unknown>): B20ProjectClaimRowV1 {
  return assertProjectClaimV1(
    {
      chainId: Number(row.chain_id),
      tokenAddress: row.token_address,
      claimantDomain: row.claimant_domain,
      status: row.status,
      verifiedLinks: (row.verified_links as string[] | null) ?? [],
      refutedLinks: (row.refuted_links as string[] | null) ?? [],
      lastCheckedAt: new Date(row.last_checked_at as string).toISOString(),
    },
    'read',
  );
}

function rowToEvidenceV1(row: Record<string, unknown>): B20ProjectEvidenceRowV1 {
  return assertProjectEvidenceV1(
    {
      chainId: Number(row.chain_id),
      tokenAddress: row.token_address,
      dimension: row.dimension,
      state: row.state,
      provenance: row.provenance,
      reference: row.reference ?? null,
      observedAt: new Date(row.observed_at as string).toISOString(),
    },
    'read',
  );
}

export function createDatabaseB20ProjectRepository(sql: SqlTemplateExecutor): B20ProjectRepositoryV1 {
  const assemble = (
    claimRows: Record<string, unknown>[],
    evidenceRows: Record<string, unknown>[],
  ): B20ProjectRecordV1[] => {
    const byToken = new Map<string, B20ProjectEvidenceRowV1[]>();
    for (const row of evidenceRows) {
      const parsed = rowToEvidenceV1(row);
      const list = byToken.get(parsed.tokenAddress) ?? [];
      list.push(parsed);
      byToken.set(parsed.tokenAddress, list);
    }
    return claimRows.map((row) => {
      const claim = rowToClaimV1(row);
      return { claim, evidence: byToken.get(claim.tokenAddress) ?? [] };
    });
  };

  return {
    async readProject(input) {
      const address = input.tokenAddress.toLowerCase();
      const [claims, evidence] = await Promise.all([
        sql`SELECT * FROM b20_project_claims
             WHERE chain_id = ${input.chainId} AND token_address = ${address} LIMIT 1`,
        sql`SELECT * FROM b20_project_evidence
             WHERE chain_id = ${input.chainId} AND token_address = ${address}
             ORDER BY dimension`,
      ]);
      const records = assemble(claims as Record<string, unknown>[], evidence as Record<string, unknown>[]);
      return records[0] ?? null;
    },

    async readProjects(input) {
      const addresses = [...new Set(input.tokenAddresses.map((address) => address.toLowerCase()))];
      if (addresses.length === 0) return [];
      const [claims, evidence] = await Promise.all([
        sql`SELECT * FROM b20_project_claims
             WHERE chain_id = ${input.chainId} AND token_address = ANY(${addresses})`,
        sql`SELECT * FROM b20_project_evidence
             WHERE chain_id = ${input.chainId} AND token_address = ANY(${addresses})
             ORDER BY token_address, dimension`,
      ]);
      return assemble(claims as Record<string, unknown>[], evidence as Record<string, unknown>[]);
    },

    async recordVerification(input) {
      const claim = assertProjectClaimV1(input.claim, 'write');
      const rows = input.evidence.map((row) => assertProjectEvidenceV1(row, 'write'));

      // The same refusal the memory repository makes, made here too rather than
      // relying on a caller having gone through one of them.
      if (rows.length > 0 && !claimPermitsEvidenceV1(claim)) {
        throw new B20ProjectClaimRequiredError(
          claim.tokenAddress,
          `the claim by ${claim.claimantDomain} is ${claim.status}, so no project evidence may be attached`,
        );
      }
      for (const row of rows) {
        if (row.tokenAddress !== claim.tokenAddress || row.chainId !== claim.chainId) {
          throw new B20ProjectClaimRequiredError(
            row.tokenAddress,
            'evidence must belong to the token its claim was verified for',
          );
        }
      }

      await sql`
        INSERT INTO b20_project_claims (
          chain_id, token_address, claimant_domain, status, verified_links, refuted_links, last_checked_at
        ) VALUES (
          ${claim.chainId}, ${claim.tokenAddress}, ${claim.claimantDomain}, ${claim.status},
          ${claim.verifiedLinks}, ${claim.refutedLinks}, ${claim.lastCheckedAt}::timestamptz
        )
        ON CONFLICT (chain_id, token_address) DO UPDATE SET
          claimant_domain = EXCLUDED.claimant_domain,
          status = EXCLUDED.status,
          verified_links = EXCLUDED.verified_links,
          refuted_links = EXCLUDED.refuted_links,
          last_checked_at = EXCLUDED.last_checked_at`;

      // Replace, never merge. A probe that no longer finds a product must not
      // leave the previous `live` row standing beside the new reading.
      await sql`
        DELETE FROM b20_project_evidence
         WHERE chain_id = ${claim.chainId} AND token_address = ${claim.tokenAddress}`;

      for (const row of rows) {
        await sql`
          INSERT INTO b20_project_evidence (
            chain_id, token_address, dimension, state, provenance, reference, observed_at
          ) VALUES (
            ${row.chainId}, ${row.tokenAddress}, ${row.dimension}, ${row.state},
            ${row.provenance}, ${row.reference}, ${row.observedAt}::timestamptz
          )`;
      }

      return { claim, evidence: rows };
    },

    async verifiedTokenAddresses(input) {
      const rows = await sql`
        SELECT token_address FROM b20_project_claims
         WHERE chain_id = ${input.chainId} AND status = 'verified'
         ORDER BY token_address
         LIMIT ${input.limit}`;
      return (rows as Record<string, unknown>[]).map((row) => String(row.token_address));
    },

    async tokensMatchingEvidence(input) {
      if (input.states.length === 0) return [];
      const rows = await sql`
        SELECT DISTINCT e.token_address
          FROM b20_project_evidence e
          -- The JOIN is the point of the query, not an optimisation. Evidence
          -- may only answer a question while the claim that permitted it is
          -- still verified; a refuted claim's rows are excluded here even if
          -- they somehow outlived the write path that replaces them.
          JOIN b20_project_claims c
            ON c.chain_id = e.chain_id AND c.token_address = e.token_address
         WHERE e.chain_id = ${input.chainId}
           AND e.dimension = ${input.dimension}
           AND e.state = ANY(${[...input.states]}::text[])
           AND c.status = 'verified'
         ORDER BY e.token_address
         LIMIT ${input.limit}`;
      return (rows as Record<string, unknown>[]).map((row) => String(row.token_address));
    },

    async verifiedClaimCount(input) {
      const rows = await sql`
        SELECT COUNT(*)::int AS count FROM b20_project_claims
         WHERE chain_id = ${input.chainId} AND status = 'verified'`;
      return Number((rows as Record<string, unknown>[])[0]?.count ?? 0);
    },
  };
}
