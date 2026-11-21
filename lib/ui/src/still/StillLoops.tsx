import React, { useState } from 'react';

import { LOOP_BRANDS_V1 } from '@mioagent/still-engine/loops';
import { STOCKS } from '@mioagent/still-engine/registry';

import { MIORAIL_SOURCE_URL_V1 } from '../console/ConsoleShell';
import type { SkyStateV1 } from './skyState';
import { StillEligibilityConfirmSlotV1 } from './StillEligibility';
import { StillHeader, StillLink } from './StillFrame';
import { LOOP_BRAND_WORDS_V1, StillLoopOffer, stillLoopSpendHrefV1 } from './StillLoop';
import { StillIconV1 } from './icons';
import type { LendingLoopWireV1 } from '../console/lendingReviewView';

void React;

// ---------------------------------------------------------------------------
// /loops: Loops in public. The week's count, how to make one, and the wall of
// Loops their owners chose to show. It names no wallet and no transaction.
// ---------------------------------------------------------------------------

export const STILL_LOOPS_V1 = { label: 'Loops', path: '/loops' } as const;

type BrandV1 = keyof typeof LOOP_BRAND_WORDS_V1;
const BRANDS_V1 = Object.keys(LOOP_BRAND_WORDS_V1) as BrandV1[];
const COLLATERAL_V1: Readonly<Record<BrandV1, string>> = { apple: 'AAPLc', amazon: 'AMZNc', google: 'GOOGLc', meta: 'METAc', microsoft: 'MSFTc' };
const VIA_V1 = ['web', 'claude', 'chatgpt', 'grok', 'assistant'] as const;
const VIA_WORDS_V1: Readonly<Record<(typeof VIA_V1)[number], string | null>> = {
  web: null, claude: 'Done in Claude', chatgpt: 'Done in ChatGPT', grok: 'Done in Grok', assistant: 'Done in a connected app',
};
// `assistant` is any other client connected over MCP, a script included, so neither its label nor the counter
// says "AI" (audit 11-20 LOOP-6). And "Done in Claude" is its owner's own word (lib/mcpClientKind.ts).

/**
 * Each brand's mark: Coinbase's own icon for the stock a Loop pledges (AAPLc for Apple), the one the Stocks list
 * shows, served from this origin. No mark of our own drawing, and the foot still says "not affiliated"
 * (2026-11-20: the operator asked for the companies' logos on /loops).
 */
export const LOOP_LOGO_V1: Readonly<Record<BrandV1, string>> = Object.fromEntries(LOOP_BRANDS_V1.map((row) => {
  const token = STOCKS.find((stock) => stock.id === row.collateral)?.token.toLowerCase();
  return [row.brand, token ? `/api/public/stocks/icons/${token}.png` : ''];
})) as Record<BrandV1, string>;

/** A brand's mark, or its initial when the icon cannot be had. It sits beside the brand's name, so its alt is empty. */
function LoopLogoV1({ brand, size }: { brand: BrandV1; size: number }) {
  const [failed, setFailed] = useState(false);
  const src = LOOP_LOGO_V1[brand];
  return failed || !src
    ? <span className="still-loops-logo is-letter" style={{ width: size, height: size }} aria-hidden="true">{LOOP_BRAND_WORDS_V1[brand].name.slice(0, 1)}</span>
    : <img className="still-loops-logo" src={src} alt="" width={size} height={size} decoding="async" onError={() => setFailed(true)} />;
}

