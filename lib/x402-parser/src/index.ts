import { z } from 'zod';

export const x402PaymentOptionSchema = z.object({
  amount: z.string(),
  payTo: z.string(),
  asset: z.string(),
  network: z.string(),
  version: z.string().optional(),
  maxTimeoutSeconds: z.number().optional(),
  extra: z.record(z.unknown()).optional(),
});

export type X402PaymentOption = z.infer<typeof x402PaymentOptionSchema>;

export const x402PaymentRequiredSchema = z.object({
  accepts: z.array(x402PaymentOptionSchema),
});

export type X402PaymentRequired = z.infer<typeof x402PaymentRequiredSchema>;

export function parseX402PaymentRequirements(headerOrBody: unknown): X402PaymentRequired {
  if (typeof headerOrBody === 'string') {
    try {
      const parsed = JSON.parse(headerOrBody);
      return x402PaymentRequiredSchema.parse(parsed);
    } catch (err) {
      throw new Error(`Failed to parse x402 payment requirements from string: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  try {
    return x402PaymentRequiredSchema.parse(headerOrBody);
  } catch (err) {
    throw new Error(`Failed to parse x402 payment requirements from object: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}
