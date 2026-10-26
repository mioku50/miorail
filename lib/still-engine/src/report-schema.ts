// The Mirror report as a client checks it: report.ts in zod. A successful status alone is not
// data, so a page parses the report before it shows a number from it. The test for this file
// parses computed reports, and a compile-time check keeps the two descriptions of one shape from
// drifting apart.

import type { Address } from 'viem';
import { z } from 'zod';
import type { MirrorReport } from './report.js';

const ADDRESS = z.custom<Address>((value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value), 'not an address');
const INTEGER = z.string().regex(/^\d+$/);
const ISO = z.string().datetime();
const ASSET = z.enum(['AAPLc', 'AMZNc', 'GOOGLc', 'METAc', 'MSFTc', 'NVDAc', 'TSLAc', 'cbBTC', 'ETH']);
const VENUE = z.enum(['aave-v4', 'morpho']);
const AMOUNT = z.object({ raw: INTEGER, decimals: z.number().int().min(0).max(36) }).strict();

const LINE = z
  .object({
    asset: ASSET,
    kind: z.enum(['stock', 'crypto']),
    name: z.string(),
    symbol: z.string(),
    token: ADDRESS,
    isin: z.string().nullable(),
    venue: VENUE,
    wallet: AMOUNT.nullable(),
    pledged: AMOUNT.nullable(),
    shares: AMOUNT.nullable(),
    priceCents: INTEGER.nullable(),
    priceUpdatedAt: ISO.nullable(),
    valueCents: INTEGER.nullable(),
    protocolFactorBps: z.number().int().nullable(),
    stillFactorBps: z.number().int().nullable(),
    capacityCents: INTEGER.nullable(),
    earnings: z
      .object({
        source: z.enum(['calendar', 'unread']),
        reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        window: z.object({ startsAt: ISO, endsAt: ISO }).strict().nullable(),
        lowered: z.boolean(),
      })
      .strict()
      .nullable(),
    limits: z.array(z.enum(['reserve_paused', 'reserve_frozen', 'spoke_halted', 'issuer_paused', 'supply_cap', 'gas_reserve', 'not_listed'])),
    failed: z.array(z.string()),
  })
  .strict();

const VENUE_LINE = z
  .object({
    venue: VENUE,
    market: z.string(),
    label: z.string(),
    debtCents: INTEGER.nullable(),
    capacityCents: INTEGER.nullable(),
    availableCents: INTEGER.nullable(),
    borrowRateBps: z.number().int().nullable(),
    liquidityCents: INTEGER.nullable(),
    deductions: z.object({ loansCents: INTEGER.nullable(), venueLimitCents: INTEGER.nullable() }).strict(),
    safety: z
      .object({
        marginBps: z.number().int(),
        state: z.enum(['calm', 'watch', 'act', 'liquidation']),
        healthFactor: INTEGER,
        source: z.enum(['protocol', 'computed']),
      })
      .strict()
      .nullable(),
    liquidationPrices: z.array(z.object({ asset: ASSET, priceCents: INTEGER.nullable(), unreachable: z.boolean() }).strict()),
    failed: z.array(z.string()),
  })
  .strict();

export const MirrorReportSchema = z
  .object({
    kind: z.literal('still.mirror'),
    version: z.literal(1),
    subject: z.object({ address: ADDRESS, name: z.string().nullable(), input: z.string() }).strict(),
    reading: z.object({ block: INTEGER, blockTime: ISO, assembledAt: ISO, provider: z.string() }).strict(),
    terms: z
      .object({
        version: z.string(),
        stockShareBps: z.number().int(),
        cryptoShareBps: z.number().int(),
        weekend: z.object({ active: z.boolean(), startsAt: ISO, endsAt: ISO, stockShareBps: z.number().int() }).strict(),
        earnings: z.object({ stockShareBps: z.number().int(), calendarReadAt: ISO.nullable() }).strict(),
      })
      .strict(),
    headline: z
      .object({
        state: z.enum(['funded', 'dust', 'none', 'unknown']),
        availableCents: INTEGER.nullable(),
        complete: z.boolean(),
        reason: z.enum(['no_eligible_assets', 'limit_in_use', 'paused']).nullable(),
        weekdayAvailableCents: INTEGER.nullable(),
      })
      .strict(),
    assets: z.array(LINE),
    venues: z.array(VENUE_LINE),
    coverage: z
      .object({
        measured: z.array(z.string()),
        notCounted: z.array(z.string()),
        failed: z.array(z.object({ what: z.string(), owner: z.enum(['us', 'protocol']) }).strict()),
      })
      .strict(),
    evidence: z.array(z.object({ label: z.string(), address: ADDRESS }).strict()),
  })
  .strict();

// Both directions, so neither description can gain or lose a field alone.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameShape: Same<z.infer<typeof MirrorReportSchema>, MirrorReport> = true;
void sameShape;
