import { z } from 'zod';
import type { LlmProvider } from '@mioagent/llm';
import { ASSETS, CRYPTO, STOCKS, assetById, type AssetId } from '@mioagent/still-engine';
import { formatTokenAmount } from '@mioagent/still-engine/format';
import type { MirrorReport } from '@mioagent/still-engine/report';
import type { ScenarioEditV1, ScenarioVenueV1 } from '@mioagent/still-engine/scenario';

import { WHAT_IF_V2, assetsNamedInV2 } from '../../../lib/ui/src/still/agentAnswers.js';
import { numbersInV1 } from './b20AnswerVerify.js';

// ---------------------------------------------------------------------------
// What the Still Agent was asked to calculate.
//
// A question becomes a proposal two ways: fixed rules read the usual phrasings,
// and a model reads the rest. Neither is trusted. Every proposal is grounded
// against the person's own words before anything is computed:
//
//   - an asset is one the question names, or a group it names ("my stocks");
//   - a percentage, a dollar amount, a token amount and a number of days are
//     numbers the question contains;
//   - the direction of a price move is read from the question's own words;
//   - a loan is the one the question names, or the only one there is.
//
// A model that adds a number, an asset or a loan the question did not give has
// its proposal refused, and the person is asked for what is missing instead.
// ---------------------------------------------------------------------------

export type PlanNeedV1 = 'percent' | 'amount' | 'asset' | 'venue' | 'direction';
export type PlanUnsupportedV1 = 'not_reviewed_asset' | 'other_wallet' | 'forecast' | 'tax' | 'trade' | 'other';

export type StillAgentPlanV1 =
  | { task: 'scenario'; edits: ScenarioEditV1[] }
  | { task: 'repay_options'; usdcAtomic: bigint | 'all' | null; venue: ScenarioVenueV1 | null }
  | { task: 'interest'; days: number }
  | { task: 'limit' }
  | { task: 'status' }
  | { task: 'chat' }
  | { task: 'needs'; what: PlanNeedV1 }
  | { task: 'unsupported'; reason: PlanUnsupportedV1 };

const VENUES_V1 = ['aave', 'morpho_cbbtc', 'morpho_eth'] as const;

/** The model's answer, and the rules' too: the same shape goes through the same grounding. */
export const StillAgentProposalSchemaV1 = z.object({
  task: z.enum(['scenario', 'repay_options', 'interest', 'limit', 'status', 'unsupported', 'chat']),
  price: z
    .array(z.object({ asset: z.string(), changePct: z.number().nullable().optional(), toUsd: z.number().nullable().optional() }))
    .max(9)
    .nullable()
    .optional(),
  borrowUsd: z.number().nullable().optional(),
  repayUsd: z.union([z.number(), z.literal('all')]).nullable().optional(),
  deposit: z.object({ asset: z.string(), amount: z.number() }).nullable().optional(),
  venue: z.enum(VENUES_V1).nullable().optional(),
  days: z.number().nullable().optional(),
  reason: z.enum(['not_reviewed_asset', 'other_wallet', 'forecast', 'tax', 'trade', 'other']).nullable().optional(),
});
export type StillAgentProposalV1 = z.infer<typeof StillAgentProposalSchemaV1>;

// `\b` and `\w` are ASCII-only in JavaScript: word edges and Russian endings are spelled out.
const EDGE = '(?:^|[^\\p{L}\\p{N}])';
const FALL_V1 = new RegExp(`${EDGE}(?:drop|fall|fell|crash|down|declin|los(?:e|es|ing|t)|shed|plung|sink|sank|tank|dip|slump|lower|less|cheaper)|упад|падени|сниз|подешев|обвал|просяд|просел|рухн|минус|потеря|ниже|дешевле`, 'iu');
const RISE_V1 = new RegExp(`${EDGE}(?:rise|rose|up|gain|jump|grow|increas|rall|climb|soar|higher|more expensive|рост)|вырас|подорож|повыс|увелич|плюс|выше|дороже`, 'iu');
const WORD_PERCENT_V1: ReadonlyArray<readonly [RegExp, number]> = [
  [/половин|вдвое|в два раза|halve|by half|(?:^|[^\p{L}])half/iu, 50],
  [/четверть|quarter/iu, 25],
];
const STOCK_GROUP_V1 = /акци|stocks|stock market|фондов/iu;
const CRYPTO_GROUP_V1 = /crypto|крипт/iu;
const EVERYTHING_V1 = new RegExp(`${EDGE}(?:everything|all (?:my )?assets|whole portfolio|portfolio|the market|market)|всё|все активы|портфел|рынок`, 'iu');
const ALL_V1 = new RegExp(`${EDGE}(?:all|entire|whole|full|everything)|весь|всё|полностью|целиком`, 'iu');
const AAVE_V1 = /aave|ааве/iu;
const MORPHO_V1 = /morpho|морфо/iu;

