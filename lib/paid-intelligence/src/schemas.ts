import { z } from 'zod';

// T59 — the fixed, closed contract every simulation provider response is
// validated against (decision 2). Any deviation is `invalid_response` and
// fails closed: SimulationStateV1 can only ever reach 'passed' through a
// value that parsed against this exact schema.
export const SimulationProviderStateChangeV1Schema = z
  .object({
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Expected a 20-byte EVM address'),
    kind: z.enum(['balance', 'storage', 'token']),
    summary: z.string().min(1).max(500),
  })
  .strict();
export type SimulationProviderStateChangeV1 = z.infer<typeof SimulationProviderStateChangeV1Schema>;

// T63B — per-call detail. ADDITIVE and optional: the T59 generic provider does
// not send it and keeps parsing unchanged, while a provider that simulates the
// Blueprint call-by-call (Alchemy eth_simulateV1) can report the exact outcome
// of each call in Blueprint order.
export const SimulationCallResultV1Schema = z
  .object({
    /** Position in the persisted Blueprint's call list. */
    index: z.number().int().nonnegative().max(999),
    status: z.enum(['success', 'reverted']),
    gasUsed: z
      .string()
      .max(32)
      .regex(/^(0|[1-9][0-9]*)$/, 'Expected an unsigned base-unit integer string'),
    revertReason: z.string().min(1).max(1000).nullable(),
    /** How many logs the call emitted — the count the asset changes below were
     * decoded from, so an empty change list next to a non-zero count is
     * visibly "not decodable", not "nothing happened". */
    logCount: z.number().int().nonnegative().max(10_000),
    /** Exact EVM bytes, when the provider returned them. A missing value is
     * unread, while `0x` is a measured empty return. Call status remains
     * authoritative: revert data is not a successfully read state value. */
    returnData: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(200_000).optional(),
  })
  .strict();
export type SimulationCallResultV1 = z.infer<typeof SimulationCallResultV1Schema>;

/** Code-owned view probes around a batch. They are simulated, never included
 * in the approved wallet calls. No sender, value, overrides or client policy
 * can enter through this shape. The caller owns the getter ABI/identity. */
export const SimulationObservationCallV1Schema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){4,}$/).max(8_194),
}).strict();
export type SimulationObservationCallV1 = z.infer<typeof SimulationObservationCallV1Schema>;

export const SimulationObservationRequestV1Schema = z.object({
  before: z.array(SimulationObservationCallV1Schema).max(8),
  after: z.array(SimulationObservationCallV1Schema).max(8),
}).strict().superRefine((value, ctx) => {
  if (value.before.length + value.after.length === 0) ctx.addIssue({
    code: z.ZodIssueCode.custom, message: 'An observation request needs at least one probe',
  });
  for (const phase of ['before', 'after'] as const) {
    if (new Set(value[phase].map((entry) => entry.id)).size !== value[phase].length) ctx.addIssue({
      code: z.ZodIssueCode.custom, path: [phase], message: 'Observation ids must be unique within each phase',
    });
  }
});

export const SimulationObservationResultV1Schema = SimulationObservationCallV1Schema.extend({
  phase: z.enum(['before', 'after']),
  status: z.literal('success'),
  returnData: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(200_000),
}).strict();
export type SimulationObservationResultV1 = z.infer<typeof SimulationObservationResultV1Schema>;

export const SimulationObservationsV1Schema = z.object({
  /** Binds phase/id/target/calldata, the wallet, chain and approved callsHash. */
  requestHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  results: z.array(SimulationObservationResultV1Schema).min(1).max(16),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  let sawAfter = false;
  for (const [index, entry] of value.results.entries()) {
    const key = `${entry.phase}:${entry.id}`;
    if (ids.has(key) || (entry.phase === 'before' && sawAfter)) ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['results', index], message: 'Observation results must retain their unique phase order',
    });
    ids.add(key);
    if (entry.phase === 'after') sawAfter = true;
  }
  for (const phase of ['before', 'after'] as const) {
    if (value.results.filter((entry) => entry.phase === phase).length > 8) ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['results'], message: 'An observation phase has too many probes',
    });
  }
});
export type SimulationObservationsV1 = z.infer<typeof SimulationObservationsV1Schema>;

