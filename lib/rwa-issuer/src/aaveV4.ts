import { z } from 'zod';
import { partnerFetch } from '@mioagent/security/httpAllowlist';
import type { DefiListingSourceV1, DefiVenueReadingV1 } from './useAccess.js';

// Reviewed against Aave's address book on 2026-10-14. Scope is this spoke,
// never all Aave deployments, and membership is read rather than inferred
// from a symbol or the seven assets named in the launch announcement.
export const AAVE_V4_BASE_HUB_V1 = '0xa4d5947eb727a052bae69c593ffc84247ec9864e';
export const AAVE_V4_BASE_SPOKE_V1 = '0x17905db0e4a3514467539956c084180616ae7b8d';
export const AAVE_V4_BASE_USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const AAVE_V4_BASE_PAGE_V1 = 'https://pro.aave.com/explore/hub/ODQ1Mzo6MHhhNGQ1OTQ3RWI3MjdBMDUyYmFlNjlDNTkzRmZDODQyNDdFQzk4NjRF';
const ENDPOINT = 'https://api.v4.aave.com/graphql';
const VENUE_ID = 'aave_v4_equities';
const VENUE_NAME = 'Aave v4 Equities';
const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(s => s.toLowerCase());
const DECIMAL = z.string().max(80).regex(/^\d+(?:\.\d+)?$/)
  .refine(s => Number.isFinite(Number(s)) && Number(s) <= 1e15);
const SIGNED_DECIMAL = z.string().max(80).regex(/^-?\d+(?:\.\d+)?$/)
  .refine(s => Number.isFinite(Number(s)) && Math.abs(Number(s)) <= 1e15);
const FIGURE = z.object({ value: DECIMAL });
const AMOUNT = z.object({ amount: FIGURE, exchange: FIGURE });
const CHAIN = z.object({ chainId: z.literal(8453) });
const SPOKE = z.object({ id: z.string().min(1).max(200), address: ADDRESS, chain: CHAIN });

const ReserveSchema = z.object({
  id: z.string().min(1).max(200), chain: CHAIN, spoke: SPOKE,
  asset: z.object({
    underlying: z.object({ address: ADDRESS, info: z.object({ symbol: z.string().min(1).max(40), decimals: z.number().int().min(0).max(36) }) }),
    hub: z.object({ address: ADDRESS, chain: CHAIN }),
  }),
  canSupply: z.boolean(), canBorrow: z.boolean(), canUseAsCollateral: z.boolean(),
  status: z.object({ active: z.boolean(), frozen: z.boolean(), paused: z.boolean() }),
  settings: z.object({
    collateral: z.boolean(), borrowable: z.boolean(), suppliable: z.boolean(),
    collateralFactor: FIGURE, maxLiquidationBonus: FIGURE, liquidationFee: FIGURE,
    collateralRisk: FIGURE, supplyCap: AMOUNT, borrowCap: AMOUNT,
  }),
  summary: z.object({
    supplied: AMOUNT, borrowed: AMOUNT, suppliable: AMOUNT, borrowable: AMOUNT,
    supplyApy: FIGURE, borrowApy: FIGURE,
  }),
});
type Reserve = z.infer<typeof ReserveSchema>;

// GraphQL PercentNumber.value is a FRACTION (0.70), while MCP's Pct fields
// are percentages (70). Keep that distinction at the boundary.
function numberV1(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1e15) throw new Error('aave_v4_number_invalid');
  return n;
}
function bpsV1(value: string, max = 10_000_000): number {
  const n = Math.round(numberV1(value) * 10_000);
  if (n > max) throw new Error('aave_v4_rate_invalid');
  return n;
}