const LIMIT_V1 =
  /почему.*(?:уменьш|сниз|упал|измен|меньше|сократ)|why.*(?:decreas|drop|lower|less|chang|reduc|shrank|smaller)|(?:уменьш|сниз)\S*\s.*(?:лимит|сумм\S*\s+займ)|what (?:sets|decides|determines) my (?:limit|room)|из чего (?:складывается|состоит)/iu;
const INTEREST_V1 = /interest|процент\S*\s+(?:по|за|на)|сколько.*(?:плач|стоит\s+займ)|cost of (?:my |the )?loan|ставк/iu;
const REPAY_V1 =
  /(?:уменьш|сниз|погас|закрыт|вернут|выплат|repay|reduce|pay\s*down|pay\s*off|clear).*(?:долг|займ|кредит|debt|loan)|(?:долг|займ|debt|loan).*(?:уменьш|сниз|погас|repay|reduce)|(?:погас|repay|pay\s*(?:back|off|down))/iu;
const DEPOSIT_V1 = /добав|внес|довнес|залож|deposit|pledge|(?:^|[^\p{L}])add/iu;
const BORROW_V1 = /займу|возьму|занять|borrow|take (?:out|another|more)/iu;

/** "60k" and "60 тыс" are 60,000: written out before any number is compared. */
function expandThousandsV1(question: string): string {
  return question.replace(/(\d+(?:[.,]\d+)?)\s*(?:k|тыс\S*)(?![\p{L}])/giu, (_m, n: string) => String(Number(n.replace(',', '.')) * 1000));
}

/** The numbers the person wrote, as absolute values, plus the few they wrote as words. */
function questionNumbersV1(question: string): Set<string> {
  const found = new Set(numbersInV1(expandThousandsV1(question)).map((n) => n.replace(/^-/, '')));
  for (const [pattern, value] of WORD_PERCENT_V1) if (pattern.test(question)) found.add(String(value));
  return found;
}

const canonicalV1 = (value: number): string => numbersInV1(String(Math.abs(value)))[0] ?? '';

/** An id, ticker, name or symbol a model may write, to the registry's id. */
function assetIdV1(text: string): AssetId | null {
  const key = text.trim().toLowerCase().replace(/^\$/, '');
  for (const asset of ASSETS) {
    const names = [asset.id, asset.name, asset.kind === 'stock' ? asset.ticker : asset.symbol, asset.kind === 'crypto' && asset.id === 'ETH' ? 'weth' : ''];
    if (names.some((name) => name && name.toLowerCase() === key)) return asset.id;
  }
  if (key === 'btc' || key === 'bitcoin') return 'cbBTC';
  if (key === 'ether' || key === 'ethereum') return 'ETH';
  return null;
}

const heldV1 = (report: MirrorReport) =>
  report.assets.filter((line) => [line.wallet, line.pledged].some((amount) => amount !== null && BigInt(amount.raw) > 0n)).map((line) => line.asset as AssetId);

/** The parts of a question that each say one thing: "NVDA −30% and BTC +10%". */
function segmentsV1(question: string): string[] {
  // A comma inside a number ("$60,000") is not a break: only one followed by a space is.
  return question.split(/\s(?:and|и|а|but|но|plus|while|пока)\s|[,;](?=\s)/iu).filter((part) => part.trim().length > 0);
}

function directionV1(text: string): -1 | 1 | null {
  const fall = FALL_V1.test(text);
  const rise = RISE_V1.test(text);
  if (fall && !rise) return -1;
  if (rise && !fall) return 1;
  if (/[-−–]\s*\d+(?:[.,]\d+)?\s*%/u.test(text)) return -1;
  if (/\+\s*\d+(?:[.,]\d+)?\s*%/u.test(text)) return 1;
  return null;
}

