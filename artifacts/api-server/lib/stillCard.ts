import type { MirrorReport } from '@mioagent/still-engine/report';
import { formatCents } from '@mioagent/still-engine/format';

import { homeViewV1, type MobileInputV1 } from '../../../lib/ui/src/still/homeView.js';
import { mobileLayoutV1 } from '../../../lib/ui/src/still/mobileLayout.js';
import { skyStateV1 } from '../../../lib/ui/src/still/skyState.js';
import { stillSpendShareWordsV1, type StillLoanShareV1, type StillSpendShareV1 } from './stillSpendShare.js';

// ---------------------------------------------------------------------------
// Still's pictures for a shared link: X and link previews take 1200 x 630,
// a Farcaster cast takes 3:2. Drawn from the same mobile layout as Home
// (lib/ui/src/still/mobileLayout.ts), so a shared wallet hangs the way its
// page does. The sky is the brand's dusk without a sun, a moon or the hours:
// a picture that stays in a feed for days must not claim a time of day.
// ---------------------------------------------------------------------------

export type StillCardShapeV1 = 'wide' | 'tall';
export const STILL_CARD_SIZE_V1: Record<StillCardShapeV1, { width: number; height: number }> = {
  wide: { width: 1200, height: 630 },
  tall: { width: 1200, height: 800 },
};

const INK = '#EEF1FF';
const INK2 = '#AEB7E6';
const GROUND = '#0B0F2E';
const STOCK = '#4D86FF';
const CRYPTO_FILL = '#161B4D';
const ALARM = '#D93A3A';
const SANS = 'Jost*, Inter, sans-serif';
const MONO = 'JetBrains Mono, monospace';

const SKYLINE =
  'M0 310 V292 H18 V284 H34 V296 H48 V274 H60 V268 H66 V274 H76 V290 H92 V280 H110 V300 H124 V286 H140 V264 H146 V256 H150 V264 H156 V282 H170 V292 H188 V278 H204 V272 H220 V288 H236 V294 H252 V276 H262 V266 H274 V276 H284 V298 H300 V284 H318 V290 H334 V274 H350 V282 H366 V294 H390 V310 Z';
const WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [51, 280], [56, 287], [143, 268], [147, 275], [98, 288], [213, 282], [257, 281], [266, 276], [338, 283], [342, 290],
];
const STARS: ReadonlyArray<readonly [number, number]> = [[72, 30], [160, 22], [232, 96], [52, 104], [128, 128], [372, 118], [24, 176], [250, 170]];