/** "19 h 26 min", "6 d 4 h", "12 min": how long until `at`, by the page's own clock; null once it has passed. */
export function stillLoopCountdownV1(at: string, now: string): string | null {
  const ms = Date.parse(at) - Date.parse(now);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.ceil(ms / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  return days > 0 ? `${days} d ${hours} h` : hours > 0 ? `${hours} h ${rest} min` : `${rest} min`;
}

export interface StillLoopsWallItemV1 {
  loopNo: number; brand: BrandV1; productName: string; packageLabel: string; priceUsdc: string; venueName: string;
  via: (typeof VIA_V1)[number]; day: string; label: string | null;
}
export interface StillLoopDrawViewV1 {
  drawId: string;
  opensAt: string;
  closesAt: string;
  /** How many entries win, each `prizeUsdc`. */
  winnerCount: number;
  prizeUsdc: string;
  state: 'upcoming' | 'open' | 'closing' | 'drawing' | 'drawn';
  entries: number;
  entriesHash: string | null;
  lockedAt: string | null;
  blockAt: string | null;
  /** The list was fixed more than two minutes after the close, so its block followed the moment it was (absent from
   * servers before 2026-11-20). */
  fixedLate?: boolean;
  block: { number: string; hash: string; time: string } | null;
  /** In the order picked. */
  winners: Array<{ no: number; label: string; paid: boolean }>;
  /** The public authorities that time-stamped the fixed list, by their own clocks. */
  stamps: Array<{ tsa: string; genTime: string }>;
}
export interface StillLoopsViewV1 {
  weekStartsAt: string;
  counts: { total: number; week: number; viaAssistant: number; byBrand: Record<BrandV1, number> };
  wall: StillLoopsWallItemV1[];
  /** Null while the draws are off, or when the server's answer about them could not be read. */
  draws: { current: StillLoopDrawViewV1 | null; past: StillLoopDrawViewV1[] } | null;
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

/** The public answer as the server sends it, or null: a shape it does not send is read as nothing. */
export function stillLoopsViewV1(value: unknown): StillLoopsViewV1 | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const counts = v.counts as Record<string, unknown> | undefined;
  const byBrand = counts?.byBrand as Record<string, unknown> | undefined;
  if (v.outcome !== 'loops' || !text(v.weekStartsAt, 40) || !counts || !count(counts.total) || !count(counts.week) || !count(counts.viaAssistant)
    || !byBrand || !BRANDS_V1.every((brand) => count(byBrand[brand])) || !Array.isArray(v.wall)) return null;
  const wall: StillLoopsWallItemV1[] = [];
  for (const raw of v.wall.slice(0, 100)) {
    const r = raw as Record<string, unknown>;
    if (!r || !Number.isSafeInteger(r.loopNo) || !BRANDS_V1.includes(r.brand as BrandV1) || !text(r.productName, 120) || !text(r.packageLabel, 84)
      || !text(r.priceUsdc, 14) || !text(r.venueName, 40) || !VIA_V1.includes(r.via as (typeof VIA_V1)[number]) || !text(r.day, 10)
      || !(r.label === null || text(r.label, 80))) continue;
    wall.push({ loopNo: r.loopNo as number, brand: r.brand as BrandV1, productName: r.productName, packageLabel: r.packageLabel, priceUsdc: r.priceUsdc,
      venueName: r.venueName, via: r.via as StillLoopsWallItemV1['via'], day: r.day, label: r.label as string | null });
  }
  return { weekStartsAt: v.weekStartsAt, counts: { total: counts.total, week: counts.week, viaAssistant: counts.viaAssistant,
    byBrand: Object.fromEntries(BRANDS_V1.map((brand) => [brand, byBrand[brand] as number])) as Record<BrandV1, number> }, wall,
    draws: stillLoopDrawsViewV1(v.draws) };
}

const DRAW_STATES_V1 = ['upcoming', 'open', 'closing', 'drawing', 'drawn'] as const;
const HASH_V1 = /^0x[0-9a-f]{64}$/;
const iso = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const isoOrNull = (value: unknown): value is string | null => value === null || iso(value);

function drawOfV1(value: unknown): StillLoopDrawViewV1 | null {
  if (!value || typeof value !== 'object') return null;
  const d = value as Record<string, unknown>;
  const block = d.block as Record<string, unknown> | null | undefined;
  const winners = Array.isArray(d.winners) ? d.winners.slice(0, 20).map((raw) => {
    const w = raw as Record<string, unknown> | null;
    return w && Number.isSafeInteger(w.no) && text(w.label, 40) && typeof w.paid === 'boolean' ? { no: w.no as number, label: w.label, paid: w.paid } : null;
  }) : null;
  if (typeof d.drawId !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.drawId) || !iso(d.opensAt) || !iso(d.closesAt) || typeof d.prizeUsdc !== 'string'
    || !/^\d{1,6}$/.test(d.prizeUsdc) || !Number.isSafeInteger(d.winnerCount) || (d.winnerCount as number) < 1 || (d.winnerCount as number) > 20
    || !DRAW_STATES_V1.includes(d.state as StillLoopDrawViewV1['state']) || !count(d.entries)
    || !(d.entriesHash === null || (typeof d.entriesHash === 'string' && HASH_V1.test(d.entriesHash))) || !isoOrNull(d.lockedAt) || !isoOrNull(d.blockAt)
    || !(block === null || (block && typeof block.number === 'string' && /^\d{1,19}$/.test(block.number) && typeof block.hash === 'string'
      && HASH_V1.test(block.hash) && iso(block.time)))
    || !winners || winners.some((w) => w === null)) return null;
  // An older answer had none: no stamp, then.
  const stamps = (Array.isArray(d.stamps) ? d.stamps.slice(0, 4) : []).flatMap((raw) => {
    const t = raw as Record<string, unknown> | null;
    return t && typeof t.tsa === 'string' && /^https?:\/\/[a-z0-9.-]{1,80}/.test(t.tsa) && iso(t.genTime) ? [{ tsa: t.tsa, genTime: t.genTime }] : [];
  });
  return {
    drawId: d.drawId, opensAt: d.opensAt, closesAt: d.closesAt, winnerCount: d.winnerCount as number, prizeUsdc: d.prizeUsdc,
    state: d.state as StillLoopDrawViewV1['state'], entries: d.entries, entriesHash: d.entriesHash as string | null, lockedAt: d.lockedAt, blockAt: d.blockAt,
    block: block ? { number: block.number as string, hash: block.hash as string, time: block.time as string } : null,
    winners: winners as StillLoopDrawViewV1['winners'],
    stamps,
    // Only a true from the server says late; an older answer has none.
    fixedLate: d.fixedLate === true,
  };
}

