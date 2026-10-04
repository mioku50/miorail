import type { ReopenSharedResultV1 } from '@mioagent/rwa-market-reality/reopen-game-service';
import { etWeekdayV1 } from '@mioagent/rwa-market-reality/weekend-market';

// ---------------------------------------------------------------------------
// The picture under a shared Call the reopen result.
//
// A player who posts their round links to a code, and the code names a row:
// the round as it was frozen and the picks copied when the code was made.
// Every number here comes from that row, never from the address. The picture
// says how each call went and what Base called; it never says who played.
//
// Up and down carry no colour: a triangle says which way. Only right and wrong
// do, the squares a player already knows from the share line. Everything that
// must be read sits above the bottom-left corner, which X covers with the
// link's own label.
// ---------------------------------------------------------------------------

export const REOPEN_CARD_WIDTH_V1 = 1200;
export const REOPEN_CARD_HEIGHT_V1 = 630;

type DirectionV1 = 'up' | 'down';

export interface ReopenCardRowV1 {
  symbol: string;
  pick: DirectionV1 | null;
  baseCall: DirectionV1 | null;
  /** "$191.20", or null with no reopen print. */
  reopen: string | null;
  outcome: DirectionV1 | 'void';
  mark: 'right' | 'wrong' | 'none';
}

export interface ReopenCardV1 {
  /** "Call the reopen #3 · Fri Oct 9 close": drawn at the top. */
  kicker: string;
  badge: string;
  title: string;
  lede: string;
  columns: readonly [string, string, string, string];
  rows: ReopenCardRowV1[];
  footer: string;
  /** For the page head. */
  pageTitle: string;
  description: string;
  alt: string;
}

function usdV1(value: string): string {
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "Fri Oct 9", the New York date of the close. */
function closeDateV1(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('weekday')} ${value('month')} ${value('day')}`;
}

const WORD_V1: Readonly<Record<DirectionV1, string>> = { up: 'up', down: 'down' };

export function reopenCardV1(result: ReopenSharedResultV1): ReopenCardV1 {
  const { mine, base } = result;
  // The quiet period opens at 20:00 ET on the day of its close.
  const day = etWeekdayV1(result.opensAt);
  const rows = result.stocks.map((stock): ReopenCardRowV1 => {
    const outcome = stock.outcome;
    return {
      symbol: stock.symbol.length > 10 ? `${stock.symbol.slice(0, 9)}…` : stock.symbol,
      pick: stock.pick,
      baseCall: stock.baseCall,
      reopen: stock.reopen ? usdV1(stock.reopen) : null,
      outcome,
      mark: outcome === 'void' || stock.pick === null ? 'none' : stock.pick === outcome ? 'right' : 'wrong',
    };
  });
  const baseCalled = `${base.correct} of ${base.of} from its own price on Base at the lock`;
  const lede =
    mine.correct > base.correct
      ? `Beat Base, which called ${baseCalled}.`
      : mine.correct === base.correct
        ? `Level with Base, which called ${baseCalled}.`
        : `Base called ${baseCalled}.`;
  const story = rows
    .map((row) => {
      const called = row.pick ? `called ${WORD_V1[row.pick]}` : 'no call';
      const reopened = row.outcome === 'void' ? (row.reopen ? 'reopened at the close' : 'no reopen print') : `reopened ${WORD_V1[row.outcome]}`;
      return `${row.symbol} ${called}, ${reopened}`;
    })
    .join('; ');
  return {
    kicker: `Call the reopen #${result.number} · ${closeDateV1(result.closeAt)} close`,
    badge: 'Result',
    title: `${mine.correct} of ${mine.of} right`,
    lede,
    columns: ['Stock', 'Called', 'Base', `Reopened vs ${day}`],
    rows,
    footer: 'one round every weekend · miorail.xyz/stocks/weekend',
    pageTitle: `Call the reopen #${result.number}: ${mine.correct}/${mine.of}, Base ${base.correct}/${base.of} · Miorail`,
    description: `${mine.correct} of ${mine.of} right in Call the reopen #${result.number}, against Base's ${base.correct} of ${base.of}. Each weekend: will five stocks reopen above or below ${day}'s close? Base makes its own call from its price on Base. No wallet needed to play.`,
    alt: `Call the reopen #${result.number}, ${closeDateV1(result.closeAt)} close: ${story}. ${mine.correct} of ${mine.of} right; Base ${base.correct} of ${base.of}.`,
  };
}

// ---------------------------------------------------------------------------
// The drawing.
// ---------------------------------------------------------------------------

