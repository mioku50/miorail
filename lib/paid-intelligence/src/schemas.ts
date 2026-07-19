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
