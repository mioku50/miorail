import { createHash } from 'node:crypto';
import { assertRwaSignalV1, B20CorporateActionRowV1Schema, RepresentationRatioChangeV1Schema, type RwaSignalRowV1 } from '@mioagent/route-storage';
import { ReopenCallV1Schema, ReopenResultV1Schema, ReopenStockV1Schema } from '../lib/rwa-market-reality/src/reopenGame.js';

// Operator-side drafts only. The words come from bounded templates; numbers,
// dates and identity come from stored facts, never a language model. There is
// no publisher, chain reader or notification sender in this module.
export interface EditorialSignalInputV1 {
  signal: RwaSignalRowV1;
  /** An address-bound underlying name from representation_underlying. */
  symbol: string | null;
  /** An address-bound official display ticker, never used as identity. */
  ticker: string | null;
}

export interface EditorialRoundInputV1 {
  roundId: string;
  number: number;
  closeAt: string;
  locksAt: string;
  settledAt: string;
  stocks: unknown[];
  calls: unknown[];
  results: unknown[];
}

export interface EditorialSnapshotV1 {
  readAt: string;
  signals: EditorialSignalInputV1[];
  rounds: EditorialRoundInputV1[];
  /** Reading is bounded, so a capped input must not look like the whole feed. */
  signalsCapped: boolean;
  /** Same-token, same-transaction announcement brackets plus an independent
   * confirmed ratio reading, using the product's existing stored contracts. */
  conversions?: EditorialConversionInputV1[];
  conversionsCapped?: boolean;
}

export interface EditorialConversionInputV1 {
  issuer: string;
  symbol: string | null;
  ticker: string | null;
  announcement: unknown;
  setter: unknown;
  endAnnouncement: unknown;
  confirmation: unknown;
}

export interface EditorialDraftV1 {
  schemaVersion: 'miorail-editorial-draft/v1';
  id: string;
  status: 'draft';
  kind: 'listing' | 'dividend' | 'dividend_conversion' | 'corporate_action' | 'weekend_reopen';
  generatedAt: string;
  occurredAt: string;
  recordedAt: string;
  headline: string;
  body: string;
  evidence: string;
  targetUrl: string;
  source: { table: 'rwa_signals' | 'reopen_rounds' | 'b20_corporate_actions'; ids: string[]; urls: string[]; facts: Record<string, unknown> };
  card: { value: string; label: string; lines: string[] };
  text: string;
  /** Hash of the projected public facts, not a claim that a quote is live. */
  factsHash: string;
}

const ISO_V1 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NAME_V1 = /^[A-Za-z0-9][A-Za-z0-9.-]{0,15}$/;
const SOURCE_LABELS_V1: Record<string, string> = {
  coinbase_stocks_api: "Coinbase's stock list",
  backed_assets_api: "Backed's bTokens list",
  base_product_list: "Base's stock list",
};
const LIST_HOSTS_V1 = new Set(['api.coinbase.com', 'www.coinbase.com', 'api.xstocks.fi', 'brand.base.org', 'base.org', 'www.base.org']);
const DIVIDEND_HOSTS_V1 = new Set(['www.sec.gov', 'news.microsoft.com', 'www.prnewswire.com']);

function isoV1(value: unknown): value is string {
  return typeof value === 'string' && ISO_V1.test(value) && Number.isFinite(Date.parse(value));
}

function nameV1(value: unknown): string | null {
  return typeof value === 'string' && NAME_V1.test(value) ? value : null;
}

/** Source links are known public documents. Corporate-action URI is never a
 * source link, and unknown hosts, credentials and secret query strings fail. */
function sourceUrlV1(value: unknown, hosts: ReadonlySet<string>, publicBtokensQuery = false): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password || url.hash) return null;
    if (url.search && !(publicBtokensQuery && url.hostname === 'api.xstocks.fi' && url.search === '?type=btokens')) return null;
    return url.href;
  } catch { return null; }
}

function targetV1(symbol: string | null): string {
  return `https://miorail.xyz${symbol && nameV1(symbol) ? `/stocks/${encodeURIComponent(symbol)}` : '/today'}`;
}

function atV1(value: string): string { return value.replace('T', ' ').replace(/\.000Z$/, ' UTC').replace(/Z$/, ' UTC'); }

type DraftInputV1 = Omit<EditorialDraftV1, 'schemaVersion' | 'status' | 'id' | 'text' | 'factsHash'>;

