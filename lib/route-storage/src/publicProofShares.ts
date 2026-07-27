import {
  PUBLIC_PROOF_BUNDLE_SCHEMA_VERSION_V1,
  PUBLIC_PROOF_ID_BYTES_V1,
  PublicProofShareV1Schema,
  type ProofFamilyV1,
  type PublicProofShareV1,
} from '@mioagent/route-domain';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// T67C.2 — public proof shares.
//
// A share is a mapping from an unguessable id to a proof that already exists.
// It holds NO proof content, which is what makes revocation honest: removing
// the row removes access and changes no financial record, and the bundle a
// visitor sees is always rebuilt from the proof rather than from a copy that
// could have drifted.
//
// Two rules are structural rather than remembered:
//
//   * A public id is 24 random bytes from a cryptographic source. Not a
//     sequence, not derived from the proof id, not derived from anything a
//     visitor can see. Enumeration is the obvious attack on a link that opens
//     without a login, and the only defence is that there is nothing to count.
//   * A revoked id is never reissued. Re-sharing mints a new one, so a link
//     that stopped working cannot come back to life under someone else's
//     assumption that it still points where it used to.
// ---------------------------------------------------------------------------

export interface CreatePublicProofShareInputV1 {
  tenantId: string;
  proofFamily: ProofFamilyV1;
  proofId: string;
  now: Date;
}

export interface PublicProofShareRepositoryV1 {
  /** Idempotent: an existing live share for this proof is returned unchanged. */
  createShare(input: CreatePublicProofShareInputV1): Promise<PublicProofShareV1>;
  /** The public read. Deliberately NOT tenant-scoped — that is the point of a
   * public link — and it returns null for a revoked share, so a revoked id and
   * an id that never existed are the same 404. */
  getLiveShare(publicId: string): Promise<PublicProofShareV1 | null>;
  getActiveShareForProof(
    tenantId: string,
    proofFamily: ProofFamilyV1,
    proofId: string,
  ): Promise<PublicProofShareV1 | null>;
  /** Idempotent. Returns false when the owner had nothing live to revoke. */
  revokeShare(
    tenantId: string,
    proofFamily: ProofFamilyV1,
    proofId: string,
    now: Date,
  ): Promise<boolean>;
}

/** Cryptographically secure, 192 bits. `crypto.getRandomValues` is present in
 * Node 18+ and every browser; there is no Math.random fallback on purpose,
 * because a predictable public id is worse than a failed share. */
export function newPublicProofIdV1(): string {
  const bytes = new Uint8Array(PUBLIC_PROOF_ID_BYTES_V1);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function newPublicProofShareV1(
  publicId: string,
  input: CreatePublicProofShareInputV1,
): PublicProofShareV1 {
  return assertPublicProofShareV1(
    {
      schemaVersion: 'public-proof-share/v1',
      publicId,
      tenantId: input.tenantId,
      proofFamily: input.proofFamily,
      proofId: input.proofId,
      createdAt: input.now.toISOString(),
      revokedAt: null,
      bundleSchemaVersion: PUBLIC_PROOF_BUNDLE_SCHEMA_VERSION_V1,
    },
    'write',
  );
}

export function assertPublicProofShareV1(value: unknown, where: 'write' | 'read'): PublicProofShareV1 {
  const parsed = PublicProofShareV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new RouteStorageIntegrityError(`Public proof share failed validation on ${where}`);
  }
  return parsed.data;
}

/** Whether a proof may be published at all. A pending proof describes a
 * question that has not been answered yet, and publishing it would put a claim
 * on the internet that Miorail itself has not finished checking. */
export function proofIsPublishableV1(finalStatus: string | null): boolean {
  return finalStatus !== null && finalStatus !== 'pending';
}