/** The draws as the server sends them, or null: an answer it cannot read leaves the rest of the page as it is. */
export function stillLoopDrawsViewV1(value: unknown): StillLoopsViewV1['draws'] {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const current = v.current === null ? null : drawOfV1(v.current);
  if ((v.current !== null && current === null) || !Array.isArray(v.past)) return null;
  const past = v.past.slice(0, 20).map(drawOfV1);
  return past.every((draw) => draw !== null) ? { current, past: past as StillLoopDrawViewV1[] } : null;
}

export interface StillLoopDrawMineViewV1 {
  team: boolean;
  current: {
    drawId: string; closesAt: string;
    entry: { label: string; kind: 'loop' | 'free' } | null;
    /** The Loop this wallet may enter with; `ready` false while its card is on its way. */
    loop: { loopNo: number; ready: boolean } | null;
  } | null;
  entered: Array<{ drawId: string; label: string; won: boolean; paid: boolean; prizeUsdc: string }>;
}

/** The session's own entries as the server sends them, or null. */
export function stillLoopDrawMineViewV1(value: unknown): StillLoopDrawMineViewV1 | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const current = v.current as Record<string, unknown> | null | undefined;
  const entryOf = (raw: unknown) => {
    const e = raw as Record<string, unknown> | null | undefined;
    return e && text(e.label, 40) && (e.kind === 'loop' || e.kind === 'free') ? { label: e.label, kind: e.kind as 'loop' | 'free' } : null;
  };
  if (v.outcome !== 'mine' || typeof v.team !== 'boolean' || !Array.isArray(v.entered)) return null;
  if (current !== null && !(current && typeof current.drawId === 'string' && iso(current.closesAt) && (current.entry === null || entryOf(current.entry)))) return null;
  const entered: StillLoopDrawMineViewV1['entered'] = [];
  for (const raw of v.entered.slice(0, 20)) {
    const e = raw as Record<string, unknown>;
    if (e && typeof e.drawId === 'string' && text(e.label, 40) && typeof e.won === 'boolean' && typeof e.paid === 'boolean' && typeof e.prizeUsdc === 'string') {
      entered.push({ drawId: e.drawId, label: e.label, won: e.won, paid: e.paid, prizeUsdc: e.prizeUsdc });
    }
  }
  const loop = current?.loop as Record<string, unknown> | null | undefined;
  const loopOf = loop && Number.isSafeInteger(loop.loopNo) && (loop.loopNo as number) >= 1 && typeof loop.ready === 'boolean'
    ? { loopNo: loop.loopNo as number, ready: loop.ready } : null;
  return { team: v.team, current: current ? { drawId: current.drawId as string, closesAt: current.closesAt as string, entry: entryOf(current.entry),
    loop: loopOf } : null, entered };
}

/** One of the session wallet's own Loops, as GET /api/still/loops/mine sends it. */
export interface StillLoopMineViewV1 extends LendingLoopWireV1 {
  executionId: string;
  productName: string;
  packageLabel: string;
  day: string;
}

const UUID_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNDELIVERED_V1 = ['blocked', 'denied', 'payment_error'] as const;

/** The session wallet's own Loops as the server sends them, or null; a row of another shape is left out. */
export function stillLoopsMineViewV1(value: unknown): StillLoopMineViewV1[] | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || v.outcome !== 'mine' || !Array.isArray(v.loops)) return null;
  const loops: StillLoopMineViewV1[] = [];
  for (const raw of v.loops.slice(0, 20)) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r.executionId !== 'string' || !UUID_V1.test(r.executionId) || !Number.isSafeInteger(r.loopNo) || (r.loopNo as number) < 1
      || !BRANDS_V1.includes(r.brand as BrandV1) || typeof r.complete !== 'boolean' || typeof r.onWall !== 'boolean' || typeof r.team !== 'boolean'
      || !(r.undelivered === null || UNDELIVERED_V1.includes(r.undelivered as (typeof UNDELIVERED_V1)[number]))
      || !text(r.productName, 120) || !text(r.packageLabel, 84) || !text(r.day, 10)) continue;
    loops.push({ executionId: r.executionId, loopNo: r.loopNo as number, brand: r.brand as BrandV1, complete: r.complete, onWall: r.onWall, team: r.team,
      undelivered: r.undelivered as StillLoopMineViewV1['undelivered'], productName: r.productName, packageLabel: r.packageLabel, day: r.day });
  }
  return loops;
}

