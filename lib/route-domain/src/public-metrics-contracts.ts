import { z } from 'zod';

import { stableHashV1, type HashV1 } from './hashing.js';
import { HashV1Schema, TimestampV1Schema } from './primitives.js';

export const PUBLIC_METRICS_SCHEMA_VERSION_V1 = 'public-metrics/v1' as const;
export const PUBLIC_METRICS_DEFINITIONS_VERSION_V1 = 'miorail-public-metrics/2026-08-14' as const;

const CountMetricV1Schema = z
  .object({
    value: z.number().int().min(0),
    status: z.enum(['measured', 'zero']),
  })
  .strict();

const OptionalCountMetricV1Schema = z
  .object({
    value: z.number().int().min(0).nullable(),
    status: z.enum(['measured', 'zero', 'suppressed', 'not_available']),
  })
  .strict()
  .superRefine((metric, ctx) => {
    if ((metric.status === 'measured' || metric.status === 'zero') !== (metric.value !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a visible count must carry a value' });
    }
  });

const DecimalMetricV1Schema = z
  .object({
    value: z.string().regex(/^\d+(?:\.\d{1,6})?$/).nullable(),
    status: z.enum(['measured', 'zero', 'not_available']),
  })
  .strict()
  .superRefine((metric, ctx) => {
    if ((metric.status === 'measured' || metric.status === 'zero') !== (metric.value !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a visible decimal must carry a value' });
    }
  });

export const PublicMetricsSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(PUBLIC_METRICS_SCHEMA_VERSION_V1),
    definitionsVersion: z.literal(PUBLIC_METRICS_DEFINITIONS_VERSION_V1),
    chainId: z.literal(8453),
    window: z
      .object({
        kind: z.literal('all_time'),
        through: TimestampV1Schema,
      })
      .strict(),
    metrics: z
      .object({
        routesEvaluated: CountMetricV1Schema,
        routesExecuted: CountMetricV1Schema,
        routeProofsVerified: CountMetricV1Schema,
        x402UsdcSpent: DecimalMetricV1Schema,
        x402IntelligencePurchased: CountMetricV1Schema,
        x402IntelligenceSold: CountMetricV1Schema,
        b20LaunchesMeasured: CountMetricV1Schema,
        uniqueBaseWallets: OptionalCountMetricV1Schema,
        executionSuccessRate: z
          .object({
            valueBps: z.number().int().min(0).max(10_000).nullable(),
            numerator: z.number().int().min(0),
            denominator: z.number().int().min(0),
            status: z.enum(['measured', 'not_available']),
          })
          .strict(),
      })
      .strict(),
    definitions: z
      .object({
        routesEvaluated: z.string().min(1).max(500),
        routesExecuted: z.string().min(1).max(500),
        routeProofsVerified: z.string().min(1).max(500),
        x402UsdcSpent: z.string().min(1).max(500),
        x402IntelligencePurchased: z.string().min(1).max(500),
        x402IntelligenceSold: z.string().min(1).max(500),
        b20LaunchesMeasured: z.string().min(1).max(500),
        uniqueBaseWallets: z.string().min(1).max(500),
        executionSuccessRate: z.string().min(1).max(500),
      })
      .strict(),
    caveats: z.array(z.string().min(1).max(500)).min(1).max(12),
    snapshotHash: HashV1Schema,
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const expected = hashPublicMetricsSnapshotV1(snapshot);
    if (snapshot.snapshotHash !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshotHash'],
        message: 'snapshotHash does not match the metrics snapshot',
      });
    }
    const rate = snapshot.metrics.executionSuccessRate;
    if (rate.status === 'not_available' && rate.valueBps !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['metrics', 'executionSuccessRate'], message: 'an unavailable rate has no value' });
    }
    if (rate.status === 'measured') {
      const expectedRate = rate.denominator === 0 ? null : Math.floor((rate.numerator * 10_000) / rate.denominator);
      if (rate.valueBps !== expectedRate) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['metrics', 'executionSuccessRate'], message: 'rate does not match its numerator and denominator' });
      }
    }
  });

export type PublicMetricsSnapshotV1 = z.infer<typeof PublicMetricsSnapshotV1Schema>;

export function hashPublicMetricsSnapshotV1(
  value: Omit<PublicMetricsSnapshotV1, 'snapshotHash'> | PublicMetricsSnapshotV1,
): HashV1 {
  const payload = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'snapshotHash'),
  );
  return stableHashV1('public-metrics-snapshot/v1', payload);
}

export function sealPublicMetricsSnapshotV1(
  value: Omit<PublicMetricsSnapshotV1, 'snapshotHash'>,
): PublicMetricsSnapshotV1 {
  return PublicMetricsSnapshotV1Schema.parse({ ...value, snapshotHash: hashPublicMetricsSnapshotV1(value) });
}
