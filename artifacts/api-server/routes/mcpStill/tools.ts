import { MirrorReportSchema } from '@mioagent/still-engine/report-schema';
import { assetById, type AssetId } from '@mioagent/still-engine';
import type { MirrorReport, VenueLine } from '@mioagent/still-engine/report';
import { scenarioV1, type ScenarioEditV1, type ScenarioVenueV1 } from '@mioagent/still-engine/scenario';
import { z } from 'zod';

import { SPEND_PRODUCT_TYPES_V1, spendCallingCodeV1 } from '@mioagent/commerce-engine';

import { stillAgentToolAnswerV1 } from '../../lib/stillAgentTools.js';
import { STILL_SPEND_CAP_ATOMIC_V1, spendPriceAtomicV1, stillSpendPayEnabledV1 } from '../../lib/stillSpendOrders.js';
import {
  SPEND_ID_V1,
  SPEND_QUERY_V1,
  SpendReadFailedV1,
  publicStillRuntimeV1,
  readSpendProductV1,
  readSpendSearchV1,
  spendProductCheckoutV1,
} from '../stillPublic.js';
import { McpPublicError } from '../mcp/tools.js';

// ---------------------------------------------------------------------------
// Still for assistants: any Base wallet, by address or name, and how much it
// could borrow through Still without selling; then what a price move, a draw,
// a repayment or a deposit would do to it.
//
// Both tools read public chain state through the same Mirror service as the
// page (`/w/<wallet>` and the Agent), so an assistant and a person looking at
// the same wallet at the same block read the same figures. They prepare
// nothing: a loan is reviewed and signed on Still's site, in the owner's wallet.
// ---------------------------------------------------------------------------

const ASSET_IDS_V1 = ['AAPLc', 'AMZNc', 'GOOGLc', 'METAc', 'MSFTc', 'NVDAc', 'TSLAc', 'cbBTC', 'ETH'] as const;
const LOANS_V1 = ['aave-v4', 'morpho:cbBTC', 'morpho:ETH'] as const;
const DECIMAL_V1 = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/;

const WalletArgV1 = z.string().trim().min(1).max(256)
  .describe('A Base wallet: a 0x address, or a Basename or ENS name that resolves to one.');

export const StillCheckWalletInputV1Schema = z.object({ wallet: WalletArgV1 }).strict();

const StillProviderAttemptV1Schema = z.object({
  provider: z.enum(['alchemy', 'infura', 'base-public', 'quicknode', 'drpc', 'rpc', 'invalid-url']),
  kind: z.enum(['throttled', 'unavailable', 'rejected']),
}).strict();

/** MCP SDK 1.29 advertises object roots only, so the outcome's branches share one envelope. */
export const StillCheckWalletOutputV1Schema = z.object({
  outcome: z.enum(['report', 'invalid_subject', 'name_not_found', 'names_unavailable', 'chain_unavailable']),
  report: MirrorReportSchema.optional(),
  cached: z.boolean().optional(),
  input: z.string().optional(),
  name: z.string().optional(),
  reason: z.string().optional(),
  attempts: z.array(StillProviderAttemptV1Schema).optional(),
}).strict();

export async function stillCheckWalletV1(args: { wallet: string }): Promise<z.infer<typeof StillCheckWalletOutputV1Schema>> {
  let outcome;
  try {
    outcome = await publicStillRuntimeV1.service().check(args.wallet);
  } catch {
    throw new McpPublicError('still_mirror_unavailable',
      'Still could not read this wallet right now. This is our failure and says nothing about the wallet.');
  }
  return StillCheckWalletOutputV1Schema.parse(outcome);
}