/** A single asset movement PROVEN by a decoded event log. Deliberately carries
 * no symbol/decimals: those are not in the log, and inventing them would be a
 * claim the simulation never made. */
export const SimulationAssetChangeV1Schema = z
  .object({
    kind: z.enum(['erc20_transfer', 'weth_deposit', 'weth_withdrawal']),
    /** The emitting token contract. */
    token: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Expected a 20-byte EVM address'),
    /** Relative to the authenticated wallet only. */
    direction: z.enum(['in', 'out']),
    amountAtomic: z
      .string()
      .max(78)
      .regex(/^(0|[1-9][0-9]*)$/, 'Expected an unsigned base-unit integer string'),
    counterparty: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable(),
    callIndex: z.number().int().nonnegative().max(999),
  })
  .strict();
export type SimulationAssetChangeV1 = z.infer<typeof SimulationAssetChangeV1Schema>;

/**
 * T63B §5 — asset changes are a SEPARATE, explicitly-statused block: a
 * simulation can pass while its asset effects remain unprovable (no logs, an
 * undecodable event, a native-ETH movement that emits nothing). `unavailable`
 * says exactly that instead of implying "no assets moved", and it never
 * upgrades into a Safety Score.
 */
export const SimulationAssetChangesV1Schema = z
  .object({
    status: z.enum(['available', 'unavailable']),
    unavailableReason: z.string().min(1).max(200).nullable(),
    changes: z.array(SimulationAssetChangeV1Schema).max(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'unavailable' && value.changes.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['changes'],
        message: 'Unavailable asset changes must not carry decoded changes',
      });
    }
    if (value.status === 'unavailable' && value.unavailableReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unavailableReason'],
        message: 'Unavailable asset changes require an explicit reason',
      });
    }
    if (value.status === 'available' && value.unavailableReason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unavailableReason'],
        message: 'Available asset changes must not carry an unavailable reason',
      });
    }
  });
export type SimulationAssetChangesV1 = z.infer<typeof SimulationAssetChangesV1Schema>;

export const SimulationProviderResponseV1Schema = z
  .object({
    status: z.enum(['success', 'reverted']),
    blockNumber: z.number().int().positive(),
    // Rework N2: hard size bounds so an adversarial provider cannot smuggle
    // unbounded payloads through an otherwise-"valid" response.
    gasUsed: z
      .string()
      .max(32)
      .regex(/^(0|[1-9][0-9]*)$/, 'Expected an unsigned base-unit integer string'),
    stateChanges: z.array(SimulationProviderStateChangeV1Schema).max(100),
    revertReason: z.string().min(1).max(1000).nullable(),
    // T63B additive detail — optional so every T59-era provider payload still
    // parses byte-for-byte identically.
    callResults: z.array(SimulationCallResultV1Schema).max(100).optional(),
    /** Index of the FIRST reverted call, or null when every call succeeded. */
    failedCallIndex: z.number().int().nonnegative().max(999).nullable().optional(),
    assetChanges: SimulationAssetChangesV1Schema.optional(),
    observations: SimulationObservationsV1Schema.optional(),
  })
  .strict();
export type SimulationProviderResponseV1 = z.infer<typeof SimulationProviderResponseV1Schema>;

// Whitelist-only request body sent to the provider — never chat history,
// email, tenantId, or any other metadata (decision 2 / boundary section).
export const SimulationProviderRequestBodyV1Schema = z
  .object({
    chainId: z.literal(8453),
    from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    calls: z
      .array(
        z
          .object({
            to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            value: z.string().regex(/^(0|[1-9][0-9]*)$/),
            data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    blockTag: z.literal('latest'),
  })
  .strict();
export type SimulationProviderRequestBodyV1 = z.infer<typeof SimulationProviderRequestBodyV1Schema>;
