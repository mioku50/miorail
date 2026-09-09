import { z } from 'zod';

// ---------------------------------------------------------------------------
// The Stocks answer contract, shared by the server that produces it and the
// screen that renders it.
//
// It lives here rather than beside the verifier because a contract with two
// ends needs one definition. The verifier, the narrator and the evidence
// builder stay in the API: they are how an answer is MADE, and nothing in the
// browser should be able to make one.
//
// Phase 13.2A measured whether a model can be held to this shape before any of
// it reached a reader. Phase 13.2 is that surface.
// ---------------------------------------------------------------------------

export const STOCKS_EVIDENCE_KINDS_V1 = [
  'question',
  'universe',
  'coverage',
  'identity',
  'supply',
  'route_status',
  'quote',
  'observation',
  'reference',
  'basis',
  'pool',
  'provider_failure',
  'history',
] as const;
export type StocksEvidenceKindV1 = (typeof STOCKS_EVIDENCE_KINDS_V1)[number];

export const StocksEvidenceItemV1Schema = z
  .object({
    /** Citation handle, stable within one bundle. */
    id: z.string().min(1).max(20),
    kind: z.enum(STOCKS_EVIDENCE_KINDS_V1),
    /** The exact representation this row is about, or null when it is about
     * the question or the corpus. */
    subject: z.string().min(1).max(60).nullable(),
    label: z.string().min(1).max(300),
    value: z.string().min(1).max(600),
  })
  .strict();
export type StocksEvidenceItemV1 = z.infer<typeof StocksEvidenceItemV1Schema>;

export const StocksNarrationClaimV1Schema = z
  .object({
    claim: z.string().min(1).max(400),
    /** Evidence ids this claim stands on. At least one, always. */
    sourceIds: z.array(z.string().min(1).max(20)).min(1).max(8),
  })
  .strict();
export type StocksNarrationClaimV1 = z.infer<typeof StocksNarrationClaimV1Schema>;

export const STOCKS_EXPLANATION_MAX_CHARS_V1 = 1_200;

export const StocksNarrationV1Schema = z
  .object({
    /** Exact representation addresses this answer is about. */
    subjects: z.array(z.string().min(1).max(60)).min(1).max(16),
    /** Factual claims present in the bundle, each with its citation. */
    established: z.array(StocksNarrationClaimV1Schema).max(24),
    /** Facts Miorail explicitly cannot prove. */
    notEstablished: z.array(z.string().min(1).max(300)).max(24),
    explanation: z.string().min(1).max(STOCKS_EXPLANATION_MAX_CHARS_V1),
    /** Typed provenance: the union of every citation above. */
    sources: z.array(z.string().min(1).max(20)).max(64),
  })
  .strict();
export type StocksNarrationV1 = z.infer<typeof StocksNarrationV1Schema>;

/**
 * Which answer the reader got.
 *
 * On the wire rather than inferred from the prose, because "a model wrote
 * this" and "the deterministic builder wrote this" are different provenance
 * and a reader is entitled to know which.
 */
export const STOCKS_ANSWER_SOURCES_V1 = ['deterministic_evidence', 'verified_narration'] as const;
export type StocksAnswerSourceV1 = (typeof STOCKS_ANSWER_SOURCES_V1)[number];

export const StocksAskResponseV1Schema = z
  .object({
    schemaVersion: z.literal('stocks-ask/v1'),
    /** The exact question the evidence was assembled for — echoed so a reader
     * cannot be shown an answer to a different size than the one on screen. */
    question: z
      .object({
        underlyingKey: z.string().min(1).max(200),
        direction: z.enum(['buy', 'sell']),
        requestedCashAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/),
        destination: z.enum(['USDC', 'ETH']),
        asked: z.string().min(1).max(1_000),
      })
      .strict(),
    answer: StocksNarrationV1Schema,
    answerSource: z.enum(STOCKS_ANSWER_SOURCES_V1),
    /** Every row the answer could have cited, so the screen can show the
     * provenance rather than asking the reader to trust a citation id. */
    evidence: z.array(StocksEvidenceItemV1Schema).max(200),
    /** True when this surface will not answer the question at all — out of
     * what Miorail measures, refused before any evidence was read. */
    refused: z.boolean(),
    /**
     * Read-only, stated on the wire.
     *
     * The narrator is handed two messages and no capability; these literals
     * say so to anything that consumes this payload without reading the
     * server.
     */
    quoteOnly: z.literal(true),
    executionEvidenceIncluded: z.literal(false),
    assembledAt: z.string().datetime(),
  })
  .strict();
export type StocksAskResponseV1 = z.infer<typeof StocksAskResponseV1Schema>;
