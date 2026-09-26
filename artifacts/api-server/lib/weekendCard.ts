import {
  WEEKEND_MEANINGFUL_GAP_BPS_V1,
  WEEKEND_MEDIAN_WINDOW_HOURS_V1,
  type WeekendMarketResponseV1,
} from '@mioagent/rwa-market-reality/weekend-market';

// ---------------------------------------------------------------------------
// The picture under a shared weekend post.
//
// X, Farcaster and Telegram show a link as the image its page names, and run
// no script, so the board itself never reaches a feed. This draws the board as
// the post saw it: the slot the link names, recomputed. The clock goes into
// the picture with the numbers, because a post is read for days.
//
// It says what the board says and nothing more: where the tokens traded
// against Friday's close, and once the feed printed again, where it reopened
// and which side Base had been on. No colour says good or bad. A sign and a
// bar say which way.
// ---------------------------------------------------------------------------

export const WEEKEND_CARD_WIDTH_V1 = 1200;
export const WEEKEND_CARD_HEIGHT_V1 = 630;
const MAX_ROWS_V1 = 5;
const MINUS = '−';

export interface WeekendCardRowV1 {
  symbol: string;
  close: string;
  /** In progress: the price on Base. Reopened: Base's move before the reopen. */
  base: string;
  /** In progress: the move against Friday's close. Reopened: the reopen's gap. */
  last: string;
  bps: number;
  /** Reopened only: which side of Friday's close Base had been on. */
  side: string | null;
}

export interface WeekendCardV1 {
  state: 'in_progress' | 'reopened';
  title: string;
  badge: string;
  lede: string;
  /** "Sat 03:40 ET": when the numbers were measured. Drawn at the top, where
   * no feed lays its own label over the picture. */
  asOf: string;
  columns: readonly [string, string, string, string];
  rows: WeekendCardRowV1[];
  /** How the numbers were made, and where to read them all. Right-aligned:
   * X covers the bottom-left corner with the link's own label. */
  footer: string;
  /** For the page's description: the post's numbers, with their clock. */
  description: string;
  /** For the image's alt text. */
  alt: string;
}

