import { z } from 'zod';

import { canonicalJsonValueV1, stableHashV1, type HashV1 } from './hashing.js';
import {
  EntityIdV1Schema,
  HashV1Schema,
  TenantIdV1Schema,
  TimestampV1Schema,
} from './primitives.js';
import { RouteProofEventV1Schema, RouteProofV1Schema } from './execution-contracts.js';
import { NftProofEventV1Schema, NftPurchaseProofV1Schema } from './nft-contracts.js';

// ---------------------------------------------------------------------------
// T67C.2 — public proof bundles.
//
// A finished proof can be published at an unguessable URL so somebody who does
// not have a Miorail account can check it. The point of the bundle is that
// checking it requires no trust in Miorail at all: it carries the CANONICAL
// proof document, not a display projection, so a third party can recompute
// every hash themselves and find the same answers or find that something was
// changed.
//
// Two things this deliberately is NOT, and the UI has to say so too:
//
//   * It is not a Miorail signature. Nothing here is signed by a server key;
//     recomputing a hash proves the bundle is internally consistent, not that
//     Miorail vouches for it.
//   * It is not an onchain anchor. No hash in this bundle was written to Base.
//     The transaction hashes inside it were, and a reader can check those on a
//     block explorer — which is a different, and stronger, kind of evidence.
//
// The union is versioned per family. An NFT proof is not a Route Proof and is
// not converted into one; forcing them into a single shape would mean lying
// about one of them.
// ---------------------------------------------------------------------------

export const PROOF_FAMILY_V1 = ['route', 'nft'] as const;
export const ProofFamilyV1Schema = z.enum(PROOF_FAMILY_V1);
export type ProofFamilyV1 = z.infer<typeof ProofFamilyV1Schema>;

export const PUBLIC_PROOF_BUNDLE_SCHEMA_VERSION_V1 = 'public-proof-bundle/v1';

/** Minimum entropy for a public id, in bytes. 24 bytes = 192 bits: not
 * enumerable, not derived from any internal identifier, and never a counter. */
export const PUBLIC_PROOF_ID_BYTES_V1 = 24;

export const PublicProofIdV1Schema = z
  .string()
  .regex(/^[0-9a-f]{48,}$/, 'A public proof id is at least 24 random bytes as lowercase hex');

// ---------------------------------------------------------------------------
// The share record
// ---------------------------------------------------------------------------

/**
 * The mapping from an unguessable id to a proof. It holds no proof content, so
 * revoking it removes access and changes no financial record; and a revoked id
 * is never reissued, so a link that once worked cannot silently come back.
 */
export const PublicProofShareV1Schema = z
  .object({
    schemaVersion: z.literal('public-proof-share/v1'),
    publicId: PublicProofIdV1Schema,
    tenantId: TenantIdV1Schema,
    proofFamily: ProofFamilyV1Schema,
    proofId: EntityIdV1Schema,
    createdAt: TimestampV1Schema,
    revokedAt: TimestampV1Schema.nullable(),
    bundleSchemaVersion: z.literal(PUBLIC_PROOF_BUNDLE_SCHEMA_VERSION_V1),
  })
  .strict();
export type PublicProofShareV1 = z.infer<typeof PublicProofShareV1Schema>;

/** What little provider context a bundle carries. Every field is nullable
 * because "we do not know which provider quoted this" is a real answer, and
 * inventing one would be the only alternative. */
export const PublicProofProviderV1Schema = z
  .object({
    providerId: z.string().min(1).max(120).nullable(),
    providerName: z.string().min(1).max(200).nullable(),
    sourceKey: z.string().min(1).max(300).nullable(),
  })
  .strict();
export type PublicProofProviderV1 = z.infer<typeof PublicProofProviderV1Schema>;

// ---------------------------------------------------------------------------
// The bundles
// ---------------------------------------------------------------------------

const PublicProofBundleCommonV1 = {
  schemaVersion: z.literal(PUBLIC_PROOF_BUNDLE_SCHEMA_VERSION_V1),
  publicProofId: PublicProofIdV1Schema,
  /** When the SHARE was created, not when this copy was served. A bundle
   * fetched twice must be byte-identical, which it cannot be if it carries the
   * time of the request. */
  issuedAt: TimestampV1Schema,
  provider: PublicProofProviderV1Schema.nullable(),
  bundleHash: HashV1Schema,
} as const;