export const AaveV4ConditionsSchemaV1 = z.object({
  collateralEnabled: z.boolean(),
  collateralFactorBps: z.number().int().min(0).max(10_000),
  supplyCapTokens: DECIMAL, suppliableTokens: DECIMAL,
  active: z.boolean(), frozen: z.boolean(), paused: z.boolean(),
  loanActive: z.boolean(), loanFrozen: z.boolean(), loanPaused: z.boolean(),
  loanBorrowEnabled: z.boolean(), loanBorrowCapTokens: DECIMAL, loanBorrowableTokens: DECIMAL,
  maxLiquidationBonusBps: z.number().int().min(0).max(100_000),
  liquidationFeeBps: z.number().int().min(0).max(10_000),
  collateralRiskBps: z.number().int().min(0).max(100_000),
}).strict();
export type AaveV4ConditionsV1 = z.infer<typeof AaveV4ConditionsSchemaV1>;

export const AAVE_V4_RESERVES_QUERY_V1 = `query MiorailEquities($spoke: SpokeInput!) {
  reserves(request: {query: {spoke: $spoke}, filter: ALL, orderBy: {assetName: ASC}}) {
    id chain {chainId} spoke {id address chain {chainId}}
    asset {underlying {address info {symbol decimals}} hub {address chain {chainId}}}
    canSupply canBorrow canUseAsCollateral status {active frozen paused}
    settings {
      collateral borrowable suppliable
      collateralFactor {value} maxLiquidationBonus {value} liquidationFee {value} collateralRisk {value}
      supplyCap {amount {value} exchange {value}} borrowCap {amount {value} exchange {value}}
    }
    summary {
      supplied {amount {value} exchange {value}} borrowed {amount {value} exchange {value}}
      suppliable {amount {value} exchange {value}} borrowable {amount {value} exchange {value}}
      supplyApy {value} borrowApy {value}
    }
  }
}`;

export interface AaveV4ReadOptionsV1 { fetchImpl?: typeof fetch; clock?: () => Date }

// No configurable host, redirects, MCP tool execution, signing or credentials.
// Abort applies to the body too; a successful HTTP status alone is not data.
async function queryV1(query: string, variables: object, options: AaveV4ReadOptionsV1): Promise<unknown> {
  const response = await partnerFetch(ENDPOINT, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  }, { timeoutMs: 8_000, fetchImpl: options.fetchImpl });
  if (!response.ok || !response.body) throw new Error('aave_v4_provider_unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 256_000) throw new Error('aave_v4_response_too_large');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  const parsed = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() })
    .safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  if (!parsed.success || parsed.data.errors?.length || !parsed.data.data) throw new Error('aave_v4_response_invalid');
  return parsed.data.data;
}

export async function readAaveV4ReservesV1(options: AaveV4ReadOptionsV1 = {}): Promise<Reserve[]> {
  const data = await queryV1(AAVE_V4_RESERVES_QUERY_V1, { spoke: { address: AAVE_V4_BASE_SPOKE_V1, chainId: 8453 } }, options);
  const reserves = z.object({ reserves: z.array(ReserveSchema).min(1).max(128) }).parse(data).reserves;
  const addresses = new Set<string>();
  const ids = new Set<string>();
  const spokeId = reserves[0]!.spoke.id;
  for (const reserve of reserves) {
    const address = reserve.asset.underlying.address;
    if (reserve.spoke.address !== AAVE_V4_BASE_SPOKE_V1 || reserve.asset.hub.address !== AAVE_V4_BASE_HUB_V1
      || reserve.spoke.id !== spokeId || addresses.has(address) || ids.has(reserve.id)) throw new Error('aave_v4_identity_invalid');
    addresses.add(address); ids.add(reserve.id);
  }
  if (!addresses.has(AAVE_V4_BASE_USDC_V1)) throw new Error('aave_v4_loan_unread');
  return reserves;
}

