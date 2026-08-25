import { stableHashV1, type HashV1 } from '@mioagent/route-domain';
import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Digits = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Timestamp = z.string().datetime();
const BASE_USDC_ADDRESS_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_WETH_ADDRESS_V1 = '0x4200000000000000000000000000000000000006';

export const CASH_EXIT_DESTINATIONS_V1 = ['USDC', 'ETH'] as const;
export const CASH_EXIT_SOURCE_STATUSES_V1 = [
  'full',
  'buy_only',
  'unavailable',
  'measurement_failed',
] as const;
export const CASH_EXIT_DEFAULT_USDC_SIZES_ATOMIC_V1 = [
  '100000000',
  '1000000000',
  '10000000000',
  '100000000000',
] as const;

export const CashExitQuoteLegV1Schema = z
  .object({
    direction: z.enum(['buy', 'sell']),
    inputAddress: Address,
    outputAddress: Address,
    inputAtomic: Digits,
    outputAtomic: Digits,
    routeKey: z.string().min(1).max(300),
    candidateHash: Hash,
    evidenceHash: Hash,
    observedAt: Timestamp,
    expiresAt: Timestamp,
    blockNumber: Digits.nullable(),
    liquiditySources: z.array(z.string().min(1).max(300)).max(100),
  })
  .strict();
export type CashExitQuoteLegV1 = z.infer<typeof CashExitQuoteLegV1Schema>;

const CashExitSourceObservationObjectV1Schema = z
  .object({
    schemaVersion: z.literal('official-cash-exit-observation/v1'),
    observationHash: Hash,
    runId: Hash,
    chainId: z.literal(8453),
    tokenAddress: Address,
    tokenSymbol: z.string().min(1).max(32),
    tokenDecimals: z.number().int().min(6).max(18),
    scope: z.enum(['public_ladder', 'tenant_position']),
    tenantId: z.string().min(1).max(200).nullable(),
    sizeKind: z.enum(['cash_equivalent', 'actual_position']),
    requestedCashAtomic: Digits.nullable(),
    requestedTokenAtomic: Digits.nullable(),
    testedTokenAtomic: Digits.nullable(),
    destination: z.enum(CASH_EXIT_DESTINATIONS_V1),
    destinationAddress: Address,
    destinationDecimals: z.number().int().min(0).max(255),
    source: z.string().min(1).max(100),
    status: z.enum(CASH_EXIT_SOURCE_STATUSES_V1),
    evidenceStrength: z.literal('router_quote'),
    executionProven: z.literal(false),
    buyQuote: CashExitQuoteLegV1Schema.nullable(),
    sellQuote: CashExitQuoteLegV1Schema.nullable(),
    errorCode: z.string().min(1).max(120).nullable(),
    observedAt: Timestamp,
    expiresAt: Timestamp,
  })
  .strict();

export type CashExitSourceObservationV1 = z.infer<typeof CashExitSourceObservationObjectV1Schema>;

export function hashCashExitObservationV1(value: CashExitSourceObservationV1): HashV1 {
  const { observationHash: _observationHash, ...content } = value;
  return stableHashV1('official-cash-exit-observation/v1', content);
}

export const CashExitSourceObservationV1Schema =
  CashExitSourceObservationObjectV1Schema.superRefine((value, ctx) => {
    if (value.observationHash !== hashCashExitObservationV1(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observationHash'],
        message: 'observation hash mismatch',
      });
    }
    if ((value.scope === 'tenant_position') !== (value.tenantId !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tenantId'],
        message: 'tenant scope mismatch',
      });
    }
    if (value.sizeKind === 'cash_equivalent') {
      if (value.requestedCashAtomic === null || value.requestedTokenAtomic !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requestedCashAtomic'],
          message: 'cash rung shape mismatch',
        });
      }
    } else if (value.requestedTokenAtomic === null || value.requestedCashAtomic !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedTokenAtomic'],
        message: 'position rung shape mismatch',
      });
    }
    if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'expiry must follow observation',
      });
    }
    const expectedDestination =
      value.destination === 'USDC'
        ? { address: BASE_USDC_ADDRESS_V1, decimals: 6 }
        : { address: BASE_WETH_ADDRESS_V1, decimals: 18 };
    if (
      value.destinationAddress !== expectedDestination.address ||
      value.destinationDecimals !== expectedDestination.decimals
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destinationAddress'],
        message: 'destination identity does not match the pinned Base asset',
      });
    }
    if (
      value.sizeKind === 'actual_position' &&
      value.testedTokenAtomic !== value.requestedTokenAtomic
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['testedTokenAtomic'],
        message: 'an actual position must test its exact requested token amount',
      });
    }
    if (value.buyQuote !== null) {
      if (
        value.buyQuote.direction !== 'buy' ||
        value.buyQuote.inputAddress !== BASE_USDC_ADDRESS_V1 ||
        value.buyQuote.outputAddress !== value.tokenAddress ||
        value.buyQuote.inputAtomic !== value.requestedCashAtomic ||
        value.buyQuote.outputAtomic !== value.testedTokenAtomic ||
        BigInt(value.buyQuote.inputAtomic) <= 0n ||
        BigInt(value.buyQuote.outputAtomic) <= 0n
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['buyQuote'],
          message: 'buy quote does not prove this exact cash-to-token rung',
        });
      }
    }
    if (value.sellQuote !== null) {
      if (
        value.sellQuote.direction !== 'sell' ||
        value.sellQuote.inputAddress !== value.tokenAddress ||
        value.sellQuote.outputAddress !== value.destinationAddress ||
        value.sellQuote.inputAtomic !== value.testedTokenAtomic ||
        BigInt(value.sellQuote.inputAtomic) <= 0n ||
        BigInt(value.sellQuote.outputAtomic) <= 0n
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sellQuote'],
          message: 'sell quote does not prove this exact token-to-destination rung',
        });
      }
    }
    if (value.status === 'full') {
      if (
        value.sellQuote === null ||
        value.testedTokenAtomic === null ||
        value.errorCode !== null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'full requires an exact sell quote',
        });
      }
      if (value.sizeKind === 'cash_equivalent' && value.buyQuote === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['buyQuote'],
          message: 'cash-equivalent full requires a buy quote',
        });
      }
    }
    if (value.status === 'buy_only') {
      if (
        value.sizeKind !== 'cash_equivalent' ||
        value.buyQuote === null ||
        value.sellQuote !== null ||
        value.errorCode !== 'provider_no_route'
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'buy_only requires a successful buy and explicit sell no-route',
        });
      }
    }
    if (value.status === 'unavailable') {
      if (
        value.sizeKind !== 'actual_position' ||
        value.testedTokenAtomic === null ||
        value.buyQuote !== null ||
        value.sellQuote !== null ||
        value.errorCode !== 'provider_no_route'
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'unavailable requires explicit provider_no_route and no quote',
        });
      }
    }
    if (value.status === 'measurement_failed') {
      if (
        value.sellQuote !== null ||
        value.errorCode === null ||
        value.errorCode === 'provider_no_route'
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'measurement failure must retain a non-market error code',
        });
      }
    }
  });