const StillChangeV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('price'),
    asset: z.enum(ASSET_IDS_V1),
    changePercent: z.number().gt(-100).lte(1_000).describe('−30 is a 30% fall, 20 a 20% rise. At most two decimals.'),
  }).strict(),
  z.object({
    kind: z.literal('price_to'),
    asset: z.enum(ASSET_IDS_V1),
    usd: z.string().regex(/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/).describe('The price of one whole token, in dollars, such as "120.50".'),
  }).strict(),
  z.object({
    kind: z.literal('borrow'),
    loan: z.enum(LOANS_V1),
    usdc: z.string().regex(DECIMAL_V1).describe('More USDC borrowed on this loan, such as "500".'),
  }).strict(),
  z.object({
    kind: z.literal('repay'),
    loan: z.enum(LOANS_V1),
    usdc: z.union([z.string().regex(DECIMAL_V1), z.literal('all')]).describe('USDC paid back on this loan, or "all".'),
  }).strict(),
  z.object({
    kind: z.literal('deposit'),
    asset: z.enum(ASSET_IDS_V1),
    amount: z.string().regex(DECIMAL_V1).describe('Tokens pledged, in whole-token units, such as "0.05".'),
    source: z.enum(['wallet', 'new']).describe('"wallet": tokens this wallet holds now. "new": tokens it does not hold yet.'),
  }).strict(),
]);

export const StillWhatIfInputV1Schema = z.object({
  wallet: WalletArgV1,
  changes: z.array(StillChangeV1Schema).min(1).max(4)
    .describe('One to four changes, applied together to the same reading. Loans: "aave-v4" is the stock loan, "morpho:cbBTC" and "morpho:ETH" the crypto ones.'),
}).strict();

const LoanSummaryV1Schema = z.object({
  venue: z.enum(['aave-v4', 'morpho']),
  market: z.string(),
  label: z.string(),
  debtCents: z.string().nullable(),
  healthFactor: z.string().nullable(),
  marginBps: z.number().int().nullable(),
  state: z.enum(['calm', 'watch', 'act', 'liquidation']).nullable(),
}).strict();

const SideV1Schema = z.object({
  availableCents: z.string().nullable(),
  complete: z.boolean(),
  loans: z.array(LoanSummaryV1Schema),
}).strict();

export const StillWhatIfOutputV1Schema = z.object({
  outcome: z.enum(['answer', 'refused', 'invalid_subject', 'name_not_found', 'names_unavailable', 'chain_unavailable']),
  subject: z.object({ address: z.string(), name: z.string().nullable() }).strict().optional(),
  reading: z.object({ block: z.string(), blockTime: z.string() }).strict().optional(),
  /** The engine's answer in words: the same one the Still Agent gives. */
  answer: z.object({
    text: z.string(),
    steps: z.array(z.string()),
    bounds: z.array(z.string()),
    sources: z.array(z.string()),
  }).strict().optional(),
  before: SideV1Schema.optional(),
  after: SideV1Schema.optional(),
  /** Why the change could not be computed, for `refused`. */
  reason: z.string().optional(),
}).strict();

type StillChangeV1 = z.infer<typeof StillChangeV1Schema>;

/** Exact base units from a decimal string; null when it carries more decimals than the token has. */
function unitsV1(text: string, decimals: number): bigint | null {
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > decimals) return null;
  return BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
}

function editOfV1(change: StillChangeV1): ScenarioEditV1 | string {
  switch (change.kind) {
    case 'price': {
      const bps = change.changePercent * 100;
      if (!Number.isInteger(Math.round(bps * 1e6) / 1e6)) return 'A price change is a percentage with at most two decimals.';
      return { kind: 'price', asset: change.asset as AssetId, changeBps: Math.round(bps) };
    }
    case 'price_to':
      return { kind: 'price_to', asset: change.asset as AssetId, cents: unitsV1(change.usd, 2)! };
    case 'borrow': {
      const usdcAtomic = unitsV1(change.usdc, 6);
      if (usdcAtomic === null || usdcAtomic === 0n) return 'A borrow is a USDC amount above zero with at most six decimals.';
      return { kind: 'borrow', venue: change.loan as ScenarioVenueV1, usdcAtomic };
    }
    case 'repay': {
      if (change.usdc === 'all') return { kind: 'repay', venue: change.loan as ScenarioVenueV1, usdcAtomic: 'all' };
      const usdcAtomic = unitsV1(change.usdc, 6);
      if (usdcAtomic === null || usdcAtomic === 0n) return 'A repayment is a USDC amount above zero with at most six decimals, or "all".';
      return { kind: 'repay', venue: change.loan as ScenarioVenueV1, usdcAtomic };
    }
    case 'deposit': {
      const decimals = assetById(change.asset as AssetId).decimals;
      const raw = unitsV1(change.amount, decimals);
      if (raw === null || raw === 0n) return `A deposit is an amount above zero with at most ${decimals} decimals.`;
      return { kind: 'deposit', asset: change.asset as AssetId, raw, source: change.source };
    }
  }
}