export function escapeXmlV1(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The dusk sky in the 390 x 310 frame the mobile hangs in. */
function skyV1(): string {
  return [
    '<rect x="0" y="0" width="390" height="150" fill="#27347A"/>',
    '<rect x="0" y="150" width="390" height="82" fill="#6B4F93"/>',
    '<rect x="0" y="232" width="390" height="78" fill="#E8916E"/>',
    ...STARS.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="1.1" fill="#FFFFFF" fill-opacity="0.55"/>`),
    '<path d="M34 124 Q195 -36 356 124" fill="none" stroke="#FFFFFF" stroke-width="1.5" stroke-dasharray="2 7" stroke-opacity="0.22"/>',
    `<path d="${SKYLINE}" fill="#1B1F4A"/>`,
    ...WINDOWS.map(([x, y]) => `<rect x="${x}" y="${y}" width="2" height="3" fill="#FFD166"/>`),
  ].join('');
}

/** The mobile, as StillMobile draws it with the dusk inks, without the motion. */
function mobileV1(input: MobileInputV1): string {
  const layout = mobileLayoutV1(input);
  const parts: string[] = [];
  for (const wire of layout.wires) {
    parts.push(`<line x1="${wire.x1}" y1="${wire.y1}" x2="${wire.x2}" y2="${wire.y2}" stroke="${INK}" stroke-width="${wire.width}" stroke-linecap="round"/>`);
  }
  parts.push(`<circle cx="${layout.pivot.x}" cy="${layout.pivot.y}" r="3.5" fill="${INK}"/>`);
  const tips = input.state === 'act' || input.state === 'liquidation';
  if (layout.limit) {
    parts.push(`<rect x="${layout.limit.x}" y="${layout.limit.y}" width="${layout.limit.side}" height="${layout.limit.side}" fill="none" stroke="${INK}" stroke-width="1.5" stroke-dasharray="4 4"/>`);
  }
  if (layout.loan) {
    parts.push(`<rect x="${layout.loan.x}" y="${layout.loan.y}" width="${layout.loan.side}" height="${layout.loan.side}" fill="${tips ? ALARM : INK}"/>`);
    if (layout.loan.side >= 30) {
      const label = input.loan?.owedLabel ?? formatCents(BigInt(input.loan?.owedCents ?? 0));
      parts.push(`<text x="${layout.loan.x + layout.loan.side / 2}" y="${layout.loan.y + layout.loan.side / 2 + 4}" font-family="${SANS}" font-size="11" font-weight="600" text-anchor="middle" fill="${GROUND}">${escapeXmlV1(label)}</text>`);
    }
  }
  for (const shape of layout.shapes) {
    const fill = shape.kind === 'crypto' ? CRYPTO_FILL : STOCK;
    const stroke = shape.kind === 'crypto' ? ` stroke="${INK}" stroke-width="2"` : '';
    parts.push(`<circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}" fill="${fill}"${stroke}/>`);
    const size = shape.labelInside ? Math.max(8, Math.min(13, shape.r * 0.4)) : 10;
    const y = shape.labelInside ? shape.cy + size * 0.36 : shape.cy + shape.r + 11;
    const color = shape.labelInside && shape.kind !== 'crypto' ? GROUND : INK;
    const halo = shape.labelInside ? '' : ' paint-order="stroke" stroke="#1B1F4A" stroke-width="3" stroke-linejoin="round"';
    parts.push(`<text x="${shape.cx}" y="${y.toFixed(1)}" font-family="${SANS}" font-size="${size.toFixed(1)}" font-weight="600" text-anchor="middle" fill="${color}"${halo}>${escapeXmlV1(shape.label)}</text>`);
  }
  return parts.join('');
}

/** A mobile with no wallet: two stocks and a coin, in balance. The brand's own picture. */
const BRAND_MOBILE_V1: MobileInputV1 = {
  holdings: [
    { id: 'nvda', kind: 'stock', label: 'NVDA', valueCents: 90_000 },
    { id: 'btc', kind: 'crypto', label: 'BTC', valueCents: 70_000 },
    { id: 'aapl', kind: 'stock', label: 'AAPL', valueCents: 45_000 },
  ],
  // A loan with no figure on it: the brand picture claims no amount.
  loan: { owedCents: 24_000, limitCents: 78_000, weekdayLimitCents: null, owedLabel: ' ' },
  state: 'calm',
};