function draftV1(input: DraftInputV1): EditorialDraftV1 {
  const factsHash = createHash('sha256').update(JSON.stringify({ kind: input.kind, occurredAt: input.occurredAt, source: input.source })).digest('hex');
  const text = `${input.headline}\n\n${input.body}\n\n${input.evidence}\n${input.targetUrl}`;
  return { ...input, schemaVersion: 'miorail-editorial-draft/v1', status: 'draft', id: `${input.kind}-${factsHash.slice(0, 16)}`, text, factsHash };
}

function signalDraftV1(input: EditorialSignalInputV1, generatedAt: string): EditorialDraftV1 | null {
  const row = input.signal;
  if (!/^[1-9][0-9]*$/.test(row.signalId) || !isoV1(row.recordedAt)) return null;
  let signal;
  try {
    signal = assertRwaSignalV1({ kind: row.kind, chainId: row.chainId, subjectAddress: row.subjectAddress,
      officialAddress: row.officialAddress, occurredAt: row.occurredAt, dedupeKey: `editorial:${row.signalId}`, facts: row.facts });
  } catch { return null; }
  const base = { generatedAt, occurredAt: signal.occurredAt, recordedAt: row.recordedAt, targetUrl: targetV1(nameV1(input.symbol)) };
  const ids = [row.signalId];
  if (signal.kind === 'official_source_added_asset') {
    const facts = signal.facts;
    const ticker = nameV1(facts.ticker);
    const label = SOURCE_LABELS_V1[facts.sourceKind];
    const url = sourceUrlV1(facts.sourceUrl, LIST_HOSTS_V1, true);
    if (!ticker || !label || !url) return null;
    return draftV1({ ...base, kind: 'listing', headline: `Miorail recorded ${ticker} in ${label}`,
      body: `Miorail recorded ${ticker} in ${label} on ${atV1(signal.occurredAt)}. This is Miorail's observation date, not an issuer launch date. Listing an exact Base address does not establish an available market.`,
      evidence: `Source: ${label}. Recorded ${atV1(row.recordedAt)}.`,
      source: { table: 'rwa_signals', ids, urls: [url], facts: { ticker, tokenAddress: signal.subjectAddress, sourceKind: facts.sourceKind } },
      card: { value: ticker, label: 'Recorded in the official list', lines: [label, 'An exact Base address; market availability is a separate check.'] } });
  }
  if (signal.kind === 'official_asset_dividend_declared') {
    const facts = signal.facts;
    const symbol = nameV1(facts.symbol);
    const url = sourceUrlV1(facts.sourceUrl, DIVIDEND_HOSTS_V1);
    if (!symbol || !url) return null;
    return draftV1({ ...base, targetUrl: targetV1(symbol), kind: 'dividend', headline: `${symbol}: a dividend was declared`,
      body: `The company declared $${facts.amountPerShare} per underlying share, payable ${facts.payDate}, with record date ${facts.recordDate}. This is a company declaration; it does not establish a payment to a token holder or a token multiplier change.`,
      evidence: `Source: the company's release dated ${facts.declaredOn}. Miorail recorded it ${atV1(row.recordedAt)}.`,
      source: { table: 'rwa_signals', ids, urls: [url], facts: { symbol, amountPerShare: facts.amountPerShare, declaredOn: facts.declaredOn, recordDate: facts.recordDate, payDate: facts.payDate } },
      card: { value: `$${facts.amountPerShare}`, label: `Declared per ${symbol} share`, lines: [`Payable ${facts.payDate} · record date ${facts.recordDate}`, 'Company declaration; token conversion is a separate event.'] } });
  }
  if (signal.kind === 'official_asset_corporate_action_announced') {
    const facts = signal.facts;
    const ticker = nameV1(input.ticker);
    if (!ticker) return null;
    // Never repeat arbitrary issuer prose/URI; topic-only is explicitly named.
    const payload = facts.payloadState === 'decoded' ? 'The announcement event was decoded.' : 'Its payload was not decoded; no description is inferred.';
    const changed = facts.carriesMultiplierChange === true ? 'The same transaction also carried a multiplier change.' : 'The announcement alone does not establish a multiplier change.';
    return draftV1({ ...base, kind: 'corporate_action', headline: `${ticker}: an onchain issuer announcement`,
      body: `Miorail recorded a corporate-action announcement in Base block ${facts.blockNumber}, at ${atV1(signal.occurredAt)}. ${payload} ${changed}`,
      evidence: `Source: the stored Base Announcement event. Recorded ${atV1(row.recordedAt)}.`,
      source: { table: 'rwa_signals', ids, urls: [`https://basescan.org/tx/${facts.transactionHash}`], facts: { ticker, tokenAddress: signal.subjectAddress, blockNumber: facts.blockNumber, transactionHash: facts.transactionHash, payloadState: facts.payloadState, carriesMultiplierChange: facts.carriesMultiplierChange ?? null } },
      card: { value: ticker, label: 'Issuer announcement on Base', lines: [`Block ${facts.blockNumber}`, payload, changed] } });
  }
  return null;
}