const WEEKDAYS_V1 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_V1 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Sat 28 Nov, 18:00 UTC": the same words in every browser. */
export function stillLoopDrawTimeV1(value: string): string {
  const d = new Date(value);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${WEEKDAYS_V1[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_V1[d.getUTCMonth()]}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}
/** The same moment by the reader's own clock, as " (21:00 your time)", when that clock is not UTC; else nothing
 * (audit UI-3, 2026-11-20: the draw said its times in UTC only). */
export function stillLoopLocalTimeV1(value: string, offsetMinutes = new Date(value).getTimezoneOffset()): string {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime()) || offsetMinutes === 0) return '';
  const local = new Date(at.getTime() - offsetMinutes * 60_000);
  const two = (n: number) => String(n).padStart(2, '0');
  const sameDay = local.getUTCDate() === at.getUTCDate();
  return ` (${sameDay ? '' : `${WEEKDAYS_V1[local.getUTCDay()]} `}${two(local.getUTCHours())}:${two(local.getUTCMinutes())} your time)`;
}
/** "17 Nov 2026": a Loop's day on the wall, the same in every browser, and never split across two lines
 * (on a phone "2026-11-" and "25" fell on two, 2026-11-19). */
export function stillLoopDayV1(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const month = match ? MONTHS_V1[Number(match[2]) - 1] : undefined;
  return match && month ? `${Number(match[3])}\u00a0${month}\u00a0${match[1]}` : day;
}
const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;
const NUMBER_WORDS_V1 = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
/** "10 USDC" for one winner, "3 × 5 USDC" for more. */
export const stillLoopDrawPrizeV1 = (draw: Pick<StillLoopDrawViewV1, 'winnerCount' | 'prizeUsdc'>): string =>
  draw.winnerCount === 1 ? `${draw.prizeUsdc} USDC` : `${draw.winnerCount} × ${draw.prizeUsdc} USDC`;
/** "One winner, 10 USDC." or "Three winners, 5 USDC each." */
const winnersSentenceV1 = (draw: Pick<StillLoopDrawViewV1, 'winnerCount' | 'prizeUsdc'>): string => draw.winnerCount === 1
  ? `One winner, ${draw.prizeUsdc} USDC.` : `${NUMBER_WORDS_V1[draw.winnerCount - 1] ?? draw.winnerCount} winners, ${draw.prizeUsdc} USDC each.`;

/** What a reader can ask their assistant, word for word. */
export const STILL_LOOP_PROMPT_V1 = 'Use my Apple stock on Still to get me a €25 Apple gift card.';

export interface StillLoopsModelV1 {
  sky: SkyStateV1;
  /** The public answer; null while Loops are off; undefined while it is read. */
  view: StillLoopsViewV1 | null | undefined;
  failed: boolean;
  /** How this person enters the draw open now; absent in a host that offers no entry. */
  entry?: StillLoopDrawEntryModelV1;
  /** The signed-in wallet's own Loops, wherever they were made, each with the wall to put it on; absent signed out. */
  mine?: StillLoopsMineModelV1;
}

export interface StillLoopsMineModelV1 {
  /** Undefined while read, null when they could not be. */
  loops: StillLoopMineViewV1[] | null | undefined;
  /** Puts one on the wall; resolves with the name shown, null for "Loop #N". */
  onWall: (executionId: string, showName: boolean) => Promise<{ label: string | null }>;
  /** Takes one off the wall again (audit MCP-2); absent where the page cannot. */
  offWall?: (executionId: string) => Promise<void>;
}

/** The signed-in wallet's own Loops: one made in an assistant's chat can go on the wall here too (2026-11-19). */
function MineV1({ mine }: { mine: StillLoopsMineModelV1 }) {
  if (!mine.loops || mine.loops.length === 0) return null;
  return (
    <section className="still-section still-loops-mine" aria-labelledby="still-loops-mine">
      <h2 id="still-loops-mine" className="still-more-group-head">Your Loops</h2>
      {mine.loops.map((loop) => (
        <StillLoopOffer key={loop.executionId} model={{ loop, note: false, onWall: (showName) => mine.onWall(loop.executionId, showName),
          ...(mine.offWall ? { offWall: () => mine.offWall!(loop.executionId) } : {}) }} />
      ))}
      <p className="still-note">The wall shows the number, the brand, the card, the price to the dollar and the day: never your wallet or the transaction.</p>
    </section>
  );
}

