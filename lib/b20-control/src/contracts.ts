import { z } from 'zod';
import {
  AddressV1Schema,
  EntityIdV1Schema,
  HashV1Schema,
  HexDataV1Schema,
  TenantIdV1Schema,
  TimestampV1Schema,
  ZERO_HASH_V1,
  financialContentV1,
  stableHashV1,
  type HashV1,
} from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T67C — the B20 Control contract family.
//
// This card answers one question: what can whoever controls this token do to
// it, and what is the state of those controls at one exact block. It is
// deliberately NOT a safety verdict. There is no score, no percentage, no
// "safe"/"unsafe", and no field that could be rendered as one — the schemas
// below have nowhere to put such a value, which is the strongest form the
// prohibition can take.
//
// Two rules run through every schema:
//
//   1. IDENTITY IS chainId + tokenAddress. Name, symbol and any image are
//      mutable by METADATA_ROLE on a live token, so they are carried for
//      display and excluded from every identity and content hash. A card
//      whose hash changed because an issuer renamed the token would be a
//      different card about the same token.
//
//   2. EVERY ROW CARRIES ITS OWN STATUS. A field is not a value with a
//      nullable hole; it is a value OR a stated reason there is no value.
//      "Unavailable" and "zero" are different answers and are never merged.
// ---------------------------------------------------------------------------

export const B20VariantV1Schema = z.enum(['asset', 'stablecoin']);
export type B20VariantV1 = z.infer<typeof B20VariantV1Schema>;

/** Identity only. Nothing an issuer can rename appears here. */
export const B20TokenRefV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: AddressV1Schema,
  })
  .strict();
export type B20TokenRefV1 = z.infer<typeof B20TokenRefV1Schema>;

export function b20TokenIdentityHashV1(ref: B20TokenRefV1): HashV1 {
  return stableHashV1('b20-token-identity/v1', {
    chainId: ref.chainId,
    tokenAddress: ref.tokenAddress.toLowerCase(),
  });
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Why an address is or is not treated as a B20 token.
 *
 * `not_b20` and `rpc_failure` are separate members because they are separate
 * facts: one says the chain answered and the answer was no, the other says
 * nobody answered. Collapsing them would let an outage read as a verdict.
 */
export const B20DetectionOutcomeV1Schema = z.enum([
  /** B20Factory.isB20 returned true. */
  'b20',
  /** B20Factory.isB20 returned false. An ordinary address. */
  'not_b20',
  /** isB20 was true but isB20Initialized was false — created, not finished. */
  'b20_uninitialised',
  /** The factory returned empty data: B20 did not exist at this block. */
  'unavailable_at_block',
  /** The endpoint failed. NOT a statement about the token. */
  'rpc_failure',
  /** The address is not a well-formed 20-byte address. */
  'invalid_address',
  /** A chain this card does not read. */
  'unsupported_chain',
]);
export type B20DetectionOutcomeV1 = z.infer<typeof B20DetectionOutcomeV1Schema>;

export const B20DetectionResultV1Schema = z
  .object({
    schemaVersion: z.literal('b20-detection-result/v1'),
    outcome: B20DetectionOutcomeV1Schema,
    token: B20TokenRefV1Schema.nullable(),
    /** Present only when the factory confirmed the token. */
    variant: B20VariantV1Schema.nullable(),
    /** The variant the ADDRESS SHAPE suggests. A hint that was checked against
     * the factory, never a substitute for it. */
    addressVariantHint: B20VariantV1Schema.nullable(),
    /** Whether the Activation Registry reported this variant live at the
     * observed block. Null when it was not reached. */
    variantActivated: z.boolean().nullable(),
    blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
    blockHash: HashV1Schema.nullable(),
    observedAt: TimestampV1Schema,
    /** Redacted transport detail. Never contains a URL or a key. */
    detail: z.string().max(300).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome === 'b20' && value.variant === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variant'],
        message: 'A confirmed B20 token must carry the variant the factory agreed to',
      });
    }
    if (value.outcome !== 'b20' && value.outcome !== 'b20_uninitialised' && value.variant !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variant'],
        message: 'Only a confirmed B20 token may carry a variant',
      });
    }
  });
export type B20DetectionResultV1 = z.infer<typeof B20DetectionResultV1Schema>;

// ---------------------------------------------------------------------------
// Control fields
// ---------------------------------------------------------------------------

/**
 * The status of ONE row on the card.
 *
 * Every member is a different sentence a user can be told. None of them is a
 * grade.
 */