export function aaveV4ListingV1(tokenAddress: string, reserves: readonly Reserve[]): DefiVenueReadingV1 {
  const token = ADDRESS.parse(tokenAddress);
  const reserve = reserves.find(r => r.asset.underlying.address === token);
  const empty = { venueId: VENUE_ID, venueName: VENUE_NAME, uses: { lend: null, borrow: null, collateral: null }, marketRef: null, curated: null, reason: null };
  if (!reserve) return { ...empty, state: 'not_listed' };
  const collateral = !reserve.settings.borrowable;
  const loan = collateral ? reserves.find(r => r.asset.underlying.address === AAVE_V4_BASE_USDC_V1) : reserve;
  if (!loan) throw new Error('aave_v4_loan_unread');
  const open = reserve.status.active && !reserve.status.paused && !reserve.status.frozen;
  const loanOpen = loan.status.active && !loan.status.paused && !loan.status.frozen && loan.canBorrow && loan.settings.borrowable;
  return {
    ...empty, state: 'listed', curated: true, marketRef: reserve.id,
    // Supplying a collateral-only stock is not earning interest on that stock.
    uses: { lend: open && !collateral && reserve.canSupply && reserve.settings.suppliable,
      borrow: open && reserve.canBorrow && reserve.settings.borrowable,
      collateral: open && reserve.canUseAsCollateral && reserve.settings.collateral },
    markets: [{
      marketId: reserve.id, curated: true, role: collateral ? 'collateral' : 'loan',
      loanAssetSymbol: loan.asset.underlying.info.symbol,
      collateralAssetSymbol: collateral ? reserve.asset.underlying.info.symbol : null,
      lltvBps: null, // V4 collateral factor is not Morpho's LLTV.
      collateralUsd: collateral ? numberV1(reserve.summary.supplied.exchange.value) : null,
      supplyUsd: numberV1(loan.summary.supplied.exchange.value),
      borrowUsd: numberV1(loan.summary.borrowed.exchange.value),
      liquidityUsd: loanOpen ? numberV1(loan.summary.borrowable.exchange.value) : 0,
      supplyApyBps: bpsV1(loan.summary.supplyApy.value), borrowApyBps: bpsV1(loan.summary.borrowApy.value),
      aaveV4: {
        collateralEnabled: reserve.settings.collateral,
        collateralFactorBps: bpsV1(reserve.settings.collateralFactor.value, 10_000),
        supplyCapTokens: reserve.settings.supplyCap.amount.value, suppliableTokens: reserve.summary.suppliable.amount.value,
        ...reserve.status, loanActive: loan.status.active, loanFrozen: loan.status.frozen, loanPaused: loan.status.paused,
        loanBorrowEnabled: loan.canBorrow && loan.settings.borrowable, loanBorrowCapTokens: loan.settings.borrowCap.amount.value,
        loanBorrowableTokens: loan.summary.borrowable.amount.value,
        maxLiquidationBonusBps: bpsV1(reserve.settings.maxLiquidationBonus.value, 100_000),
        liquidationFeeBps: bpsV1(reserve.settings.liquidationFee.value, 10_000),
        collateralRiskBps: bpsV1(reserve.settings.collateralRisk.value, 100_000),
      },
    }],
    reason: 'Aave API reading of the Base MAG7 spoke; rates are variable, amounts use its oracle prices; wallet eligibility and execution are not established',
  };
}

export function aaveV4DefiSourceV1(options: AaveV4ReadOptionsV1 = {}): DefiListingSourceV1 {
  return { venueId: VENUE_ID, venueName: VENUE_NAME, kind: 'venue_catalogue',
    async lookup(tokenAddress) {
      try { return aaveV4ListingV1(tokenAddress, await readAaveV4ReservesV1(options)); }
      catch { return { venueId: VENUE_ID, venueName: VENUE_NAME, state: 'unread', uses: { lend: null, borrow: null, collateral: null }, curated: null, marketRef: null, reason: 'aave_v4_read_unavailable' }; }
    },
  };
}