/** Words to lines, by an average glyph width: SVG does not wrap. */
function wrapV1(text: string, fontSize: number, width: number, maxLines: number): string[] {
  const perLine = Math.max(8, Math.floor(width / (fontSize * 0.52)));
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if ((line ? `${line} ${word}` : word).length > perLine && line) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1]!.replace(/[\s,.;:]+\S*$/, '')}…`;
  }
  return lines;
}

function textLinesV1(lines: string[], x: number, y: number, size: number, leading: number, attrs: string): string {
  return lines.map((line, i) => `<text x="${x}" y="${y + i * leading}" font-size="${size}" ${attrs}>${escapeXmlV1(line)}</text>`).join('');
}

/** The frame's glyph (StillFrame's StillGlyph) and the word, larger. */
function brandV1(x: number, y: number): string {
  return [
    `<g transform="translate(${x} ${y}) scale(1.5)">`,
    `<line x1="15" y1="0" x2="15" y2="7" stroke="${INK}" stroke-width="2"/>`,
    `<line x1="3" y1="7" x2="27" y2="7" stroke="${INK}" stroke-width="2"/>`,
    `<line x1="7" y1="7" x2="7" y2="11" stroke="${INK}" stroke-width="1.5"/>`,
    `<circle cx="7" cy="17" r="6" fill="${STOCK}"/>`,
    `<line x1="23.5" y1="7" x2="23.5" y2="11" stroke="${INK}" stroke-width="1.5"/>`,
    `<rect x="20" y="11" width="7" height="7" fill="${INK}"/>`,
    '</g>',
    `<text x="${x + 56}" y="${y + 33}" font-family="${SANS}" font-size="36" font-weight="600" fill="${INK}">Still</text>`,
  ].join('');
}

function frameV1(shape: StillCardShapeV1, mobile: MobileInputV1, right: (box: { x: number; top: number; bottom: number; width: number }) => string, alt: string, hung = ''): string {
  const { width, height } = STILL_CARD_SIZE_V1[shape];
  const pad = 40;
  const boxW = shape === 'wide' ? 500 : 540;
  const boxH = height - pad * 2;
  // The whole scene, fitted to the box's width and standing on its floor; the
  // sky above it continues in its own top colour, and the mobile's wire with it.
  const scale = boxW / 390;
  const sceneTop = pad + boxH - 310 * scale;
  const pivotX = pad + 196 * scale;
  const textX = pad + boxW + 60;
  const extraStars = [[0.12, 0.3], [0.31, 0.62], [0.55, 0.18], [0.78, 0.48], [0.9, 0.12]]
    .map(([fx, fy]) => `<circle cx="${(pad + fx! * boxW).toFixed(1)}" cy="${(pad + fy! * (sceneTop - pad)).toFixed(1)}" r="1.6" fill="#FFFFFF" fill-opacity="0.5"/>`)
    .join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXmlV1(alt)}">`,
    `<rect width="${width}" height="${height}" fill="${GROUND}"/>`,
    `<defs><clipPath id="scene"><rect x="${pad}" y="${pad}" width="${boxW}" height="${boxH}" rx="28"/></clipPath></defs>`,
    '<g clip-path="url(#scene)">',
    `<rect x="${pad}" y="${pad}" width="${boxW}" height="${boxH}" fill="#27347A"/>`,
    sceneTop > pad ? extraStars : '',
    sceneTop > pad ? `<line x1="${pivotX.toFixed(1)}" y1="${pad}" x2="${pivotX.toFixed(1)}" y2="${sceneTop.toFixed(1)}" stroke="${INK}" stroke-width="${(1.5 * scale).toFixed(2)}"/>` : '',
    `<g transform="translate(${pad} ${sceneTop.toFixed(1)}) scale(${scale.toFixed(4)})">${skyV1()}${mobileV1(mobile)}${hung}</g>`,
    '</g>',
    right({ x: textX, top: pad, bottom: height - pad, width: width - textX - pad }),
    '</svg>',
  ].join('');
}

/** Still itself. */
export function stillBrandCardSvgV1(shape: StillCardShapeV1): string {
  return frameV1(
    shape,
    BRAND_MOBILE_V1,
    ({ x, top, bottom, width }) => {
      const mid = (top + bottom) / 2;
      return [
        brandV1(x, top + 18),
        textLinesV1(['Spend without', 'selling.'], x, mid - 52, 66, 74, `font-family="${SANS}" font-weight="500" fill="${INK}"`),
        textLinesV1(wrapV1('Borrow USDC against tokenized stocks, bitcoin and ether on Base, and keep them. Your wallet signs every step.', 26, width, 3), x, mid + 70, 26, 36, `font-family="${SANS}" fill="${INK2}"`),
        `<text x="${x}" y="${bottom - 6}" font-family="${MONO}" font-size="20" letter-spacing="3" fill="${INK2}">MIORAIL.XYZ</text>`,
      ].join('');
    },
    'Still: spend without selling. A mobile of stocks and bitcoin hangs in balance under a dusk sky.',
  );
}