export const B20FieldStatusV1Schema = z.enum([
  /** Read from the chain at the pinned block. The value is exact. */
  'exact_chain_read',
  /** The read did not answer. No value is shown. */
  'unavailable',
  /** This B20 variant has no such method — the call reverted for that reason. */
  'unsupported_by_variant',
  /** Documented as future work and not readable today. Never shown as active. */
  'planned_not_active',
  /** Two official sources disagree. The value is withheld, and the row says so. */
  'conflicting_evidence',
]);
export type B20FieldStatusV1 = z.infer<typeof B20FieldStatusV1Schema>;

/** The named rows this card can carry. Adding one requires a confirmed read
 * method in the research note — the union is what enforces that. */
export const B20ControlFieldKeyV1Schema = z.enum([
  'token_name',
  'token_symbol',
  'token_decimals',
  'token_variant',
  'total_supply',
  'supply_cap',
  'paused_features',
  'transfer_sender_policy',
  'transfer_receiver_policy',
  'transfer_executor_policy',
  'mint_receiver_policy',
  'rebase_multiplier',
  'stablecoin_currency',
  'contract_uri',
  'admin_role_holder',
  'freeze_and_seize',
]);
export type B20ControlFieldKeyV1 = z.infer<typeof B20ControlFieldKeyV1Schema>;

export const B20ControlFieldV1Schema = z
  .object({
    key: B20ControlFieldKeyV1Schema,
    /** Short human label. Display only; not hashed into identity. */
    label: z.string().min(1).max(120),
    status: B20FieldStatusV1Schema,
    /** The decoded value, as a display string. Null whenever status is not
     * `exact_chain_read` — there is no "probably" value on this card. */
    value: z.string().max(500).nullable(),
    /** Why there is no value, when there is none. Required in that case. */
    reason: z.string().max(300).nullable(),
    /** The evidence record backing this row, when it was read. */
    evidenceHash: HashV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'exact_chain_read') {
      if (value.value === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'An exact chain read must carry the value it read',
        });
      }
      if (value.evidenceHash === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidenceHash'],
          message: 'An exact chain read must be backed by its evidence record',
        });
      }
    } else {
      if (value.value !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'Only an exact chain read may carry a value',
        });
      }
      if (value.reason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reason'],
          message: 'A row without a value must say why',
        });
      }
    }
  });
export type B20ControlFieldV1 = z.infer<typeof B20ControlFieldV1Schema>;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const B20ControlEvidenceV1Schema = z
  .object({
    schemaVersion: z.literal('b20-control-evidence/v1'),
    evidenceHash: HashV1Schema,
    chainId: z.literal(8453),
    tokenAddress: AddressV1Schema,
    /** The contract actually called: the token, the factory or a registry. */
    target: AddressV1Schema,
    blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
    blockHash: HashV1Schema,
    methodSignature: z.string().min(3).max(120),
    selector: z.string().regex(/^0x[0-9a-f]{8}$/),
    /** Hash of the raw response, so the decode can be re-checked without
     * storing an unbounded blob. */
    rawResponseHash: HashV1Schema,
    /** What the raw bytes decoded to, as a display string, or null when the
     * call reverted or returned nothing readable. */
    decodedValue: z.string().max(500).nullable(),
    /** Set when the call reverted: the revert selector, classified. */
    revertSelector: z.string().regex(/^0x[0-9a-f]{8}$/).nullable(),
    observedAt: TimestampV1Schema,
    /** The only verification this card claims. There is no other member. */
    verification: z.literal('exact_chain_read'),
    /** The interface revision these selectors came from. Not a URL and not a
     * credential — a version string from the research note. */
    sourceVersion: z.string().min(1).max(120),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected = hashB20EvidenceV1(value);
    if (value.evidenceHash !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceHash'],
        message: 'evidenceHash does not match the evidence content',
      });
    }
  });
export type B20ControlEvidenceV1 = z.infer<typeof B20ControlEvidenceV1Schema>;