const CashExitMeasurementRunObjectV1Schema = z
  .object({
    schemaVersion: z.literal('official-cash-exit-run/v1'),
    runId: Hash,
    chainId: z.literal(8453),
    tokenAddress: Address,
    scope: z.enum(['public_ladder', 'tenant_position']),
    tenantId: z.string().min(1).max(200).nullable(),
    approvedSources: z.array(z.string().min(1).max(100)).min(1).max(16),
    destinations: z.array(z.enum(CASH_EXIT_DESTINATIONS_V1)).min(1).max(2),
    startedAt: Timestamp,
    completedAt: Timestamp,
    observations: z.array(CashExitSourceObservationV1Schema).min(1).max(256),
  })
  .strict();
export type CashExitMeasurementRunV1 = z.infer<typeof CashExitMeasurementRunObjectV1Schema>;

export function hashCashExitRunV1(value: Omit<CashExitMeasurementRunV1, 'runId'>): HashV1 {
  const { observations: _observations, completedAt: _completedAt, ...identity } = value;
  return stableHashV1('official-cash-exit-run/v1', identity);
}

export const CashExitMeasurementRunV1Schema = CashExitMeasurementRunObjectV1Schema.superRefine(
  (value, ctx) => {
    const { runId: _runId, ...withoutRunId } = value;
    if (value.runId !== hashCashExitRunV1(withoutRunId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['runId'], message: 'run hash mismatch' });
    }
    if ((value.scope === 'tenant_position') !== (value.tenantId !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tenantId'],
        message: 'tenant scope mismatch',
      });
    }
    if (new Set(value.approvedSources).size !== value.approvedSources.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvedSources'],
        message: 'approved sources must be unique',
      });
    }
    if (new Set(value.destinations).size !== value.destinations.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destinations'],
        message: 'destinations must be unique',
      });
    }
    if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completedAt'],
        message: 'run completion precedes start',
      });
    }
    const keys = new Set<string>();
    const sizes = new Set<string>();
    for (const [index, row] of value.observations.entries()) {
      if (
        row.runId !== value.runId ||
        row.tokenAddress !== value.tokenAddress ||
        row.scope !== value.scope ||
        row.tenantId !== value.tenantId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['observations', index],
          message: 'observation does not belong to run',
        });
      }
      if (
        !value.approvedSources.includes(row.source) ||
        !value.destinations.includes(row.destination)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['observations', index],
          message: 'observation is outside approved run dimensions',
        });
      }
      const size = row.requestedCashAtomic ?? `position:${row.requestedTokenAtomic}`;
      sizes.add(size);
      const key = `${size}:${row.destination}:${row.source}`;
      if (keys.has(key))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['observations', index],
          message: 'duplicate exact observation key',
        });
      keys.add(key);
    }
    for (const size of sizes) {
      for (const destination of value.destinations) {
        for (const source of value.approvedSources) {
          if (!keys.has(`${size}:${destination}:${source}`)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['observations'],
              message: `incomplete approved-router matrix for ${size}:${destination}:${source}`,
            });
          }
        }
      }
    }
  },
);

export function assertCashExitRunV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): CashExitMeasurementRunV1 {
  const parsed = CashExitMeasurementRunV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new RouteStorageIntegrityError(
    `official cash-exit run failed validation on ${direction}: ${detail}`,
  );
}

export interface OfficialCashExitRepositoryV1 {
  recordCompletedRun(run: CashExitMeasurementRunV1): Promise<void>;
  latestCompletedRun(input: {
    chainId: 8453;
    tokenAddress: string;
    scope: 'public_ladder' | 'tenant_position';
    tenantId?: string | null;
  }): Promise<CashExitMeasurementRunV1 | null>;
}