export interface StillLoopDrawEntryModelV1 {
  signedIn: boolean;
  signInHref: string;
  /** The session's own entries; undefined while read, null when they could not be. */
  mine: StillLoopDrawMineViewV1 | null | undefined;
  /** The entry, the rules accepted: with the wallet's Loop when it has one ready, otherwise free. Resolves with the
   * entry's label; rejects with the server's words. */
  onEnter: () => Promise<{ label: string }>;
}

export const STILL_LOOP_DRAW_VERIFY_URL_V1 = `${MIORAIL_SOURCE_URL_V1}/blob/main/scripts/verify_loop_draw.ts`;
const COINBASE_VERIFY_URL_V1 = 'https://www.coinbase.com/onchain-verify';

/** The tsa's own host, as "timestamp.digicert.com". */
const hostOfV1 = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function EnterV1({ draw, model }: { draw: StillLoopDrawViewV1; model: StillLoopDrawEntryModelV1 | undefined }) {
  const [accepted, setAccepted] = useState(false);
  const [state, setState] = useState<{ kind: 'idle' | 'sending' } | { kind: 'done'; label: string } | { kind: 'failed'; words: string }>({ kind: 'idle' });
  if (!model) return null;
  if (!model.signedIn) return <StillLink href={model.signInHref} className="still-btn sec">Sign in to enter</StillLink>;
  const mine = model.mine;
  if (mine === undefined) return <p className="still-note" role="status">Reading your entry…</p>;
  if (mine?.team) return <p className="still-note">The Still team does not enter its own draws.</p>;
  const current = mine?.current?.drawId === draw.drawId ? mine.current : null;
  const entry = state.kind === 'done' ? { label: state.label } : current?.entry ?? null;
  if (entry) return <p className="still-note" role="status">You are in this draw as {entry.label}. One entry per wallet: there is nothing more to do.</p>;
  const loop = current?.loop ?? null;
  const press = () => {
    setState({ kind: 'sending' });
    model.onEnter().then((answer) => setState({ kind: 'done', label: answer.label }), (error: unknown) => {
      const body = (error as { body?: { detail?: unknown } } | null)?.body;
      setState({ kind: 'failed', words: typeof body?.detail === 'string' && body.detail.length <= 600 ? body.detail : 'The entry could not be made just now. Nothing was entered; try again in a minute.' });
    });
  };
  const withLoop = loop?.ready === true;
  return (
    <div className="still-loop-enter">
      {loop && !loop.ready ? (
        <p className="still-note" role="status">Loop #{loop.loopNo}: Bitrefill has not delivered its card yet. Enter with it once the card arrives, before the close.</p>
      ) : null}
      <StillEligibilityConfirmSlotV1 />
      <label className="still-note still-loop-name">
        <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> I am 18 or older and I accept the rules below
      </label>
      <button type="button" className="still-btn sec" disabled={!accepted || state.kind === 'sending'} onClick={press}>
        {state.kind === 'sending' ? 'Entering…' : withLoop ? `Enter with Loop #${loop!.loopNo}` : 'Enter free'}
      </button>
      {withLoop ? null : (
        <p className="still-note">Free entry needs one of two on this wallet: a swap of at least 10 USDC, to or from USDC, made through Still at any
          time, or Coinbase’s Verified Account attestation
          (<a href={COINBASE_VERIFY_URL_V1} target="_blank" rel="noopener noreferrer">coinbase.com/onchain-verify</a>).</p>
      )}
      {state.kind === 'failed' ? <p className="still-warn" role="status">{state.words}</p> : null}
    </div>
  );
}