function roundDraftsV1(row: EditorialRoundInputV1, generatedAt: string): EditorialDraftV1[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.roundId) || !Number.isSafeInteger(row.number) || row.number < 1 ||
      ![row.closeAt, row.locksAt, row.settledAt].every(isoV1) || Date.parse(row.closeAt) >= Date.parse(row.locksAt) || Date.parse(row.locksAt) >= Date.parse(row.settledAt)) return [];
  const stocks = ReopenStockV1Schema.array().min(1).max(5).safeParse(row.stocks);
  const calls = ReopenCallV1Schema.array().max(5).safeParse(row.calls);
  const results = ReopenResultV1Schema.array().min(1).max(5).safeParse(row.results);
  if (!stocks.success || !calls.success || !results.success) return [];
  if ([stocks.data, calls.data, results.data].some((rows) => new Set(rows.map((item) => item.symbol)).size !== rows.length)) return [];
  return results.data.flatMap((result) => {
    const symbol = nameV1(result.symbol);
    const stock = stocks.data.find((item) => item.symbol === symbol);
    const call = calls.data.find((item) => item.symbol === symbol);
    if (!symbol || !stock || !call?.base || !result.reopen || !result.at || result.outcome === 'void' || Date.parse(result.at) > Date.parse(row.settledAt)) return [];
    return [draftV1({ kind: 'weekend_reopen', generatedAt, occurredAt: result.at, recordedAt: row.settledAt,
      headline: `${symbol}: the weekend and the reopen`,
      body: `The last reference close was $${stock.close}. Base's six-hour median at the game lock was $${call.base}. The first recorded reference after the weekend was $${result.reopen} at ${atV1(result.at)}. These are different readings at different times, not an execution price or a forecast.`,
      evidence: `Source: frozen Call the reopen round ${row.number} (${row.roundId}); lock ${atV1(row.locksAt)}, settled ${atV1(row.settledAt)}.`,
      targetUrl: targetV1(symbol), source: { table: 'reopen_rounds', ids: [row.roundId], urls: ['https://miorail.xyz/stocks/weekend'],
        facts: { symbol, roundNumber: row.number, close: stock.close, closeAt: row.closeAt, baseAtLock: call.base, locksAt: row.locksAt, reopen: result.reopen, reopenAt: result.at, settledAt: row.settledAt } },
      card: { value: symbol, label: 'Weekend readings, then the reopen', lines: [`Last reference close $${stock.close}`, `Base at lock $${call.base} · first reopen reference $${result.reopen}`, 'Different times; neither is a live execution price.'] } })];
  });
}

const WAD_V1 = 10n ** 18n;

/** Exactly representable WAD only: no float rounding authors a new value. */
function multiplierDigitsV1(raw: string, scale: string): string | null {
  const numerator = BigInt(raw) * WAD_V1;
  const divisor = BigInt(scale);
  if (numerator % divisor !== 0n) return null;
  const wad = numerator / divisor;
  const fraction = (wad % WAD_V1).toString().padStart(18, '0').replace(/0+$/, '');
  return `${wad / WAD_V1}${fraction ? `.${fraction}` : ''}`;
}

