import { z } from 'zod';
import type { CanonicalJsonValue, HashV1 } from './hashing.js';

export const BASE_CHAIN_IDS_V1 = [8453, 84532] as const;

export const BaseChainIdV1Schema = z.union([z.literal(8453), z.literal(84532)]);
export type BaseChainIdV1 = z.infer<typeof BaseChainIdV1Schema>;

export const AddressV1Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'Expected a 20-byte EVM address')
  .transform((value) => value.toLowerCase() as `0x${string}`);
export type AddressV1 = z.infer<typeof AddressV1Schema>;

export const HashV1Schema: z.ZodType<HashV1> = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, 'Expected a lowercase 32-byte hash') as z.ZodType<HashV1>;

export const TimestampV1Schema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export const AtomicAmountV1Schema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'Expected unsigned base-unit integer string');
export const DecimalAmountV1Schema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'Expected unsigned decimal string');
export const SignedDecimalV1Schema = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'Expected signed decimal string');
export const HexDataV1Schema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/, 'Expected even-length hex data')
  .transform((value) => value.toLowerCase() as `0x${string}`);

export const EntityIdV1Schema = z.string().min(1).max(200);
export const TenantIdV1Schema = z.string().min(1).max(200);

export function financialEntityFieldsV1<const Version extends string, Status extends z.ZodTypeAny>(
  schemaVersion: Version,
  statusSchema: Status,
) {
  return {
    schemaVersion: z.literal(schemaVersion),
    id: EntityIdV1Schema,
    tenantId: TenantIdV1Schema,
    walletAddress: AddressV1Schema,
    chainId: BaseChainIdV1Schema,
    createdAt: TimestampV1Schema,
    updatedAt: TimestampV1Schema,
    status: statusSchema,
  } as const;
}

export function validateFinancialChronologyV1(
  value: { createdAt: string; updatedAt: string },
  ctx: z.RefinementCtx,
): void {
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['updatedAt'],
      message: 'updatedAt must not be earlier than createdAt',
    });
  }
}

export function assetIdV1(input: {
  chainId: BaseChainIdV1;
  kind: 'native' | 'erc20';
  address: AddressV1 | null;
}): string {
  return input.kind === 'native'
    ? `eip155:${input.chainId}/native`
    : `eip155:${input.chainId}/erc20:${input.address}`;
}

const AssetRefV1ObjectSchema = z
  .object({
    assetId: z.string().min(1).max(200),
    chainId: BaseChainIdV1Schema,
    kind: z.enum(['native', 'erc20']),
    address: AddressV1Schema.nullable(),
    symbol: z.string().min(1).max(32),
    decimals: z.number().int().min(0).max(255),
  })
  .strict();

export const AssetRefV1Schema = AssetRefV1ObjectSchema.superRefine((value, ctx) => {
  if (value.kind === 'native' && value.address !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['address'],
      message: 'Native assets must have a null address',
    });
  }
  if (value.kind === 'erc20' && value.address === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['address'],
      message: 'ERC-20 assets require an address',
    });
  }
  if (value.assetId !== assetIdV1(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['assetId'],
      message: 'assetId does not match chain, kind, and address',
    });
  }
});
export type AssetRefV1 = z.infer<typeof AssetRefV1Schema>;

export const TokenAmountV1Schema = z
  .object({
    asset: AssetRefV1Schema,
    amountAtomic: AtomicAmountV1Schema,
    amountDecimal: DecimalAmountV1Schema,
  })
  .strict();
export type TokenAmountV1 = z.infer<typeof TokenAmountV1Schema>;

export const MoneyV1Schema = z
  .object({
    asset: AssetRefV1Schema,
    amountAtomic: AtomicAmountV1Schema,
    amountDecimal: DecimalAmountV1Schema,
    usdValue: DecimalAmountV1Schema.nullable(),
  })
  .strict();
export type MoneyV1 = z.infer<typeof MoneyV1Schema>;

export const PercentageV1Schema = z
  .object({
    bps: z.number().int().min(0).max(1_000_000),
    percent: DecimalAmountV1Schema,
  })
  .strict();
export type PercentageV1 = z.infer<typeof PercentageV1Schema>;

export const GasEstimateV1Schema = z
  .object({
    gasUnits: AtomicAmountV1Schema,
    maxFeePerGasWei: AtomicAmountV1Schema.nullable(),
    estimatedCostNative: DecimalAmountV1Schema.nullable(),
    estimatedCostUsd: DecimalAmountV1Schema.nullable(),
  })
  .strict();
export type GasEstimateV1 = z.infer<typeof GasEstimateV1Schema>;

export const ProviderRefV1Schema = z
  .object({
    id: z.string().min(1).max(100),
    displayName: z.string().min(1).max(120),
    kind: z.enum(['aggregator', 'dex', 'protocol', 'data_provider', 'simulation', 'internal']),
    operator: z.string().min(1).max(200),
  })
  .strict();
export type ProviderRefV1 = z.infer<typeof ProviderRefV1Schema>;

export const PoolRefV1Schema = z
  .object({
    chainId: BaseChainIdV1Schema,
    address: AddressV1Schema,
    protocol: z.string().min(1).max(100),
    feeBps: z.number().int().min(0).max(10_000).nullable(),
    assets: z.array(AssetRefV1Schema).min(2),
  })
  .strict();
export type PoolRefV1 = z.infer<typeof PoolRefV1Schema>;

export const LiquiditySourceRefV1Schema = z
  .object({
    sourceKey: z.string().min(1).max(300),
    chainId: BaseChainIdV1Schema,
    protocol: z.string().min(1).max(100),
    poolAddress: AddressV1Schema.nullable(),
    assets: z.array(AssetRefV1Schema).min(1),
    upstreamProvider: z.string().min(1).max(100).nullable(),
  })
  .strict();
export type LiquiditySourceRefV1 = z.infer<typeof LiquiditySourceRefV1Schema>;

export const JsonValueV1Schema: z.ZodType<CanonicalJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueV1Schema),
    z.record(JsonValueV1Schema),
  ]),
);

export const JsonObjectV1Schema = z.record(JsonValueV1Schema);