function sideV1(report: MirrorReport): z.infer<typeof SideV1Schema> {
  return {
    availableCents: report.headline.availableCents,
    complete: report.headline.complete,
    loans: report.venues
      .filter((line: VenueLine) => line.debtAtomic === null || line.debtAtomic === undefined || BigInt(line.debtAtomic) > 0n)
      .map((line) => ({
        venue: line.venue, market: line.market.toLowerCase(), label: line.label, debtCents: line.debtCents,
        healthFactor: line.safety?.healthFactor ?? null, marginBps: line.safety?.marginBps ?? null, state: line.safety?.state ?? null,
      })),
  };
}

export async function stillWhatIfV1(args: z.infer<typeof StillWhatIfInputV1Schema>): Promise<z.infer<typeof StillWhatIfOutputV1Schema>> {
  const edits: ScenarioEditV1[] = [];
  for (const change of args.changes) {
    const edit = editOfV1(change);
    if (typeof edit === 'string') throw new McpPublicError('still_change_invalid', edit);
    edits.push(edit);
  }
  let checked;
  try {
    // The check resolves a name; the reading it leaves behind is the one the change is applied to.
    checked = await publicStillRuntimeV1.service().check(args.wallet);
  } catch {
    throw new McpPublicError('still_mirror_unavailable',
      'Still could not read this wallet right now. This is our failure and says nothing about the wallet.');
  }
  if (checked.outcome !== 'report') return StillWhatIfOutputV1Schema.parse(checked);
  const subject = { address: checked.report.subject.address, name: checked.report.subject.name };
  let reading;
  try {
    reading = await publicStillRuntimeV1.service().reading(checked.report.subject.address);
  } catch {
    throw new McpPublicError('still_mirror_unavailable',
      'Still could not read this wallet right now. This is our failure and says nothing about the wallet.');
  }
  if (reading.outcome !== 'report') return StillWhatIfOutputV1Schema.parse({ outcome: 'chain_unavailable', attempts: reading.attempts });
  const at = { block: reading.report.reading.block, blockTime: reading.report.reading.blockTime };
  const answer = stillAgentToolAnswerV1({
    plan: { task: 'scenario', edits }, reading: { report: reading.report, input: reading.input }, ru: false, question: '',
  });
  const words = { text: answer.text, steps: answer.steps ?? [], bounds: answer.bounds ?? [], sources: answer.sources };
  const outcome = scenarioV1(reading.input, edits);
  if (!outcome.ok) {
    return StillWhatIfOutputV1Schema.parse({ outcome: 'refused', subject, reading: at, answer: words, reason: outcome.reason });
  }
  return StillWhatIfOutputV1Schema.parse({
    outcome: 'answer', subject, reading: at, answer: words, before: sideV1(outcome.before), after: sideV1(outcome.after),
  });
}

// ---------------------------------------------------------------------------
// Still Spend for assistants: what a Still loan could pay for, from Bitrefill's
// catalogue, through the same reads and cache as Still's /spend. Nothing here
// opens an invoice: a purchase is prepared on the connected server
// (miorail_prepare_still_purchase), reviewed and signed on Still's site.
// ---------------------------------------------------------------------------

export const StillFindSpendInputV1Schema = z.object({
  type: z.enum(SPEND_PRODUCT_TYPES_V1)
    .describe('"esim": a mobile data plan for a trip; "refill": credit for a phone number; "giftcard": shops, travel, food and games.'),
  country: z.string().regex(/^[A-Za-z]{2}$/).describe('Where it is used, as an ISO 3166-1 alpha-2 code such as "JP".'),
  query: z.string().regex(SPEND_QUERY_V1).optional().describe('A brand or a word to narrow the list, such as "Amazon"; at most 40 characters.'),
}).strict();