export function hashB20EvidenceV1(value: Record<string, unknown>): HashV1 {
  return stableHashV1('b20-control-evidence/v1', financialContentV1(value, ['evidenceHash']));
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export const B20SnapshotStatusV1Schema = z.enum(['complete', 'partial', 'not_b20', 'failed']);
export type B20SnapshotStatusV1 = z.infer<typeof B20SnapshotStatusV1Schema>;

export const B20ControlSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal('b20-control-snapshot/v1'),
    id: EntityIdV1Schema,
    tenantId: TenantIdV1Schema,
    chainId: z.literal(8453),
    tokenAddress: AddressV1Schema,
    createdAt: TimestampV1Schema,
    updatedAt: TimestampV1Schema,
    status: B20SnapshotStatusV1Schema,
    snapshotHash: HashV1Schema,
    identityHash: HashV1Schema,
    detection: B20DetectionResultV1Schema,
    /** THE block. Every field on this snapshot was read at exactly this one;
     * a snapshot spanning two blocks is not a snapshot. */
    blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
    blockHash: HashV1Schema.nullable(),
    fields: z.array(B20ControlFieldV1Schema).max(64),
    evidence: z.array(B20ControlEvidenceV1Schema).max(64),
    observedAt: TimestampV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected = hashB20SnapshotV1(value);
    if (value.snapshotHash !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshotHash'],
        message: 'snapshotHash does not match the snapshot content',
      });
    }
    if (value.identityHash !== b20TokenIdentityHashV1({ chainId: value.chainId, tokenAddress: value.tokenAddress })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identityHash'],
        message: 'identityHash does not match chainId + tokenAddress',
      });
    }
    // One block for the whole snapshot. Evidence read at another block is
    // evidence about another state of the world.
    for (const [index, record] of value.evidence.entries()) {
      if (value.blockNumber !== null && record.blockNumber !== value.blockNumber) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence', index, 'blockNumber'],
          message: 'Every evidence record must be read at the snapshot block',
        });
      }
      if (value.blockHash !== null && record.blockHash !== value.blockHash) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence', index, 'blockHash'],
          message: 'Every evidence record must be read at the snapshot block hash',
        });
      }
    }
    const known = new Set(value.evidence.map((record) => record.evidenceHash));
    for (const [index, field] of value.fields.entries()) {
      if (field.evidenceHash !== null && !known.has(field.evidenceHash)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', index, 'evidenceHash'],
          message: 'A field cites evidence that is not part of this snapshot',
        });
      }
    }
    if (value.status === 'complete' && value.fields.some((field) => field.status === 'unavailable')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'A snapshot with an unavailable field is partial, not complete',
      });
    }
  });
export type B20ControlSnapshotV1 = z.infer<typeof B20ControlSnapshotV1Schema>;

export function hashB20SnapshotV1(value: Record<string, unknown>): HashV1 {
  return stableHashV1('b20-control-snapshot/v1', financialContentV1(value, ['snapshotHash']));
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

/**
 * One plain sentence about what a control permits.
 *
 * `holder` is deliberately absent. B20 exposes `hasRole(role, account)` and no
 * enumeration whatsoever, so who holds a power is not readable — see the
 * research note §6. A card that named an issuer would be making it up.
 */
export const B20ControlStatementV1Schema = z
  .object({
    /** Stable key, so the UI is not parsing prose. */
    key: z.string().min(1).max(60),
    /** What the control permits, stated as a capability of the token — never
     * as a prediction about what anyone will do with it. */
    statement: z.string().min(1).max(300),
    /** Whether the control is currently constrained, open, or unknown. */
    observedState: z.enum(['constrained', 'unconstrained', 'unknown']),
    /** Evidence for `observedState`, when there is any. */
    evidenceHash: HashV1Schema.nullable(),
  })
  .strict();
export type B20ControlStatementV1 = z.infer<typeof B20ControlStatementV1Schema>;

export const B20ControlCardV1Schema = z
  .object({
    schemaVersion: z.literal('b20-control-card/v1'),
    cardHash: HashV1Schema,
    snapshotId: EntityIdV1Schema,
    snapshotHash: HashV1Schema,
    identityHash: HashV1Schema,
    chainId: z.literal(8453),
    tokenAddress: AddressV1Schema,
    /** Display metadata. Mutable by METADATA_ROLE, so excluded from the hash
     * below and never part of identity. */
    displayName: z.string().max(200).nullable(),
    displaySymbol: z.string().max(60).nullable(),
    variant: B20VariantV1Schema.nullable(),
    detectionOutcome: B20DetectionOutcomeV1Schema,
    blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
    blockHash: HashV1Schema.nullable(),
    observedAt: TimestampV1Schema,
    fields: z.array(B20ControlFieldV1Schema).max(64),
    statements: z.array(B20ControlStatementV1Schema).max(32),
    /** Rows the card could not fill, restated so the gap is visible rather
     * than simply missing from the list. */
    unavailable: z.array(z.string().max(200)).max(32),
    /** What this card does not cover. Fixed copy, so the boundary is on the
     * screen and not only in a task description. */
    boundaries: z.array(z.string().max(200)).max(16),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.cardHash !== hashB20CardV1(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cardHash'],
        message: 'cardHash does not match the card content',
      });
    }
  });
export type B20ControlCardV1 = z.infer<typeof B20ControlCardV1Schema>;

/** Display metadata is excluded: a renamed token is the same token. */
export function hashB20CardV1(value: Record<string, unknown>): HashV1 {
  return stableHashV1(
    'b20-control-card/v1',
    financialContentV1(value, ['cardHash', 'displayName', 'displaySymbol']),
  );
}

export { ZERO_HASH_V1, HexDataV1Schema };