export const AaveV4PositionV1Schema = z.object({
  schemaVersion: z.literal('aave-v4-position/v1'), chainId: z.literal(8453), walletAddress: ADDRESS,
  spokeAddress: z.literal(AAVE_V4_BASE_SPOKE_V1), observedAt: z.string().datetime(),
  source: z.literal('aave_api'), state: z.enum(['empty', 'read']),
  collateralUsd: DECIMAL.nullable(), debtUsd: DECIMAL.nullable(),
  netAccruedInterestUsd: SIGNED_DECIMAL.nullable(), netBorrowApyBps: z.number().int().min(-10_000_000).max(10_000_000).nullable(),
  healthFactor: DECIMAL.nullable(), remainingBorrowingPowerUsd: DECIMAL.nullable(),
}).strict().superRefine((value, context) => {
  const figures = [value.collateralUsd, value.debtUsd, value.netAccruedInterestUsd,
    value.netBorrowApyBps, value.healthFactor, value.remainingBorrowingPowerUsd];
  if (value.state === 'empty' && figures.some(figure => figure !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Empty position carries values' });
  }
  if (value.state === 'read' && (value.collateralUsd === null || value.debtUsd === null
    || (Number(value.debtUsd) > 0 && value.healthFactor === null))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Position is incomplete' });
  }
});
export type AaveV4PositionV1 = z.infer<typeof AaveV4PositionV1Schema>;

const POSITION_QUERY = `query MiorailEquitiesPosition($spoke: SpokeId!, $user: EvmAddress!) {
  userPosition(request: {userSpoke: {spoke: $spoke, user: $user}}) {
    user spoke {id address chain {chainId}}
    totalCollateral {current {value}} totalDebt {current {value}} netAccruedInterest {value}
    netBorrowApy {current {value}} healthFactor {current} remainingBorrowingPower {value}
  }
}`;
export async function readAaveV4PositionV1(walletAddress: string, options: AaveV4ReadOptionsV1 = {}): Promise<AaveV4PositionV1> {
  const wallet = ADDRESS.parse(walletAddress);
  const reserves = await readAaveV4ReservesV1(options);
  const spokeId = reserves[0]!.spoke.id; // Opaque id from this session, never manufactured.
  const raw = await queryV1(POSITION_QUERY, { spoke: spokeId, user: wallet }, options);
  const data = z.object({ userPosition: z.object({
    user: ADDRESS, spoke: SPOKE,
    totalCollateral: z.object({ current: FIGURE }), totalDebt: z.object({ current: FIGURE }),
    netAccruedInterest: z.object({ value: SIGNED_DECIMAL }), netBorrowApy: z.object({ current: z.object({ value: SIGNED_DECIMAL }) }),
    healthFactor: z.object({ current: DECIMAL.nullable() }), remainingBorrowingPower: FIGURE,
  }).nullable() }).parse(raw).userPosition;
  if (data && (data.user !== wallet || data.spoke.id !== spokeId || data.spoke.address !== AAVE_V4_BASE_SPOKE_V1)) throw new Error('aave_v4_position_identity_invalid');
  if (data && numberV1(data.totalDebt.current.value) > 0 && data.healthFactor.current === null) throw new Error('aave_v4_health_unread');
  const netBorrowApyBps = data ? Math.round(Number(data.netBorrowApy.current.value) * 10_000) : null;
  return AaveV4PositionV1Schema.parse({
    schemaVersion: 'aave-v4-position/v1', chainId: 8453, walletAddress: wallet, spokeAddress: AAVE_V4_BASE_SPOKE_V1,
    observedAt: (options.clock ?? (() => new Date()))().toISOString(), source: 'aave_api', state: data ? 'read' : 'empty',
    collateralUsd: data?.totalCollateral.current.value ?? null, debtUsd: data?.totalDebt.current.value ?? null,
    netAccruedInterestUsd: data?.netAccruedInterest.value ?? null,
    netBorrowApyBps,
    healthFactor: data?.healthFactor.current ?? null, remainingBorrowingPowerUsd: data?.remainingBorrowingPower.value ?? null,
  });
}
