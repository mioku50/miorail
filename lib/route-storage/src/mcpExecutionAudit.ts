import { z } from 'zod';

// ---------------------------------------------------------------------------
// T72-C §1/§2 — what an assistant did with a wallet's credential.
//
// The shape is deliberately narrow. Every field is an identifier with a
// checked shape or a value from a closed vocabulary; there is no free-text
// column, no body, no message and no URL. That is not tidiness — it is the
// reason a bearer token, a piece of calldata or an RPC endpoint cannot end up
// in this table by an ordinary mistake. There is nowhere to put one.
//
// `callsHash` is the one thing here that touches execution, and it is a digest:
// it proves WHICH batch was released without being the batch.
// ---------------------------------------------------------------------------

/**
 * Which assistant a handoff grant was issued to.
 *
 * A closed vocabulary, because this column lives in a table whose whole rule is
 * that there is nowhere to put free text (see 0031). `other` is a client the
 * user NAMED and we do not list; the absence of a value — null — is "not
 * recorded", which every row written before Connected Apps existed is. Those
 * two are never collapsed: one is a statement, the other is a gap.
 */
export const MCP_CLIENT_KINDS_V1 = ['claude', 'chatgpt', 'hermes', 'other'] as const;
export type McpClientKindV1 = (typeof MCP_CLIENT_KINDS_V1)[number];

export function mcpClientKindV1(value: unknown): McpClientKindV1 | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return (MCP_CLIENT_KINDS_V1 as readonly string[]).includes(normalized)
    ? (normalized as McpClientKindV1)
    : null;
}

export const MCP_AUDIT_OUTCOMES_V1 = [
  'token_issued',
  'plan_read',
  'action_released',
  'submission_recorded',
  'user_rejected',
  'submitted_unknown',
  'entry_succeeded',
  'entry_reverted',
  'reconciliation_required',
  'refused',
] as const;
export type McpAuditOutcomeV1 = (typeof MCP_AUDIT_OUTCOMES_V1)[number];

/**
 * The outcomes that record something IRREVERSIBLE having been made possible.
 *
 * §2: an audit write that fails for one of these must refuse the action. The
 * distinction is not "write vs read" — it is whether a missing row would leave
 * the user unable to find out that executable bytes left the server.
 */
export const MCP_AUDIT_MANDATORY_OUTCOMES_V1: readonly McpAuditOutcomeV1[] = [
  'action_released',
  'submission_recorded',
];

export function mcpAuditIsMandatoryV1(outcome: McpAuditOutcomeV1): boolean {
  return MCP_AUDIT_MANDATORY_OUTCOMES_V1.includes(outcome);
}

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
const HASH_V1 = /^0x[0-9a-f]{64}$/;

export const McpExecutionAuditV1Schema = z
  .object({
    schemaVersion: z.literal('mcp-execution-audit/v1'),
    id: z.string().min(1).max(200),
    /** The handoff token's opaque id, or 'session'. NEVER the token itself. */
    tokenId: z.string().min(1).max(100),
    tenantId: z.string().min(1).max(200),
    walletAddress: z.string().regex(ADDRESS_V1),
    toolName: z.string().min(1).max(80),
    planId: z.string().min(1).max(200).nullable(),
    callsHash: z.string().regex(HASH_V1).nullable(),
    batchId: z.string().min(1).max(200).nullable(),
    outcome: z.enum(MCP_AUDIT_OUTCOMES_V1),
    /** Which assistant this grant was handed to. Only ever set on the
     * `token_issued` row: a grant's client is a fact about the moment of
     * issuance, and this table cannot be updated afterwards. */
    clientKind: z.enum(MCP_CLIENT_KINDS_V1).nullable(),
    createdAt: z.string().min(1).max(60),
  })
  .strict();
export type McpExecutionAuditV1 = z.infer<typeof McpExecutionAuditV1Schema>;

/**
 * The one place a candidate row is checked before it reaches storage.
 *
 * `.strict()` above does most of the work: a caller that tries to attach a
 * `token`, a `calldata` or a `response` field gets a parse failure rather than
 * a silently dropped property. That matters more than it looks — a dropped
 * property would mean the guarantee held today and quietly stopped holding
 * whenever somebody switched the parse to a passthrough.
 */
export function assertMcpAuditV1(value: unknown, direction: 'read' | 'write'): McpExecutionAuditV1 {
  const parsed = McpExecutionAuditV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new McpAuditWriteError(
      `An MCP audit row failed validation on ${direction}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}

/** Thrown when a row cannot be written. Callers treat this as fatal for a
 * mandatory outcome and as a warning for a read. */
export class McpAuditWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpAuditWriteError';
  }
}

export interface McpAuditQueryV1 {
  tenantId: string;
  limit?: number;
}

export interface McpExecutionAuditRepositoryV1 {
  /** Appends one row. Idempotent on `id`: a retried call with the same id
   * returns the stored row rather than writing a second. */
  record(entry: McpExecutionAuditV1): Promise<McpExecutionAuditV1>;
  listForTenant(query: McpAuditQueryV1): Promise<McpExecutionAuditV1[]>;
  listForPlan(input: { tenantId: string; planId: string }): Promise<McpExecutionAuditV1[]>;
}

// --- §3: revocation ---------------------------------------------------------

export interface McpHandoffRevocationV1 {
  tokenId: string;
  tenantId: string;
  revokedAt: string;
  expiresAt: string;
}

export interface McpHandoffRevocationRepositoryV1 {
  /** Idempotent: revoking twice is one revocation. */
  revoke(input: McpHandoffRevocationV1): Promise<void>;
  isRevoked(input: { tokenId: string; tenantId: string }): Promise<boolean>;
  listForTenant(tenantId: string): Promise<McpHandoffRevocationV1[]>;
}

/**
 * The audit row for a tool call, built in one place.
 *
 * Every caller goes through this rather than assembling the object, so the
 * schemaVersion, the lowercasing and the id are not things a call site can get
 * subtly different from its neighbour.
 */
export function mcpAuditRowV1(input: {
  id: string;
  tokenId: string;
  tenantId: string;
  walletAddress: string;
  toolName: string;
  outcome: McpAuditOutcomeV1;
  planId?: string | null;
  callsHash?: string | null;
  batchId?: string | null;
  clientKind?: McpClientKindV1 | null;
  now: Date;
}): McpExecutionAuditV1 {
  return assertMcpAuditV1(
    {
      schemaVersion: 'mcp-execution-audit/v1',
      id: input.id,
      tokenId: input.tokenId,
      tenantId: input.tenantId,
      walletAddress: input.walletAddress.toLowerCase(),
      toolName: input.toolName,
      planId: input.planId ?? null,
      callsHash: input.callsHash ? input.callsHash.toLowerCase() : null,
      batchId: input.batchId ?? null,
      outcome: input.outcome,
      clientKind: input.clientKind ?? null,
      createdAt: input.now.toISOString(),
    },
    'write',
  );
}