/** Assets a part of the question names, expanding "my stocks", "crypto" and "everything" to what is held. */
function namedAssetsV1(text: string, report: MirrorReport): AssetId[] {
  const named = assetsNamedInV2(text) as AssetId[];
  if (named.length > 0) return named;
  const held = heldV1(report);
  if (STOCK_GROUP_V1.test(text)) return held.filter((id) => STOCKS.some((s) => s.id === id));
  if (CRYPTO_GROUP_V1.test(text)) return held.filter((id) => CRYPTO.some((c) => c.id === id));
  if (EVERYTHING_V1.test(text)) return held;
  return [];
}

function daysV1(question: string): number | null {
  const counted = /(\d+)\s*(days?|дн\S*|день|сут\S*|weeks?|недел\S*|months?|месяц\S*|years?|год\S*|лет)/iu.exec(question);
  if (counted) {
    const n = Number(counted[1]);
    const unit = counted[2]!.toLowerCase();
    if (/^(?:week|недел)/u.test(unit)) return n * 7;
    if (/^(?:month|месяц)/u.test(unit)) return n * 30;
    if (/^(?:year|год|лет)/u.test(unit)) return n * 365;
    return n;
  }
  if (/year|год/iu.test(question)) return 365;
  if (/month|месяц/iu.test(question)) return 30;
  if (/week|недел/iu.test(question)) return 7;
  if (/(?:^|[^\p{L}])day|день|сутк/iu.test(question)) return 1;
  return null;
}