/** One wallet's check, as anyone could read it on Home: public chain state, at one block. */
export function stillWalletCardSvgV1(shape: StillCardShapeV1, report: MirrorReport, now: Date): string {
  const view = homeViewV1({ report, sky: skyStateV1({ now }) });
  const who = report.subject.name ?? `${report.subject.address.slice(0, 6)}…${report.subject.address.slice(-4)}`;
  const block = Number(report.reading.block).toLocaleString('en-US');
  const amount = view.available;
  return frameV1(
    shape,
    view.mobile,
    ({ x, top, bottom, width }) => {
      const parts = [
        brandV1(x, top + 18),
        `<text x="${x}" y="${top + 128}" font-family="${MONO}" font-size="19" letter-spacing="2" fill="${INK2}">${escapeXmlV1(`${who} · MODELLED ROOM`.toUpperCase())}</text>`,
      ];
      if (amount) {
        const dollars = `${amount.atLeast ? '≥ ' : ''}${amount.dollars}`;
        parts.push(
          `<text x="${x}" y="${top + 250}" font-family="${SANS}" font-weight="300" fill="${INK}"><tspan font-size="112">${escapeXmlV1(dollars)}</tspan><tspan font-size="52" dy="-46">${escapeXmlV1(amount.cents)}</tspan></text>`,
        );
      } else {
        parts.push(`<text x="${x}" y="${top + 230}" font-family="${SANS}" font-size="44" fill="${INK}">Not read this time</text>`);
      }
      parts.push(textLinesV1(wrapV1(`${view.stateWord} ${view.stateLine}`, 26, width, 3), x, top + 318, 26, 36, `font-family="${SANS}" fill="${INK2}"`));
      parts.push(`<text x="${x}" y="${bottom - 6}" font-family="${MONO}" font-size="17" letter-spacing="2" fill="${INK2}">${escapeXmlV1(`READ FROM BASE · BLOCK ${block} · MIORAIL.XYZ`)}</text>`);
      return parts.join('');
    },
    amount ? `${who}: ${amount.atLeast ? 'at least ' : ''}${amount.dollars}${amount.cents} modelled borrowing room on Still, read from Base at block ${block}.` : `${who} on Still: not read this time.`,
  );
}

/** Base's own mark, The Square, as its brand kit draws it: Base Blue, never recoloured or altered. */
const BASE_SQUARE_PATH_V1 =
  'M0,101.12c0-34.64,0-51.95,6.53-65.28,6.25-12.76,16.56-23.07,29.32-29.32C49.17,0,66.48,0,101.12,0h1077.76c34.63,0,51.96,0,65.28,6.53,12.75,6.25,23.06,16.56,29.32,29.32,6.52,13.32,6.52,30.64,6.52,65.28v1077.76c0,34.63,0,51.96-6.52,65.28-6.26,12.75-16.57,23.06-29.32,29.32-13.32,6.52-30.65,6.52-65.28,6.52H101.12c-34.64,0-51.95,0-65.28-6.52-12.76-6.26-23.07-16.57-29.32-29.32-6.53-13.32-6.53-30.65-6.53-65.28V101.12Z';

function baseSquareV1(x: number, y: number, side: number): string {
  return `<path transform="translate(${x} ${y}) scale(${(side / 1280).toFixed(5)})" fill="#0000FF" d="${BASE_SQUARE_PATH_V1}"/>`;
}

/** A Still Spend purchase, as its owner shared it: what a loan paid for and
 * against what. It names no wallet and no transaction (stillSpendShare.ts). */