function conversionDraftV1(input: EditorialConversionInputV1, generatedAt: string): EditorialDraftV1 | null {
  const announcement = B20CorporateActionRowV1Schema.safeParse(input.announcement);
  const setter = B20CorporateActionRowV1Schema.safeParse(input.setter);
  const end = B20CorporateActionRowV1Schema.safeParse(input.endAnnouncement);
  const confirmation = RepresentationRatioChangeV1Schema.safeParse(input.confirmation);
  const ticker = nameV1(input.ticker);
  if (input.issuer !== 'coinbase' || !ticker || !announcement.success || !setter.success || !end.success || !confirmation.success) return null;
  const a = announcement.data;
  const m = setter.data;
  const e = end.data;
  const r = confirmation.data;
  // A small multiplier rise near a company pay date is not proof of a
  // dividend. Require the issuer's decoded words and the exact log bracket.
  if (a.event !== 'announcement' || a.payloadState !== 'decoded' || a.description?.trim().toLowerCase() !== 'cash dividend' ||
      !['multiplier_updated', 'ui_multiplier_updated'].includes(m.event) || m.payloadState !== 'decoded' || !m.multiplierWad ||
      e.event !== 'end_announcement' || e.payloadState !== 'decoded' || e.announcementId !== a.announcementId ||
      [m, e].some((row) => row.tokenAddress !== a.tokenAddress || row.transactionHash !== a.transactionHash || row.blockNumber !== a.blockNumber || row.blockTime !== a.blockTime) ||
      !(a.logIndex < m.logIndex && m.logIndex < e.logIndex) || r.tokenAddress !== a.tokenAddress || r.ratioKind !== 'b20_multiplier') return null;
  const effectiveAt = m.effectiveAt ?? m.blockTime;
  if (Date.parse(effectiveAt) > Date.parse(r.observedAt) || BigInt(r.blockNumber) < BigInt(m.blockNumber) ||
      BigInt(r.toRawValue) <= BigInt(r.fromRawValue) ||
      BigInt(r.toRawValue) * WAD_V1 !== BigInt(m.multiplierWad) * BigInt(r.scale)) return null;
  const from = multiplierDigitsV1(r.fromRawValue, r.scale);
  const to = multiplierDigitsV1(r.toRawValue, r.scale);
  if (!from || !to) return null;
  const recordedAt = [a.observedAt, m.observedAt, e.observedAt, r.observedAt, r.recordedAt]
    .reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest);
  return draftV1({ kind: 'dividend_conversion', generatedAt, occurredAt: effectiveAt, recordedAt,
    headline: `${ticker}: a dividend converted into shares`,
    body: `The issuer's decoded “Cash Dividend” announcement bracketed a multiplier setter in Base block ${m.blockNumber}. Shares per token moved from ${from} to ${to}, effective ${atV1(effectiveAt)}; a stored token reading confirmed the value in block ${r.blockNumber} at ${atV1(r.observedAt)}. This does not establish who held the token then, or a cash payment to a wallet.`,
    evidence: `Source: the stored Announcement / multiplier / EndAnnouncement logs in one transaction, confirmed by the ratio reader. Recorded ${atV1(recordedAt)}.`,
    targetUrl: targetV1(nameV1(input.symbol)),
    source: { table: 'b20_corporate_actions', ids: [a, m, e].map((row) => `${row.transactionHash}:${row.logIndex}`), urls: [`https://basescan.org/tx/${a.transactionHash}`],
      facts: { ticker, tokenAddress: a.tokenAddress, transactionHash: a.transactionHash, announcementId: a.announcementId,
        announcementLogIndex: a.logIndex, multiplierLogIndex: m.logIndex, endLogIndex: e.logIndex, setterBlock: String(m.blockNumber), setterAt: m.blockTime,
        effectiveAt, fromRawValue: r.fromRawValue, toRawValue: r.toRawValue, scale: r.scale, multiplierWad: m.multiplierWad,
        confirmedBlock: r.blockNumber, confirmedBlockHash: r.blockHash, confirmedAt: r.observedAt, confirmationEvidenceHash: r.evidenceHash } },
    card: { value: ticker, label: 'Cash Dividend · conversion confirmed', lines: [`Shares per token ${from} → ${to}`, `Setter block ${m.blockNumber} · confirmed in block ${r.blockNumber}`, 'More shares per token; no wallet payment is inferred.'] } });
}

/** Exact [since, until) window, both event and recording already known at the
 * snapshot. No fresh facts yields no draft, never yesterday dressed as today. */
