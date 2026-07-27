import type { ProofFamilyV1, PublicProofShareV1 } from '@mioagent/route-domain';

import {
  assertPublicProofShareV1,
  newPublicProofIdV1,
  newPublicProofShareV1,
  type CreatePublicProofShareInputV1,
  type PublicProofShareRepositoryV1,
} from './publicProofShares.js';

/**
 * The in-memory share repository.
 *
 * It emulates the partial unique index the database carries — one live share
 * per proof — rather than assuming callers behave, so the fake refuses exactly
 * what Postgres refuses.
 */
export class InMemoryPublicProofShareRepositoryV1 implements PublicProofShareRepositoryV1 {
  private readonly rows = new Map<string, PublicProofShareV1>();

  constructor(private readonly newId: () => string = newPublicProofIdV1) {}

  private clone(value: PublicProofShareV1): PublicProofShareV1 {
    return structuredClone(value);
  }

  async createShare(input: CreatePublicProofShareInputV1): Promise<PublicProofShareV1> {
    const existing = await this.getActiveShareForProof(input.tenantId, input.proofFamily, input.proofId);
    // A second Share returns the link that already exists. Minting another
    // would leave two live ids that both have to be revoked separately.
    if (existing) return existing;
    const share = newPublicProofShareV1(this.newId(), input);
    this.rows.set(share.publicId, this.clone(share));
    return share;
  }

  async getLiveShare(publicId: string): Promise<PublicProofShareV1 | null> {
    const row = this.rows.get(publicId);
    // A revoked share is not found rather than found-and-refused: a visitor
    // must not be able to tell a revoked link from one that never existed.
    if (!row || row.revokedAt !== null) return null;
    return this.clone(assertPublicProofShareV1(row, 'read'));
  }

  async getActiveShareForProof(
    tenantId: string,
    proofFamily: ProofFamilyV1,
    proofId: string,
  ): Promise<PublicProofShareV1 | null> {
    const match = [...this.rows.values()].find(
      (row) =>
        row.tenantId === tenantId &&
        row.proofFamily === proofFamily &&
        row.proofId === proofId &&
        row.revokedAt === null,
    );
    return match ? this.clone(assertPublicProofShareV1(match, 'read')) : null;
  }

  async revokeShare(
    tenantId: string,
    proofFamily: ProofFamilyV1,
    proofId: string,
    now: Date,
  ): Promise<boolean> {
    const live = await this.getActiveShareForProof(tenantId, proofFamily, proofId);
    if (!live) return false;
    this.rows.set(live.publicId, this.clone({ ...live, revokedAt: now.toISOString() }));
    return true;
  }
}