export function stillSpendCardSvgV1(shape: StillCardShapeV1, share: StillSpendShareV1): string {
  const words = stillSpendShareWordsV1(share);
  const mobile: MobileInputV1 = {
    holdings: [{ id: 'collateral', kind: words.collateralKind, label: words.collateralLabel, valueCents: 90_000 }],
    // The square is the loan and carries what it paid; its size claims nothing.
    loan: { owedCents: 40_000, limitCents: 60_000, weekdayLimitCents: null, owedLabel: words.priceUsdc.replace(/\.00$/, '') },
    state: 'calm',
  };
  return frameV1(
    shape,
    mobile,
    ({ x, top, bottom, width }) => {
      const product = wrapV1(share.productName, 54, width, 2);
      const productTop = top + 196;
      const last = productTop + (product.length - 1) * 62;
      return [
        brandV1(x, top + 18),
        `<text x="${x}" y="${top + 128}" font-family="${MONO}" font-size="19" letter-spacing="2" fill="${INK2}">PAID WITH A LOAN · NOTHING SOLD</text>`,
        textLinesV1(product, x, productTop, 54, 62, `font-family="${SANS}" font-weight="500" fill="${INK}"`),
        `<text x="${x}" y="${last + 58}" font-family="${SANS}" font-size="34" fill="${INK}">${escapeXmlV1(share.packageLabel)}<tspan fill="${INK2}">\u00a0·\u00a0</tspan><tspan font-weight="600">${escapeXmlV1(words.priceUsdc)} USDC</tspan></text>`,
        textLinesV1(
          wrapV1(`Borrowed against ${words.collateralLabel} through ${words.venueName}, and paid Bitrefill with that loan.`, 24, width, 3),
          x, last + 112, 24, 34, `font-family="${SANS}" fill="${INK2}"`,
        ),
        baseSquareV1(x, bottom - 26, 24),
        `<text x="${x + 38}" y="${bottom - 6}" font-family="${MONO}" font-size="17" letter-spacing="2" fill="${INK2}">CHECKED ONCHAIN ON BASE</text>`,
        `<text x="${x + width}" y="${bottom - 6}" font-family="${MONO}" font-size="17" letter-spacing="2" text-anchor="end" fill="${INK2}">MIORAIL.XYZ</text>`,
      ].join('');
    },
    `Paid for ${share.productName} (${share.packageLabel}, ${words.priceUsdc} USDC) with a loan against ${words.collateralLabel} through ${words.venueName}, on Still.`,
  );
}

/** A loan, as its owner shared it: how much, against what, and through which protocol. No wallet, no transaction. */
export function stillLoanCardSvgV1(shape: StillCardShapeV1, share: StillLoanShareV1): string {
  const words = stillSpendShareWordsV1({ priceAtomic: share.borrowedAtomic, collateral: share.collateral, venue: share.venue });
  const mobile: MobileInputV1 = {
    holdings: [{ id: 'collateral', kind: words.collateralKind, label: words.collateralLabel, valueCents: 90_000 }],
    // The square is the loan and carries its amount; its size claims nothing.
    loan: { owedCents: 40_000, limitCents: 60_000, weekdayLimitCents: null, owedLabel: words.priceUsdc.replace(/\.00$/, '') },
    state: 'calm',
  };
  const [whole, cents] = words.priceUsdc.split('.');
  return frameV1(shape, mobile, ({ x, top, bottom, width }) => [
    brandV1(x, top + 18),
    `<text x="${x}" y="${top + 128}" font-family="${MONO}" font-size="19" letter-spacing="2" fill="${INK2}">SPENT WITHOUT SELLING</text>`,
    `<text x="${x}" y="${top + 250}" font-family="${SANS}" font-weight="300" fill="${INK}"><tspan font-size="112">${escapeXmlV1(whole!)}</tspan><tspan font-size="52" dy="-46">.${escapeXmlV1(cents!)}</tspan><tspan font-size="40" dy="46" font-weight="500"> USDC</tspan></text>`,
    textLinesV1(wrapV1(`Borrowed against ${words.collateralLabel} through ${words.venueName}. Nothing was sold: the ${words.collateralKind === 'stock' ? 'stock' : 'coin'} is the loan’s collateral.`, 25, width, 3), x, top + 318, 25, 35, `font-family="${SANS}" fill="${INK2}"`),
    baseSquareV1(x, bottom - 26, 24),
    `<text x="${x + 38}" y="${bottom - 6}" font-family="${MONO}" font-size="17" letter-spacing="2" fill="${INK2}">CHECKED ONCHAIN ON BASE</text>`,
    `<text x="${x + width}" y="${bottom - 6}" font-family="${MONO}" font-size="17" letter-spacing="2" text-anchor="end" fill="${INK2}">MIORAIL.XYZ</text>`,
  ].join(''), `A loan of ${words.priceUsdc} USDC against ${words.collateralLabel} through ${words.venueName}, on Still: nothing sold.`);
}