export const StillFindSpendOutputV1Schema = z.object({
  outcome: z.enum(['products', 'unavailable']),
  type: z.enum(SPEND_PRODUCT_TYPES_V1),
  country: z.string(),
  query: z.string(),
  products: z.array(z.object({ id: z.string(), name: z.string(), countries: z.array(z.string()), inStock: z.boolean() }).strict()).optional(),
  readAt: z.string().optional(),
  /** Bitrefill's failure or ours, for `unavailable`. */
  reason: z.string().optional(),
  checkout: z.object({ enabled: z.boolean() }).strict(),
}).strict();

export const StillSpendProductInputV1Schema = z.object({
  productId: z.string().regex(SPEND_ID_V1).describe('A product id from still_find_spend, such as "bitrefill-esim-japan".'),
}).strict();

export const StillSpendProductOutputV1Schema = z.object({
  outcome: z.enum(['product', 'not_found', 'unavailable']),
  product: z.object({
    id: z.string(),
    name: z.string(),
    country: z.string().nullable(),
    inStock: z.boolean(),
    /** Bitrefill sells it only after steps such as a game's player ID, which it does not offer to Still: Still cannot buy it. */
    prepayment: z.boolean(),
    packages: z.array(z.object({ value: z.string(), faceCurrency: z.string().nullable(), priceUsdc: z.string(), withinCap: z.boolean() }).strict()),
  }).strict().optional(),
  readAt: z.string().optional(),
  checkout: z.object({
    enabled: z.boolean(),
    available: z.boolean(),
    capUsdc: z.string(),
    phone: z.object({ callingCode: z.string(), prefixes: z.array(z.string()) }).strict().nullable(),
  }).strict().optional(),
  reason: z.string().optional(),
}).strict();

const SPEND_UNREAD_V1 = 'Still could not read Bitrefill’s catalogue right now. This is our failure and says nothing about what Bitrefill sells.';

function usdcTextV1(atomic: bigint): string {
  const fraction = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${atomic / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}

export async function stillFindSpendV1(args: z.infer<typeof StillFindSpendInputV1Schema>): Promise<z.infer<typeof StillFindSpendOutputV1Schema>> {
  const country = args.country.toUpperCase(), query = (args.query ?? '').trim();
  // The page's countries: every one with a calling code, which leaves out Cuba, Iran, North Korea and Syria.
  if (spendCallingCodeV1(country) === null) {
    throw new McpPublicError('still_spend_country_not_offered', 'Still Spend is not offered for this country code. Cuba, Iran, North Korea and Syria are left out.');
  }
  const checkout = { enabled: stillSpendPayEnabledV1() };
  try {
    const body = await readSpendSearchV1({ type: args.type, country, query });
    return StillFindSpendOutputV1Schema.parse({ ...body, checkout });
  } catch (error) {
    if (error instanceof SpendReadFailedV1) return { outcome: 'unavailable', type: args.type, country, query, reason: error.reason, checkout };
    throw new McpPublicError('still_spend_unavailable', SPEND_UNREAD_V1);
  }
}

export async function stillSpendProductV1(args: z.infer<typeof StillSpendProductInputV1Schema>): Promise<z.infer<typeof StillSpendProductOutputV1Schema>> {
  let body;
  try {
    body = await readSpendProductV1(args.productId);
  } catch (error) {
    if (error instanceof SpendReadFailedV1) return { outcome: error.reason === 'bitrefill_product_not_found' ? 'not_found' : 'unavailable', reason: error.reason };
    throw new McpPublicError('still_spend_unavailable', SPEND_UNREAD_V1);
  }
  const { product } = body, checkout = spendProductCheckoutV1(product);
  return StillSpendProductOutputV1Schema.parse({
    outcome: 'product',
    product: {
      id: product.id, name: product.name, country: product.country, inStock: product.inStock, prepayment: product.prepayment === true,
      packages: product.packages.map((row) => {
        const price = spendPriceAtomicV1(row.priceUsdc);
        return { value: row.value, faceCurrency: row.faceCurrency, priceUsdc: row.priceUsdc, withinCap: price !== null && price > 0n && price <= STILL_SPEND_CAP_ATOMIC_V1 };
      }),
    },
    readAt: body.readAt,
    checkout: { enabled: checkout.enabled, available: checkout.available, capUsdc: usdcTextV1(BigInt(checkout.capAtomic)), phone: checkout.phone },
  });
}