/** Dollars after a word, for "borrow $200", "погасить 100 долларов". */
function dollarsV1(text: string): number | null {
  const expanded = expandThousandsV1(text).replace(/\d+(?:[.,]\d+)?\s*%/g, ' ');
  const match =
    /\$\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d\s,]*(?:[.,]\d{1,2})?)\s*(?:\$|usd|usdc|доллар|бакс)/iu.exec(expanded) ??
    /(?:на|by|of|займу|возьму|borrow|repay|погасить|погашу|верну)\s+(\d[\d,]*(?:\.\d{1,2})?)/iu.exec(expanded);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return null;
  const value = Number(numbersInV1(raw)[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The usual phrasings, read without a model. Returns null for anything else,
 * which the model then reads. Its proposal is grounded exactly like the model's.
 */
export function rulesProposalV1(question: string, report: MirrorReport): StillAgentProposalV1 | null {
  if (LIMIT_V1.test(question)) return { task: 'limit' };
  if (INTEREST_V1.test(question)) return { task: 'interest', days: daysV1(question) };
  if (REPAY_V1.test(question) && !BORROW_V1.test(question)) {
    return { task: 'repay_options', repayUsd: ALL_V1.test(question) && dollarsV1(question) === null ? 'all' : dollarsV1(question) };
  }
  const price: NonNullable<StillAgentProposalV1['price']> = [];
  for (const segment of segmentsV1(question)) {
    const assets = namedAssetsV1(segment, report);
    if (assets.length === 0) continue;
    const pct = /(\d+(?:[.,]\d+)?)\s*(?:%|percent|per cent|процент)/iu.exec(segment)?.[1] ?? WORD_PERCENT_V1.find(([pattern]) => pattern.test(segment))?.[1]?.toString();
    const target = /(?:\s(?:to|до|at|по)|стоить|будет)\s*\$\s?(\d[\d,.]*\d|\d)/iu.exec(expandThousandsV1(segment))?.[1];
    for (const asset of assets) {
      if (pct !== undefined) price.push({ asset, changePct: Number(String(pct).replace(',', '.')) });
      else if (target !== undefined) price.push({ asset, toUsd: Number(numbersInV1(target)[0]) });
      // "if NVIDIA crashes": a move with no size is asked for its size, never given one.
      else if (directionV1(segment) !== null) price.push({ asset });
    }
  }
  const borrowUsd = WHAT_IF_V2.test(question) && BORROW_V1.test(question) ? dollarsV1(question) : null;
  let deposit: StillAgentProposalV1['deposit'] = null;
  if (DEPOSIT_V1.test(question)) {
    const [asset] = assetsNamedInV2(question);
    const amount = /(\d+(?:[.,]\d+)?)/u.exec(question.replace(/\d+(?:[.,]\d+)?\s*%/g, ' '))?.[1];
    if (asset && amount) deposit = { asset, amount: Number(amount.replace(',', '.')) };
  }
  if (price.length === 0 && borrowUsd === null && deposit === null) return null;
  return { task: 'scenario', price, borrowUsd, deposit };
}

/** A decimal written by a person, in a token's base units, without a float in between. */
function rawAmountV1(value: number, decimals: number): bigint | null {
  const text = canonicalV1(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) return null;
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

const usdcAtomicV1 = (dollars: number): bigint | null => rawAmountV1(dollars, 6);

function venueLinesV1(report: MirrorReport) {
  return report.venues.map((line) => {
    const crypto = line.venue === 'morpho' ? CRYPTO.find((c) => c.morphoMarket.toLowerCase() === line.market.toLowerCase()) : undefined;
    const venue: ScenarioVenueV1 | null = line.venue === 'aave-v4' ? 'aave-v4' : crypto ? `morpho:${crypto.id}` : null;
    return { line, venue };
  });
}

/**
 * The loan the question means: named, or the only one that fits. A model may
 * name a loan in its proposal, but only the question's own words choose one.
 */
function resolveVenueV1(question: string, report: MirrorReport, want: 'debt' | 'collateral'): ScenarioVenueV1 | null {
  const lines = venueLinesV1(report).filter((entry) => entry.venue !== null);
  const fits = lines.filter(({ line, venue }) => {
    if (want === 'debt') return line.debtCents !== null && BigInt(line.debtCents) > 0n;
    if (venue === 'aave-v4') return report.assets.some((a) => a.venue === 'aave-v4' && a.pledged !== null && BigInt(a.pledged.raw) > 0n);
    return report.assets.some((a) => venue === `morpho:${a.asset}` && a.pledged !== null && BigInt(a.pledged.raw) > 0n);
  });
  const namedByWord = AAVE_V1.test(question)
    ? 'aave-v4'
    : MORPHO_V1.test(question)
      ? (() => {
          const crypto = assetsNamedInV2(question).find((id) => CRYPTO.some((c) => c.id === id));
          return crypto ? (`morpho:${crypto}` as ScenarioVenueV1) : null;
        })()
      : null;
  if (namedByWord) return namedByWord;
  if (fits.length === 1) return fits[0]!.venue;
  // "my bitcoin loan": the collateral names the market.
  const named = assetsNamedInV2(question) as AssetId[];
  if (named.length === 1) {
    const asset = assetById(named[0]!);
    const venue: ScenarioVenueV1 = asset.kind === 'stock' ? 'aave-v4' : `morpho:${asset.id}`;
    if (fits.some((entry) => entry.venue === venue)) return venue;
  }
  return null;
}

/** A proposal checked against the question and the reading, or what is missing. */
export function groundProposalV1(proposal: StillAgentProposalV1, question: string, report: MirrorReport): StillAgentPlanV1 {
  const numbers = questionNumbersV1(question);
  const said = (value: number) => numbers.has(canonicalV1(value));
  switch (proposal.task) {
    case 'chat':
      return { task: 'chat' };
    case 'status':
      return { task: 'status' };
    case 'limit':
      return { task: 'limit' };
    case 'unsupported':
      return { task: 'unsupported', reason: proposal.reason ?? 'other' };
    case 'interest': {
      // The period is read from the question's own words; none given is a month, and the answer says so.
      const days = daysV1(question) ?? 30;
      return { task: 'interest', days: Math.max(1, Math.min(3650, days)) };
    }
    case 'repay_options': {
      const venue = resolveVenueV1(question, report, 'debt');
      const named = AAVE_V1.test(question) || MORPHO_V1.test(question) ? venue : null;
      if (proposal.repayUsd === 'all') return ALL_V1.test(question) ? { task: 'repay_options', usdcAtomic: 'all', venue: named } : { task: 'needs', what: 'amount' };
      if (proposal.repayUsd == null) return { task: 'repay_options', usdcAtomic: null, venue: named };
      if (!said(proposal.repayUsd)) return { task: 'needs', what: 'amount' };
      const atomic = usdcAtomicV1(proposal.repayUsd);
      return atomic === null || atomic === 0n ? { task: 'needs', what: 'amount' } : { task: 'repay_options', usdcAtomic: atomic, venue: named };
    }
    case 'scenario':
      return groundScenarioV1(proposal, question, report, said);
  }
}

function groundScenarioV1(proposal: StillAgentProposalV1, question: string, report: MirrorReport, said: (value: number) => boolean): StillAgentPlanV1 {
  const edits: ScenarioEditV1[] = [];
  const segments = segmentsV1(question);
  for (const item of proposal.price ?? []) {
    const asset = assetIdV1(item.asset);
    if (!asset) return { task: 'unsupported', reason: 'not_reviewed_asset' };
    // The part of the question that names this asset, directly or through its group.
    const segment = segments.find((part) => namedAssetsV1(part, report).includes(asset));
    if (!segment) return { task: 'needs', what: 'asset' };
    if (item.changePct != null) {
      if (!said(item.changePct)) return { task: 'needs', what: 'percent' };
      const direction = directionV1(segment) ?? directionV1(question);
      if (direction === null) return { task: 'needs', what: 'direction' };
      const changeBps = direction * Math.round(Math.abs(item.changePct) * 100);
      if (changeBps <= -10_000 || changeBps > 100_000 || changeBps === 0) return { task: 'needs', what: 'percent' };
      edits.push({ kind: 'price', asset, changeBps });
    } else if (item.toUsd != null) {
      if (!said(item.toUsd)) return { task: 'needs', what: 'amount' };
      const cents = rawAmountV1(item.toUsd, 2);
      if (cents === null || cents === 0n) return { task: 'needs', what: 'amount' };
      edits.push({ kind: 'price_to', asset, cents });
    } else {
      return { task: 'needs', what: 'percent' };
    }
  }
  if (proposal.borrowUsd != null) {
    if (!said(proposal.borrowUsd)) return { task: 'needs', what: 'amount' };
    const atomic = usdcAtomicV1(proposal.borrowUsd);
    if (atomic === null || atomic === 0n) return { task: 'needs', what: 'amount' };
    const venue = resolveVenueV1(question, report, 'collateral');
    if (!venue) return { task: 'needs', what: 'venue' };
    edits.push({ kind: 'borrow', venue, usdcAtomic: atomic });
  }
  if (proposal.repayUsd != null) {
    const venue = resolveVenueV1(question, report, 'debt');
    if (!venue) return { task: 'needs', what: 'venue' };
    if (proposal.repayUsd === 'all') {
      if (!ALL_V1.test(question)) return { task: 'needs', what: 'amount' };
      edits.push({ kind: 'repay', venue, usdcAtomic: 'all' });
    } else {
      if (!said(proposal.repayUsd)) return { task: 'needs', what: 'amount' };
      const atomic = usdcAtomicV1(proposal.repayUsd);
      if (atomic === null || atomic === 0n) return { task: 'needs', what: 'amount' };
      edits.push({ kind: 'repay', venue, usdcAtomic: atomic });
    }
  }
  if (proposal.deposit) {
    const asset = assetIdV1(proposal.deposit.asset);
    if (!asset) return { task: 'unsupported', reason: 'not_reviewed_asset' };
    if (!(assetsNamedInV2(question) as AssetId[]).includes(asset)) return { task: 'needs', what: 'asset' };
    if (!said(proposal.deposit.amount)) return { task: 'needs', what: 'amount' };
    const raw = rawAmountV1(proposal.deposit.amount, assetById(asset).decimals);
    if (raw === null || raw === 0n) return { task: 'needs', what: 'amount' };
    // Tokens the wallet holds are pledged from it; more than it holds are counted as new.
    const line = report.assets.find((a) => a.asset === asset);
    const inWallet = line?.wallet ? BigInt(line.wallet.raw) : 0n;
    edits.push({ kind: 'deposit', asset, raw, source: inWallet >= raw ? 'wallet' : 'new' });
  }
  if (edits.length === 0) return { task: 'needs', what: 'percent' };
  return { task: 'scenario', edits };
}

// ---------------------------------------------------------------------------
// The model's reading of a question the rules did not recognise.
// ---------------------------------------------------------------------------

function plannerPromptV1(report: MirrorReport): string {
  const held = heldV1(report);
  const loans = venueLinesV1(report)
    .filter(({ line }) => line.debtCents !== null && BigInt(line.debtCents) > 0n)
    .map(({ venue }) => (venue === 'aave-v4' ? 'aave' : venue === 'morpho:cbBTC' ? 'morpho_cbbtc' : 'morpho_eth'));
  return [
    'You turn one question about the reader\'s own Base wallet into a JSON calculation request for Still\'s engine. You never answer the question and never compute anything.',
    'Assets the engine reads (id: names): NVDAc: NVIDIA, NVDA; AAPLc: Apple, AAPL; TSLAc: Tesla, TSLA; MSFTc: Microsoft, MSFT; AMZNc: Amazon, AMZN; GOOGLc: Alphabet, Google, GOOGL; METAc: Meta, META; cbBTC: Bitcoin, BTC; ETH: Ether, WETH.',
    `The wallet holds: ${held.length ? held.join(', ') : 'none of them'}. Its loans: ${loans.length ? loans.join(', ') : 'none'}.`,
    'Answer with ONE JSON object and nothing else:',
    '{"task": "scenario"|"repay_options"|"interest"|"limit"|"status"|"unsupported"|"chat",',
    ' "price": [{"asset": id, "changePct": number, "toUsd": number}] (scenario: a price moving by a percentage OR to a dollar price),',
    ' "borrowUsd": number (scenario: borrowing more), "repayUsd": number or "all", "deposit": {"asset": id, "amount": tokens},',
    ' "venue": "aave"|"morpho_cbbtc"|"morpho_eth" (only if the question names the loan), "days": number (interest period),',
    ' "reason": "not_reviewed_asset"|"other_wallet"|"forecast"|"tax"|"trade"|"other" (unsupported only)}',
    'Tasks: scenario = what a price move, more borrowing, a repayment or more collateral would do; repay_options = ways to pay a loan down; interest = what the loan costs over a period; limit = why the borrowing room is what it is or changed; status = a plain question about the room, loan safety, holdings, market hours or dividends; chat = greetings and thanks; unsupported = anything else, including predictions, other wallets, taxes, trades and assets not listed.',
    'Rules: copy every number exactly as the question writes it, as a positive number; never add a number, asset or loan the question does not give; leave out a field the question does not give; changePct is always positive, the question\'s words say the direction.',
  ].join('\n');
}

/** The model's proposal, or null when it did not keep the contract twice. */
export async function modelProposalV1(provider: LlmProvider, question: string, report: MirrorReport): Promise<StillAgentProposalV1 | null> {
  const messages = [
    { role: 'system' as const, content: plannerPromptV1(report) },
    { role: 'user' as const, content: question },
  ];
  // One retry, and only when the answer did not obey the contract.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await provider.generate({ messages, temperature: 0, reasoningEffort: 'none', timeoutMs: 9_000 });
    const text = (response.message.content ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    try {
      const parsed = StillAgentProposalSchemaV1.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to the retry
    }
  }
  return null;
}

/** How a plan reads in the stage line: "NVIDIA −30% · repay $100". Names and numbers only. */
export function planSummaryV1(plan: StillAgentPlanV1, ru: boolean): string {
  const usd = (atomic: bigint) => `$${(Number(atomic) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  switch (plan.task) {
    case 'scenario':
      return plan.edits
        .map((edit) => {
          if (edit.kind === 'price') return `${assetById(edit.asset).name} ${edit.changeBps < 0 ? '−' : '+'}${Math.abs(edit.changeBps) / 100}%`;
          if (edit.kind === 'price_to') return `${assetById(edit.asset).name} → ${usd(edit.cents * 10_000n)}`;
          if (edit.kind === 'borrow') return `${ru ? 'займ' : 'borrow'} +${usd(edit.usdcAtomic)}`;
          if (edit.kind === 'repay') return `${ru ? 'погашение' : 'repay'} ${edit.usdcAtomic === 'all' ? (ru ? 'всё' : 'all') : usd(edit.usdcAtomic)}`;
          return `${ru ? 'залог' : 'pledge'} +${formatTokenAmount(edit.raw, assetById(edit.asset).decimals)} ${edit.asset}`;
        })
        .join(' · ');
    case 'repay_options':
      return `${ru ? 'варианты погашения' : 'repayment options'}${plan.usdcAtomic === null || plan.usdcAtomic === 'all' ? '' : ` ${usd(plan.usdcAtomic)}`}`;
    case 'interest':
      return ru ? `проценты за ${plan.days} дн.` : `interest over ${plan.days} days`;
    case 'limit':
      return ru ? 'из чего сложился лимит' : 'what set the limit';
    default:
      return '';
  }
}