/** Stocks alone, in balance: the Stocks board's picture. No wallet, no loan. */
const STOCKS_MOBILE_V1: MobileInputV1 = {
  holdings: [
    { id: 'nvda', kind: 'stock', label: 'NVDA', valueCents: 90_000 },
    { id: 'aapl', kind: 'stock', label: 'AAPL', valueCents: 62_000 },
    { id: 'tsla', kind: 'stock', label: 'TSLA', valueCents: 41_000 },
  ],
  // As the brand's picture: a loan with no figure on it.
  loan: { owedCents: 24_000, limitCents: 78_000, weekdayLimitCents: null, owedLabel: ' ' },
  state: 'calm',
};

/** The Stocks board and a stock's page. */
export function stillStocksCardSvgV1(shape: StillCardShapeV1): string {
  return frameV1(shape, STOCKS_MOBILE_V1, ({ x, top, bottom, width }) => {
    const mid = (top + bottom) / 2;
    return [
      brandV1(x, top + 18),
      `<text x="${x}" y="${top + 128}" font-family="${MONO}" font-size="19" letter-spacing="2" fill="${INK2}">TOKENIZED STOCKS ON BASE</text>`,
      textLinesV1(['Every stock,', 'measured.'], x, mid - 20, 66, 74, `font-family="${SANS}" font-weight="500" fill="${INK}"`),
      textLinesV1(wrapV1('The price against the real share, what getting back out costs, and which contract is official. No wallet needed to look.', 25, width, 4), x, mid + 100, 25, 35, `font-family="${SANS}" fill="${INK2}"`),
      `<text x="${x}" y="${bottom - 6}" font-family="${MONO}" font-size="20" letter-spacing="3" fill="${INK2}">MIORAIL.XYZ/STOCKS</text>`,
    ].join('');
  }, 'Still: tokenized stocks on Base, measured. A mobile of stocks hangs in balance under a dusk sky.');
}

const GIFT_MOBILE_V1: MobileInputV1 = {
  holdings: [
    { id: 'aapl', kind: 'stock', label: 'AAPL', valueCents: 70_000 },
    { id: 'nvda', kind: 'stock', label: 'NVDA', valueCents: 70_000 },
  ],
  // The square hangs as the gift: a box with its ribbon, and no figure.
  loan: { owedCents: 30_000, limitCents: 30_000, weekdayLimitCents: null, owedLabel: ' ' },
  state: 'calm',
};

/** The ribbon over the gift's box, in the stock's blue, where the layout hung the square. */
function ribbonV1(): string {
  const box = mobileLayoutV1(GIFT_MOBILE_V1).loan;
  if (!box) return '';
  const band = Math.max(3, box.side / 7), cx = box.x + box.side / 2, cy = box.y + box.side / 2;
  return [
    `<rect x="${(cx - band / 2).toFixed(1)}" y="${box.y}" width="${band.toFixed(1)}" height="${box.side}" fill="${STOCK}"/>`,
    `<rect x="${box.x}" y="${(cy - band / 2).toFixed(1)}" width="${box.side}" height="${band.toFixed(1)}" fill="${STOCK}"/>`,
  ].join('');
}