function DrawRulesV1({ draw }: { draw: StillLoopDrawViewV1 }) {
  return (
    <details className="still-note still-loop-rules">
      <summary>Rules</summary>
      <ul>
        <li>Two ways in, the same chance, and the same step: enter here before the close. A wallet that made a Loop while the draw is open enters
          with it: Still confirmed its loan after the draw opened, and Bitrefill did not report its card undelivered. Any other wallet enters free,
          with no loan, once it either holds Coinbase’s Verified Account attestation
          (<a href={COINBASE_VERIFY_URL_V1} target="_blank" rel="noopener noreferrer">coinbase.com/onchain-verify</a>), which needs no purchase, or
          made a swap through Still, at any time, in which at least 10 USDC changed hands (Swap AI, or Buy and Sell on Stocks).</li>
        <li>A Loop is a loan against the brand’s stock you chose for it, paying that brand’s card. On Aave one loan stands on every stock
          you pledged there; a Loop is named by the stock chosen for it.</li>
        <li>One entry per wallet per draw.</li>
        <li>Open to people 18 or older who are not U.S. persons, from where Still is offered. The Still team has committed not to enter.</li>
        <li>The list is fixed 30 seconds after the close. Its hash, which also covers the moment it was fixed and the number of winners, is shown
          here, and public time-stamping authorities sign that it existed then.
          {' '}{draw.winnerCount === 1 ? 'The winner is' : 'The first winner is'} entry
          number keccak256(block hash, draw) mod N + 1, where the block is the first Base block at least five and a half minutes after the close.
          {draw.winnerCount === 1 ? '' : ' Each next winner is picked the same way from the entries not yet picked, so nobody wins twice.'} If the list
          could not be fixed within two minutes of the close, the block is the first at least five minutes after it was, and this page says it was
          fixed late. Anybody can check it, the time-stamps too,
          with <a href={STILL_LOOP_DRAW_VERIFY_URL_V1} target="_blank" rel="noopener noreferrer">verify_loop_draw.ts</a>.</li>
        <li>{draw.prizeUsdc} USDC is sent on Base to {draw.winnerCount === 1 ? 'the winning wallet' : 'each winning wallet'} within 7 days. Your entry’s name
          is all the list shows: never your wallet.</li>
        <li>Not sponsored by Coinbase, Base, Bitrefill, DigiCert, Sectigo or any brand on this page.</li>
      </ul>
    </details>
  );
}