export function editorialDraftsV1(input: { snapshot: EditorialSnapshotV1; since: string; until: string; limit?: number }): EditorialDraftV1[] {
  if (![input.since, input.until, input.snapshot.readAt].every(isoV1) || Date.parse(input.since) >= Date.parse(input.until)) throw new Error('editorial_window_invalid');
  const generatedAt = input.snapshot.readAt;
  // A snapshot read today must not lend tomorrow's knowledge to a historical
  // --at run. Both when it happened and when we learned it are bounded.
  const knownBy = Math.min(Date.parse(generatedAt), Date.parse(input.until));
  const candidates = [
    ...input.snapshot.signals.flatMap((row) => { const draft = signalDraftV1(row, generatedAt); return draft ? [draft] : []; }),
    ...input.snapshot.rounds.flatMap((row) => roundDraftsV1(row, generatedAt)),
    ...(input.snapshot.conversions ?? []).flatMap((row) => { const draft = conversionDraftV1(row, generatedAt); return draft ? [draft] : []; }),
  ].filter((draft) => Date.parse(draft.occurredAt) >= Date.parse(input.since) && Date.parse(draft.occurredAt) < Date.parse(input.until) && Date.parse(draft.occurredAt) <= knownBy && Date.parse(draft.recordedAt) <= knownBy);
  const converted = new Set(candidates.filter((draft) => draft.kind === 'dividend_conversion').map((draft) => `${draft.source.facts.transactionHash}:${draft.source.facts.tokenAddress}`));
  const seen = new Set<string>();
  const unique = candidates.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id)).filter((draft) => {
    if (draft.kind === 'corporate_action' && converted.has(`${draft.source.facts.transactionHash}:${draft.source.facts.tokenAddress}`)) return false;
    // Distinct source checks of one listing and multiple logs of one issuer
    // announcement should not make a draft pack feel like an event debugger.
    const key = draft.kind === 'corporate_action' || draft.kind === 'dividend_conversion' ? `${draft.kind}:${draft.source.facts.transactionHash}:${draft.source.facts.tokenAddress}`
      : draft.kind === 'dividend' ? `${draft.kind}:${draft.source.facts.symbol}:${draft.source.facts.declaredOn}:${draft.source.facts.amountPerShare}:${draft.source.facts.payDate}`
        : draft.kind === 'listing' ? `${draft.kind}:${draft.source.facts.tokenAddress}:${draft.occurredAt.slice(0, 10)}` : draft.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.slice(0, Math.max(0, Math.min(10, Math.floor(input.limit ?? 3))));
}

function xmlV1(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function textV1(x: number, y: number, value: string, size: number, fill = '#f3f4f6', mono = false): string {
  return `<text x="${x}" y="${y}" font-family="${mono ? 'JetBrains Mono' : 'Inter'}" font-size="${size}" fill="${fill}">${xmlV1(value)}</text>`;
}

/** Same dimensions, typefaces and brand gradient as Found. Values and price
 * direction have no green/red colouring. Generated media stays a draft. */
export function editorialCardSvgV1(draft: EditorialDraftV1): string {
  const out = ['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">',
    '<defs><radialGradient id="glow" cx="0.82" cy="0.08" r="0.62"><stop offset="0" stop-color="#262a48"/><stop offset="1" stop-color="#0b0b10" stop-opacity="0"/></radialGradient><linearGradient id="brand"><stop stop-color="#6d8dff"/><stop offset="1" stop-color="#a77bff"/></linearGradient></defs>',
    '<rect width="1200" height="630" fill="#0b0b10"/><rect width="1200" height="630" fill="url(#glow)"/><rect width="1200" height="7" fill="url(#brand)"/>',
    textV1(72, 88, 'MIORAIL', 20, '#8fa2ff', true), textV1(240, 88, 'Today on Base', 20, '#a4a7b5', true),
    textV1(975, 88, 'DRAFT', 20, '#a4a7b5', true),
    textV1(72, 222, draft.card.value, draft.card.value.length > 12 ? 72 : 100),
    textV1(72, 280, draft.card.label, 28, '#a4a7b5'), '<rect x="72" y="318" width="1056" height="1" fill="#1f2130"/>'];
  let y = 365;
  for (const line of draft.card.lines) {
    // Templates are short; wrap at word boundaries and refuse hidden overflow.
    let current = '';
    for (const word of line.split(' ')) {
      if (`${current} ${word}`.trim().length > 78 && current) { out.push(textV1(72, y, current, 23)); y += 36; current = word; }
      else current = `${current} ${word}`.trim();
    }
    if (current) { out.push(textV1(72, y, current, 23)); y += 36; }
  }
  if (y > 545) throw new Error('editorial_card_overflow');
  out.push(textV1(72, 562, `Occurred ${atV1(draft.occurredAt)}`, 17, '#a4a7b5', true));
  out.push(textV1(72, 598, `Recorded facts · human review before publishing · ${draft.targetUrl.replace('https://', '')}`, 16, '#6f7285', true), '</svg>');
  return out.join('');
}