/** A gift of a stock: the gift page's picture. */
export function stillGiftCardSvgV1(shape: StillCardShapeV1): string {
  return frameV1(shape, GIFT_MOBILE_V1, ({ x, top, bottom, width }) => {
    const mid = (top + bottom) / 2;
    return [
      brandV1(x, top + 18),
      `<text x="${x}" y="${top + 128}" font-family="${MONO}" font-size="19" letter-spacing="2" fill="${INK2}">A GIFT ON BASE</text>`,
      textLinesV1(['Give someone', 'a stock.'], x, mid - 20, 66, 74, `font-family="${SANS}" font-weight="500" fill="${INK}"`),
      textLinesV1(wrapV1('Bought and delivered in one transaction, and held in their own wallet. From $0.10 to $100 in USDC.', 25, width, 4), x, mid + 100, 25, 35, `font-family="${SANS}" fill="${INK2}"`),
      `<text x="${x}" y="${bottom - 6}" font-family="${MONO}" font-size="20" letter-spacing="3" fill="${INK2}">MIORAIL.XYZ</text>`,
    ].join('');
  }, 'Still: give someone a stock on Base. Two stocks and a gift hang in balance under a dusk sky.', ribbonV1());
}

/** Still's icon: the frame's glyph, large, on the night ground. Square; the mini app's icon and splash. */
export function stillIconSvgV1(size: number): string {
  // The glyph spans x 1..27 and y 0..23 in its own units (brandV1); centred, at 61% of the side.
  const s = (size * 0.61) / 26;
  const x = (size - 26 * s) / 2 - s, y = (size - 23 * s) / 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" fill="${GROUND}"/>`,
    `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${s.toFixed(4)})">`,
    `<line x1="15" y1="0" x2="15" y2="7" stroke="${INK}" stroke-width="2"/>`,
    `<line x1="3" y1="7" x2="27" y2="7" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`,
    `<line x1="7" y1="7" x2="7" y2="11" stroke="${INK}" stroke-width="1.5"/>`,
    `<circle cx="7" cy="17" r="6" fill="${STOCK}"/>`,
    `<line x1="23.5" y1="7" x2="23.5" y2="11" stroke="${INK}" stroke-width="1.5"/>`,
    `<rect x="20" y="11" width="7" height="7" fill="${INK}"/>`,
    '</g></svg>',
  ].join('');
}

/** The same mobile as a browser tab and an assistant's connector list draw it, at 16 to 192 px: larger on its
 * ground and with heavier wires, which the icon's proportions lose at that size. */
export function stillFaviconSvgV1(size: number): string {
  const s = (size * 0.8) / 27;
  const x = (size - 27 * s) / 2 - 0.5 * s, y = (size - 23.5 * s) / 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" fill="${GROUND}"/>`,
    `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${s.toFixed(4)})">`,
    `<line x1="15" y1="0" x2="15" y2="7" stroke="${INK}" stroke-width="2.6"/>`,
    `<line x1="2.5" y1="7" x2="27.5" y2="7" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`,
    `<line x1="7" y1="7" x2="7" y2="11" stroke="${INK}" stroke-width="2.2"/>`,
    `<circle cx="7" cy="17" r="6.5" fill="${STOCK}"/>`,
    `<line x1="23.5" y1="7" x2="23.5" y2="11" stroke="${INK}" stroke-width="2.2"/>`,
    `<rect x="19.75" y="11" width="7.5" height="7.5" fill="${INK}"/>`,
    '</g></svg>',
  ].join('');
}
