import type { MirrorReport } from '@mioagent/still-engine/report';
import { formatCents } from '@mioagent/still-engine/format';

import { homeViewV1, type MobileInputV1 } from '../../../lib/ui/src/still/homeView.js';
import { mobileLayoutV1 } from '../../../lib/ui/src/still/mobileLayout.js';
import { skyStateV1 } from '../../../lib/ui/src/still/skyState.js';

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

function frameV1(shape: StillCardShapeV1, mobile: MobileInputV1, right: (box: { x: number; top: number; bottom: number; width: number }) => string, alt: string): string {
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
    `<g transform="translate(${pad} ${sceneTop.toFixed(1)}) scale(${scale.toFixed(4)})">${skyV1()}${mobileV1(mobile)}</g>`,
    '</g>',
    right({ x: textX, top: pad, bottom: height - pad, width: width - textX - pad }),
    '</svg>',
  ].join('');
}

/** stills.lat itself. */
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
        `<text x="${x}" y="${bottom - 6}" font-family="${MONO}" font-size="20" letter-spacing="3" fill="${INK2}">STILLS.LAT</text>`,
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
      parts.push(`<text x="${x}" y="${bottom - 6}" font-family="${MONO}" font-size="17" letter-spacing="2" fill="${INK2}">${escapeXmlV1(`READ FROM BASE · BLOCK ${block} · STILLS.LAT`)}</text>`);
      return parts.join('');
    },
    amount ? `${who}: ${amount.atLeast ? 'at least ' : ''}${amount.dollars}${amount.cents} modelled borrowing room on Still, read from Base at block ${block}.` : `${who} on Still: not read this time.`,
  );
}