function escapeXmlV1(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const INK_V1 = { page: '#0b0b10', text: '#f3f4f6', soft: '#a4a7b5', faint: '#6f7285', rule: '#1f2130', brand: '#8fa2ff' };
/** Right and wrong, and nothing else, carry a colour. */
const MARK_V1 = { right: '#2ea043', wrong: '#da3633', none: '#2c2f45' } as const;
const SANS_V1 = 'Inter';
const MONO_V1 = 'JetBrains Mono';

function textV1(
  x: number,
  y: number,
  content: string,
  style: { font: string; size: number; fill: string; weight?: number; anchor?: 'start' | 'end'; spacing?: number },
): string {
  const attributes = [
    `x="${x}"`,
    `y="${y}"`,
    `font-family="${style.font}"`,
    `font-size="${style.size}"`,
    style.weight ? `font-weight="${style.weight}"` : null,
    style.anchor === 'end' ? 'text-anchor="end"' : null,
    style.spacing ? `letter-spacing="${style.spacing}"` : null,
    `fill="${style.fill}"`,
  ].filter((part): part is string => part !== null);
  return `<text ${attributes.join(' ')}>${escapeXmlV1(content)}</text>`;
}

/** A triangle, drawn rather than typed: the board's fonts need not carry one. */
function arrowV1(x: number, baseline: number, side: DirectionV1, fill: string): string {
  const top = baseline - 22;
  const bottom = baseline - 4;
  return side === 'up'
    ? `<path d="M${x} ${bottom} L${x + 10} ${top} L${x + 20} ${bottom} Z" fill="${fill}"/>`
    : `<path d="M${x} ${top} L${x + 10} ${bottom} L${x + 20} ${top} Z" fill="${fill}"/>`;
}

/** The pill's width, from the character count: the badge is a fixed word. */
function badgeV1(label: string, right: number, top: number): string {
  const width = Math.round(label.length * 10.4 + 58);
  const x = right - width;
  return [
    `<rect x="${x}" y="${top}" width="${width}" height="42" rx="21" fill="#14151f" stroke="#2c2f45" stroke-width="1.5"/>`,
    `<circle cx="${x + 24}" cy="${top + 21}" r="5" fill="url(#accent)"/>`,
    textV1(x + 40, top + 28, label, { font: SANS_V1, size: 19, fill: '#c9cbe0', weight: 600 }),
  ].join('');
}

export function reopenCardSvgV1(card: ReopenCardV1): string {
  const W = REOPEN_CARD_WIDTH_V1;
  const H = REOPEN_CARD_HEIGHT_V1;
  const left = 72;
  const right = W - 72;
  const header = 270;
  const firstRow = 324;
  const step = 54;
  // Where each column starts: the call, Base's call, the reopen.
  const cols = [300, 520, 720] as const;

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    '<defs>',
    '<radialGradient id="glow" cx="0.82" cy="0.08" r="0.62"><stop offset="0" stop-color="#262a48" stop-opacity="0.95"/><stop offset="1" stop-color="#0b0b10" stop-opacity="0"/></radialGradient>',
    '<linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6d8dff"/><stop offset="1" stop-color="#a77bff"/></linearGradient>',
    '</defs>',
    `<rect width="${W}" height="${H}" fill="${INK_V1.page}"/>`,
    `<rect width="${W}" height="${H}" fill="url(#glow)"/>`,
    textV1(left, 88, 'MIORAIL', { font: MONO_V1, size: 20, fill: INK_V1.brand, spacing: 6 }),
    textV1(left + 150, 88, card.kicker, { font: MONO_V1, size: 20, fill: INK_V1.soft }),
    badgeV1(card.badge, right, 58),
    textV1(left, 158, card.title, { font: SANS_V1, size: 58, weight: 600, fill: INK_V1.text }),
    textV1(left, 206, card.lede, { font: SANS_V1, size: 24, fill: INK_V1.soft }),
  ];

  const head = { font: MONO_V1, size: 15, fill: INK_V1.faint, spacing: 1.5 };
  out.push(textV1(left, header, card.columns[0].toUpperCase(), head));
  out.push(textV1(cols[0], header, card.columns[1].toUpperCase(), head));
  out.push(textV1(cols[1], header, card.columns[2].toUpperCase(), head));
  out.push(textV1(cols[2], header, card.columns[3].toUpperCase(), head));
  out.push(`<rect x="${left}" y="${header + 16}" width="${right - left}" height="1" fill="${INK_V1.rule}"/>`);

  card.rows.forEach((row, index) => {
    const y = firstRow + index * step;
    out.push(textV1(left, y, row.symbol, { font: MONO_V1, size: 30, weight: 600, fill: INK_V1.text }));
    if (row.pick) {
      out.push(arrowV1(cols[0], y, row.pick, INK_V1.text));
      out.push(textV1(cols[0] + 32, y, row.pick === 'up' ? 'above' : 'below', { font: SANS_V1, size: 26, fill: INK_V1.text }));
    } else {
      out.push(textV1(cols[0], y, 'no call', { font: SANS_V1, size: 24, fill: INK_V1.faint }));
    }
    if (row.baseCall) {
      out.push(arrowV1(cols[1], y, row.baseCall, INK_V1.soft));
      out.push(textV1(cols[1] + 32, y, row.baseCall === 'up' ? 'above' : 'below', { font: SANS_V1, size: 24, fill: INK_V1.soft }));
    } else {
      out.push(textV1(cols[1], y, 'no call', { font: SANS_V1, size: 24, fill: INK_V1.faint }));
    }
    if (row.outcome !== 'void' && row.reopen) {
      out.push(arrowV1(cols[2], y, row.outcome, 'url(#accent)'));
      out.push(textV1(cols[2] + 32, y, row.reopen, { font: MONO_V1, size: 26, weight: 600, fill: INK_V1.text }));
    } else {
      out.push(textV1(cols[2], y, row.reopen ? `${row.reopen} · at the close` : 'no reopen print', { font: SANS_V1, size: 22, fill: INK_V1.faint }));
    }
    out.push(`<rect x="${right - 30}" y="${y - 25}" width="30" height="30" rx="6" fill="${MARK_V1[row.mark]}"/>`);
    if (index < card.rows.length - 1) {
      out.push(`<rect x="${left}" y="${y + 20}" width="${right - left}" height="1" fill="${INK_V1.rule}"/>`);
    }
  });

  out.push(textV1(right, 598, card.footer, { font: MONO_V1, size: 18, fill: INK_V1.faint, anchor: 'end' }));
  out.push('</svg>');
  return out.join('');
}