const PublicRouteProofBundleV1ObjectSchema = z
  .object({
    ...PublicProofBundleCommonV1,
    proofFamily: z.literal('route'),
    /** The canonical RouteProofV1, not a UI projection: a verifier that cannot
     * recompute proofHash cannot verify anything. */
    proof: RouteProofV1Schema,
    events: z.array(RouteProofEventV1Schema),
  })
  .strict();
export type PublicRouteProofBundleV1 = z.infer<typeof PublicRouteProofBundleV1ObjectSchema>;

const PublicNftProofBundleV1ObjectSchema = z
  .object({
    ...PublicProofBundleCommonV1,
    proofFamily: z.literal('nft'),
    proof: NftPurchaseProofV1Schema,
    events: z.array(NftProofEventV1Schema),
  })
  .strict();
export type PublicNftProofBundleV1 = z.infer<typeof PublicNftProofBundleV1ObjectSchema>;

export type PublicProofBundleV1 = PublicRouteProofBundleV1 | PublicNftProofBundleV1;

/**
 * The bundle hash covers everything except itself.
 *
 * Unlike the entity hashes elsewhere in this codebase it does NOT exclude
 * lifecycle fields: a bundle is a published artefact rather than a row that
 * evolves, so every byte of it is part of what was published. Change any field
 * — a receipt status, an event payload, the issued time — and this hash moves.
 */
export function hashPublicProofBundleV1(value: Record<string, unknown>): HashV1 {
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'bundleHash'));
  return stableHashV1('public-proof-bundle/v1', canonicalJsonValueV1(rest));
}

function refineBundleHash(value: { bundleHash: string }, ctx: z.RefinementCtx): void {
  const expected = hashPublicProofBundleV1(value as unknown as Record<string, unknown>);
  if (value.bundleHash !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bundleHash'],
      message: 'bundleHash does not match the bundle content',
    });
  }
}

export const PublicRouteProofBundleV1Schema =
  PublicRouteProofBundleV1ObjectSchema.superRefine(refineBundleHash);
export const PublicNftProofBundleV1Schema =
  PublicNftProofBundleV1ObjectSchema.superRefine(refineBundleHash);

/** The wire union. `proofFamily` is the discriminator, so a malformed bundle
 * gets the errors of the family it claims rather than a union-wide mush. */
export const PublicProofBundleV1Schema = z
  .discriminatedUnion('proofFamily', [
    PublicRouteProofBundleV1ObjectSchema,
    PublicNftProofBundleV1ObjectSchema,
  ])
  .superRefine(refineBundleHash);

/** Seals a draft bundle by computing its hash. The only supported way to build
 * one — a hand-assembled `bundleHash` would parse only if it were correct
 * anyway. */
export function sealPublicProofBundleV1<T extends Record<string, unknown>>(
  draft: Omit<T, 'bundleHash'>,
): T {
  const sealed = { ...draft, bundleHash: hashPublicProofBundleV1(draft as Record<string, unknown>) };
  return sealed as unknown as T;
}

// ---------------------------------------------------------------------------
// Verification result
// ---------------------------------------------------------------------------

/** One named check. `skipped` is a first-class outcome: NFT proof events carry
 * a sequence rather than a previous-hash chain, and reporting "passed" for a
 * chain that was never checked would be a lie of exactly the kind this whole
 * feature exists to avoid. */
export const PublicProofCheckV1Schema = z
  .object({
    key: z.string().min(1).max(80),
    label: z.string().min(1).max(160),
    outcome: z.enum(['passed', 'failed', 'skipped']),
    detail: z.string().max(400).nullable(),
  })
  .strict();
export type PublicProofCheckV1 = z.infer<typeof PublicProofCheckV1Schema>;

export const PublicProofVerificationResultV1Schema = z
  .object({
    schemaVersion: z.literal('public-proof-verification/v1'),
    /** True only when no check failed. A skipped check never makes this false
     * and never makes it true on its own. */
    valid: z.boolean(),
    proofFamily: ProofFamilyV1Schema.nullable(),
    bundleHash: HashV1Schema.nullable(),
    proofHash: HashV1Schema.nullable(),
    checks: z.array(PublicProofCheckV1Schema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const failed = value.checks.some((check) => check.outcome === 'failed');
    if (value.valid === failed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valid'],
        message: 'valid must be true exactly when no check failed',
      });
    }
  });
export type PublicProofVerificationResultV1 = z.infer<typeof PublicProofVerificationResultV1Schema>;