function usdV1(value: string): string {
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedPercentV1(bps: number): string {
  const percent = (Math.abs(bps) / 100).toFixed(2);
  return bps > 0 ? `+${percent}%` : bps < 0 ? `${MINUS}${percent}%` : `${percent}%`;
}

/** "Sat 03:40 ET", as the board writes a time. */
function etLabelV1(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('weekday')} ${value('hour')}:${value('minute')} ET`;
}

function symbolV1(symbol: string): string {
  return symbol.length > 10 ? `${symbol.slice(0, 9)}…` : symbol;
}

/** "5 of 10 stocks · " when the picture leaves some out, and nothing when not. */
function shownV1(shown: number, of: number): string {
  return shown < of ? `${shown} of ${of} stocks · ` : '';
}

/** Null when there is nothing to draw: outside a quiet period, or before a
 * single stock has a reading. */
export function weekendCardV1(response: WeekendMarketResponseV1): WeekendCardV1 | null {
  if (response.state === 'none' || !response.window) return null;
  const asOf = etLabelV1(response.generatedAt);

  if (response.state === 'in_progress') {
    const measured = response.stocks.filter((stock) => stock.base !== null && stock.close !== null);
    if (measured.length === 0) return null;
    const rows = measured.slice(0, MAX_ROWS_V1).map((stock) => ({
      symbol: symbolV1(stock.symbol),
      close: usdV1(stock.close!),
      base: usdV1(stock.base!.value),
      last: signedPercentV1(stock.base!.moveBps),
      bps: stock.base!.moveBps,
      side: null,
    }));
    const moves = (count: number) =>
      rows
        .slice(0, count)
        .map((row) => `${row.symbol} ${row.last}`)
        .join(', ');
    return {
      state: 'in_progress',
      title: 'The weekend on Base',
      badge: 'Wall Street closed',
      lede: `Wall Street is closed until ${etLabelV1(response.window.expectedReopenAt)}. These tokens keep trading on Base.`,
      asOf,
      columns: ['Stock', 'Friday close', 'On Base', 'vs Friday'],
      rows,
      footer: `${shownV1(rows.length, measured.length)}median of $100 quotes, last ${WEEKEND_MEDIAN_WINDOW_HOURS_V1} h · miorail.xyz/stocks`,
      description: `Wall Street is closed, and tokenized stocks on Base keep trading. As of ${asOf}: ${moves(3)} against Friday's close, the median of Miorail's $100 quotes over the last ${WEEKEND_MEDIAN_WINDOW_HOURS_V1} hours.`,
      alt: `The weekend on Base, as of ${asOf}. Against Friday's close: ${moves(rows.length)}.`,
    };
  }

  const printed = response.stocks.filter((stock) => stock.reopen !== null && stock.close !== null);
  if (printed.length === 0) return null;
  const rows = printed.slice(0, MAX_ROWS_V1).map((stock) => ({
    symbol: symbolV1(stock.symbol),
    close: usdV1(stock.close!),
    base: stock.base ? signedPercentV1(stock.base.moveBps) : '—',
    last: signedPercentV1(stock.reopen!.gapBps),
    bps: stock.reopen!.gapBps,
    side:
      stock.reopen!.sameDirection === true
        ? 'same side'
        : stock.reopen!.sameDirection === false
          ? 'other side'
          : 'no clear gap',
  }));
  const called = response.called && response.called.meaningful > 0 ? response.called : null;
  const threshold = signedPercentV1(WEEKEND_MEANINGFUL_GAP_BPS_V1).replace('+', '');
  return {
    state: 'reopened',
    title: 'The weekend on Base',
    badge: 'Reopened',
    lede: called
      ? `Base had been on the reopen's side of Friday's close for ${called.sameDirection} of ${called.meaningful}.`
      : "No stock reopened with a clear gap from Friday's close.",
    asOf,
    columns: ['Stock', 'Friday close', 'Base before', 'Reopened'],
    rows,
    footer: `${shownV1(rows.length, printed.length)}a gap under ${threshold} has no side · miorail.xyz/stocks`,
    description: called
      ? `The weekend on Base: before Wall Street reopened, tokenized stocks on Base were on the same side of Friday's close as the reopen for ${called.sameDirection} of ${called.meaningful} with a clear gap. One weekend, not a track record.`
      : 'The weekend on Base, measured: where tokenized stocks traded while Wall Street was closed, and where they reopened.',
    alt: `The weekend on Base and the reopen, as of ${asOf}: ${rows
      .map((row) => `${row.symbol} ${row.base} on Base before, reopened ${row.last}, ${row.side}`)
      .join('; ')}.`,
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

/** The pill's width, from the character count: the two badges are fixed
 * words, so an estimate that fits both is enough. */
function badgeV1(label: string, right: number, top: number): string {
  const width = Math.round(label.length * 10.4 + 58);
  const x = right - width;
  return [
    `<rect x="${x}" y="${top}" width="${width}" height="42" rx="21" fill="#14151f" stroke="#2c2f45" stroke-width="1.5"/>`,
    `<circle cx="${x + 24}" cy="${top + 21}" r="5" fill="url(#accent)"/>`,
    textV1(x + 40, top + 28, label, { font: SANS_V1, size: 19, fill: '#c9cbe0', weight: 600 }),
  ].join('');
}

export function weekendCardSvgV1(card: WeekendCardV1): string {
  const W = WEEKEND_CARD_WIDTH_V1;
  const H = WEEKEND_CARD_HEIGHT_V1;
  const left = 72;
  const right = W - 72;
  const header = 270;
  const firstRow = 324;
  const step = 54;
  const reopened = card.state === 'reopened';
  // Right edges of the three number columns, and where the fourth begins.
  const cols = reopened ? [436, 646, 856, 900] : [480, 730, 915, 950];

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    '<defs>',
    '<radialGradient id="glow" cx="0.82" cy="0.08" r="0.62"><stop offset="0" stop-color="#262a48" stop-opacity="0.95"/><stop offset="1" stop-color="#0b0b10" stop-opacity="0"/></radialGradient>',
    '<linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6d8dff"/><stop offset="1" stop-color="#a77bff"/></linearGradient>',
    '</defs>',
    `<rect width="${W}" height="${H}" fill="${INK_V1.page}"/>`,
    `<rect width="${W}" height="${H}" fill="url(#glow)"/>`,
    textV1(left, 88, 'MIORAIL', { font: MONO_V1, size: 20, fill: INK_V1.brand, spacing: 6 }),
    textV1(left + 150, 88, `as of ${card.asOf}`, { font: MONO_V1, size: 20, fill: INK_V1.soft }),
    badgeV1(card.badge, right, 58),
    textV1(left, 158, card.title, { font: SANS_V1, size: 58, weight: 600, fill: INK_V1.text }),
    textV1(left, 206, card.lede, { font: SANS_V1, size: 24, fill: INK_V1.soft }),
  ];

  const head = { font: MONO_V1, size: 15, fill: INK_V1.faint, spacing: 1.5 };
  out.push(textV1(left, header, card.columns[0].toUpperCase(), head));
  out.push(textV1(cols[0]!, header, card.columns[1].toUpperCase(), { ...head, anchor: 'end' }));
  out.push(textV1(cols[1]!, header, card.columns[2].toUpperCase(), { ...head, anchor: 'end' }));
  out.push(textV1(cols[2]!, header, card.columns[3].toUpperCase(), { ...head, anchor: 'end' }));
  if (reopened) out.push(textV1(cols[3]!, header, "BASE'S SIDE", head));
  out.push(`<rect x="${left}" y="${header + 16}" width="${right - left}" height="1" fill="${INK_V1.rule}"/>`);

  // The bars share one scale, so their lengths compare; a scale no smaller
  // than half a percent keeps a quiet weekend from looking like a loud one.
  const scale = Math.max(50, ...card.rows.map((row) => Math.abs(row.bps)));
  const barLeft = cols[3]!;
  const middle = Math.round((barLeft + right) / 2);
  const half = right - middle;
  if (!reopened && card.rows.length > 0) {
    out.push(
      `<rect x="${middle}" y="${firstRow - 30}" width="1.5" height="${(card.rows.length - 1) * step + 42}" fill="#2c2f45"/>`,
    );
  }

  card.rows.forEach((row, index) => {
    const y = firstRow + index * step;
    out.push(textV1(left, y, row.symbol, { font: MONO_V1, size: 30, weight: 600, fill: INK_V1.text }));
    out.push(textV1(cols[0]!, y, row.close, { font: MONO_V1, size: 26, fill: INK_V1.soft, anchor: 'end' }));
    if (reopened) {
      out.push(textV1(cols[1]!, y, row.base, { font: MONO_V1, size: 26, fill: INK_V1.text, anchor: 'end' }));
      out.push(textV1(cols[2]!, y, row.last, { font: MONO_V1, size: 28, weight: 600, fill: 'url(#accent)', anchor: 'end' }));
      out.push(textV1(cols[3]!, y, row.side ?? '', { font: SANS_V1, size: 22, fill: INK_V1.soft }));
    } else {
      out.push(textV1(cols[1]!, y, row.base, { font: MONO_V1, size: 26, fill: INK_V1.text, anchor: 'end' }));
      out.push(textV1(cols[2]!, y, row.last, { font: MONO_V1, size: 28, weight: 600, fill: 'url(#accent)', anchor: 'end' }));
      const length = row.bps === 0 ? 0 : Math.max(3, Math.round((Math.abs(row.bps) / scale) * half));
      if (length > 0) {
        const x = row.bps < 0 ? middle - length : middle + 1.5;
        out.push(`<rect x="${x}" y="${y - 19}" width="${length}" height="16" rx="3" fill="url(#accent)"/>`);
      }
    }
    if (index < card.rows.length - 1) {
      out.push(`<rect x="${left}" y="${y + 20}" width="${right - left}" height="1" fill="${INK_V1.rule}"/>`);
    }
  });

  out.push(textV1(right, 598, card.footer, { font: MONO_V1, size: 18, fill: INK_V1.faint, anchor: 'end' }));
  out.push('</svg>');
  return out.join('');
}