function PastDrawV1({ draw, mine }: { draw: StillLoopDrawViewV1; mine: StillLoopDrawMineViewV1 | null | undefined }) {
  const own = mine?.entered.find((row) => row.drawId === draw.drawId);
  const facts = draw.state === 'closing' ? ['closed; the list is being fixed']
    : draw.entries === 0 ? ['nobody entered, so nobody won']
    : [`${draw.entries} ${draw.entries === 1 ? 'entry' : 'entries'}`, draw.entriesHash ? `list ${shortHash(draw.entriesHash)}` : null,
      draw.fixedLate ? 'fixed late, so its block followed the moment it was fixed' : null,
      // A list nobody time-stamped is said so, not left out (audit LOOP-3, 2026-11-20).
      draw.stamps.length > 0 ? `time-stamped by ${draw.stamps.map((stamp) => hostOfV1(stamp.tsa)).join(' and ')}`
        : draw.entriesHash && (draw.block || draw.state === 'drawn') ? 'no time-stamp: when it was fixed rests on Still’s word' : null,
      draw.block ? `Base block ${draw.block.number}` : draw.blockAt ? `picked by the first Base block from ${stillLoopDrawTimeV1(draw.blockAt)}` : null,
      draw.winners.length > 0 ? `won by ${draw.winners.map((w) => `${w.label}${w.paid ? ' (paid)' : ''}`).join(', ')}` : null];
  return (
    <li className="still-row" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div style={{ minWidth: 0 }}>
        <div className="name">Draw of {stillLoopDrawTimeV1(draw.closesAt).replace(/, \d\d:\d\d UTC$/, '')} · {stillLoopDrawPrizeV1(draw)}</div>
        <div className="line still-note" style={{ overflowWrap: 'anywhere' }}>{facts.filter(Boolean).join(' · ')}</div>
        {own ? (
          <div className="line" role="status">
            {own.won ? `You won as ${own.label}. ${own.paid ? `${own.prizeUsdc} USDC was sent to this wallet.` : `${own.prizeUsdc} USDC is sent to this wallet within 7 days.`}`
              : `You were in it as ${own.label}.`}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function StillLoopDrawV1({ draws, entry, now }: { draws: NonNullable<StillLoopsViewV1['draws']>; entry: StillLoopDrawEntryModelV1 | undefined; now: string }) {
  const draw = draws.current;
  const countdown = draw?.state === 'upcoming' ? stillLoopCountdownV1(draw.opensAt, now)
    : draw?.state === 'open' ? stillLoopCountdownV1(draw.closesAt, now) : null;
  return (
    <section className="still-section still-loops-draw" aria-labelledby="still-loops-draw">
      <h2 id="still-loops-draw" className="still-more-group-head">The draw{draw ? ` · ${stillLoopDrawPrizeV1(draw)}` : ''}</h2>
      {draw ? (
        <>
          {/* The prize said large, and the time left to the next step by the page's own clock (2026-11-20). */}
          <div className="still-loops-prize">
            <div className="still-loops-prize-top">
              <span className="still-loops-prize-amount">{stillLoopDrawPrizeV1(draw)}</span>
              {countdown ? <span className="still-loops-countdown">{draw.state === 'upcoming' ? 'Opens in' : 'Closes in'} {countdown}</span> : null}
            </div>
            <p className="still-note">
              {draw.state === 'upcoming'
                ? `Opens ${stillLoopDrawTimeV1(draw.opensAt)}${stillLoopLocalTimeV1(draw.opensAt)}; closes ${stillLoopDrawTimeV1(draw.closesAt)}${stillLoopLocalTimeV1(draw.closesAt)}.`
                : `Closes ${stillLoopDrawTimeV1(draw.closesAt)}${stillLoopLocalTimeV1(draw.closesAt)}. ${draw.entries} ${draw.entries === 1 ? 'entry' : 'entries'} so far.`}
              {' '}{winnersSentenceV1(draw)}
            </p>
          </div>
          {/* The free way first: the draw is never a reason to borrow. */}
          <ul className="still-loops-ways">
            <li className="still-loops-way">
              <span className="still-extra-icon"><StillIconV1 name="giftcard" /></span>
              <div className="name">Enter free</div>
              <div className="line">No loan: the same chance as a Loop.</div>
              {/* Said before the draw opens too, so a wallet can be ready in time. Coinbase stays one of the two (2026-11-20). */}
              <div className="line">Your wallet needs one of two: Coinbase’s Verified Account attestation, which needs no purchase
                (<a href={COINBASE_VERIFY_URL_V1} target="_blank" rel="noopener noreferrer">coinbase.com/onchain-verify</a>), or a swap of at least
                10 USDC, to or from USDC, made through Still at any time (<StillLink href="/routes">Swap AI</StillLink>, or Buy and Sell on Stocks).</div>
            </li>
            <li className="still-loops-way">
              <span className="still-extra-icon"><StillIconV1 name="spend" /></span>
              <div className="name">Make a Loop</div>
              <div className="line">A Loop made while the draw is open lets you enter with it, with no other check.</div>
              <StillLink href="/spend" className="still-btn sec" aria-label="Spend: pick a card to make a Loop">Spend</StillLink>
            </li>
          </ul>
          <div className="still-loops-enter">
            {draw.state === 'open' ? <EnterV1 draw={draw} model={entry} />
              : <p className="still-note">{draw.state === 'upcoming' ? 'Entry opens with the draw.' : 'Entry is closed.'}</p>}
          </div>
          <DrawRulesV1 draw={draw} />
        </>
      ) : (
        <p className="still-note">No draw is open now.</p>
      )}
      {draws.past.length > 0 ? (
        <ul className="still-rows" aria-label="Past draws">
          {draws.past.map((past) => <PastDrawV1 key={past.drawId} draw={past} mine={entry?.mine} />)}
        </ul>
      ) : null}
    </section>
  );
}

function CopyPromptV1() {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <div className="still-copy">
      <span className="v">{STILL_LOOP_PROMPT_V1}</span>
      <button type="button" aria-label="Copy the request" onClick={() => {
        const write = globalThis.navigator?.clipboard?.writeText(STILL_LOOP_PROMPT_V1);
        if (!write) return setState('failed');
        void write.then(() => setState('done'), () => setState('failed'));
      }}>{state === 'done' ? 'Copied' : state === 'failed' ? 'Select and copy' : 'Copy'}</button>
    </div>
  );
}

export function StillLoops({ model }: { model: StillLoopsModelV1 }) {
  const view = model.view;
  return (
    <div className="still-loops-page">
      <StillHeader title={STILL_LOOPS_V1.label} sky={model.sky}
        lede="Borrow against a company’s stock, get that company’s card, keep the stock." />
      {model.failed ? (
        <p className="still-section still-warn" role="status">The Loops could not be read just now. This is our failure, not a fact about them.</p>
      ) : view === undefined ? (
        <p className="still-section still-note" role="status">Reading the Loops…</p>
      ) : view === null ? (
        <p className="still-section still-note" role="status">Loops are not open yet.</p>
      ) : (
        <>
          {/* Three zeros read as nobody coming (2026-11-19): before the first Loop, its number as a ticket still to
              claim, with the five companies' marks. */}
          {view.counts.total === 0 ? (
            <div className="still-section still-loops-hero" aria-label="Loops so far">
              <div className="still-loops-ticket">
                <div className="still-loops-ticket-no"><span className="n">#1</span><span className="t">still unclaimed: no Loop has been made yet</span></div>
                <div className="still-loops-logos">{BRANDS_V1.map((brand) => <LoopLogoV1 key={brand} brand={brand} size={40} />)}</div>
              </div>
            </div>
          ) : (
            <div className="still-section still-loops-hero" aria-label="Loops so far">
              <div className="still-safety-figures">
                <div className="still-safety-figure"><span className="n">{view.counts.week}</span><span className="t">this week</span></div>
                <div className="still-safety-figure"><span className="n">{view.counts.total}</span><span className="t">in all</span></div>
                <div className="still-safety-figure"><span className="n">{view.counts.viaAssistant}</span><span className="t">done in a connected app</span></div>
              </div>
            </div>
          )}
          {model.mine ? <MineV1 mine={model.mine} /> : null}
          {view.draws ? <StillLoopDrawV1 draws={view.draws} entry={model.entry} now={model.sky.at} /> : null}
          <section className="still-section still-loops-how" aria-labelledby="still-loops-how">
            <h2 id="still-loops-how" className="still-more-group-head">How a Loop is made</h2>
            <ol className="still-loops-steps">
              <li><span className="n" aria-hidden="true">1</span><span>Pick a card from a company whose stock you hold.</span></li>
              <li><span className="n" aria-hidden="true">2</span><span>A USDC loan against that stock pays for it. Your wallet signs.</span></li>
              <li><span className="n" aria-hidden="true">3</span><span>The card arrives, and the stock stays as the loan’s collateral until you repay.</span></li>
            </ol>
            <ul className="still-loops-brands">
              {BRANDS_V1.map((brand) => {
                const made = view.counts.byBrand[brand];
                return (
                  <li key={brand} className="still-loops-brand">
                    <LoopLogoV1 brand={brand} size={44} />
                    <div className="still-loops-brand-text">
                      <div className="name">{LOOP_BRAND_WORDS_V1[brand].name}</div>
                      <div className="line">{LOOP_BRAND_WORDS_V1[brand].article} {LOOP_BRAND_WORDS_V1[brand].card}, paid by a loan against {COLLATERAL_V1[brand]}</div>
                      {made > 0 ? <div className="line still-loops-made">{made} {made === 1 ? 'Loop' : 'Loops'} so far</div> : null}
                    </div>
                    {/* Six links named "Spend" were one name to a screen reader (audit UI-5): each says its card. */}
                    <StillLink href={stillLoopSpendHrefV1(brand)} className="still-btn sec" aria-label={`Spend: ${LOOP_BRAND_WORDS_V1[brand].article} ${LOOP_BRAND_WORDS_V1[brand].card}`}>Spend</StillLink>
                  </li>
                );
              })}
            </ul>
            <p className="still-note">Or ask your assistant with Still connected, in its own words or in these:</p>
            <CopyPromptV1 />
            <p className="still-note"><StillLink href="/assistants">Connect Still to Claude, ChatGPT, Grok, Cursor or Codex</StillLink></p>
          </section>
          <section className="still-section still-loops-wall-part" aria-labelledby="still-loops-wall">
            <h2 id="still-loops-wall" className="still-more-group-head">The wall</h2>
            {view.wall.length === 0 ? (
              <div className="still-loops-wall-empty">
                <span className="still-extra-icon"><StillIconV1 name="giftcard" /></span>
                <p className="still-note">No Loop is on the wall yet. A Loop goes on it only when its owner puts it there.</p>
              </div>
            ) : (
              <ul className="still-loops-wall">
                {view.wall.map((item) => (
                  <li key={item.loopNo} className="still-loops-tile">
                    <div className="still-loops-tile-head">
                      <LoopLogoV1 brand={item.brand} size={36} />
                      <div className="name">Loop #{item.loopNo}{item.label ? ` · ${item.label}` : ''}</div>
                    </div>
                    <div className="line">{LOOP_BRAND_WORDS_V1[item.brand].name} stock stayed. {item.productName} ({item.packageLabel}) arrived.</div>
                    <div className="line still-note">{[`about $${item.priceUsdc}`, item.venueName, VIA_WORDS_V1[item.via], stillLoopDayV1(item.day)].filter(Boolean).join(' · ')}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <div className="still-section still-borrow-foot">
        <p className="still-note">
          Loans have interest and can be liquidated if prices fall: see the rate and the limits before you sign. Still is not a lender, and the wall names
          no wallet and no transaction. Not offered to US persons. Not affiliated with Apple, Amazon, Google, Meta or Microsoft. Still is a Bitrefill
          affiliate: Bitrefill may pay Still a commission, which does not change your price.
        </p>
        <StillLink href="/safety">How Still keeps a loan safe</StillLink>
      </div>
    </div>
  );
}
