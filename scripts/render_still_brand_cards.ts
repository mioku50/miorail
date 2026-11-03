/**
 * Still's own link pictures, drawn by the same code as a wallet's card
 * (artifacts/api-server/lib/stillCard.ts) and kept as files beside the app:
 * index.html names them for every page without a head of its own, and the
 * stocks, Found and gift pages name theirs.
 *
 * Farcaster and X keep a picture by its address, so a new picture gets a new
 * name, and the old names get the new pictures for the links already posted
 * (2026-11-03: the stocks and gift cards and the mini app's icon became Still's).
 *
 *   node --import tsx scripts/render_still_brand_cards.ts
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { renderCardPngV1 } from '../artifacts/api-server/lib/cardImage.js';
import { stillBrandCardSvgV1, stillGiftCardSvgV1, stillIconSvgV1, stillStocksCardSvgV1 } from '../artifacts/api-server/lib/stillCard.js';

/** Farcaster refuses an icon or a splash with an alpha channel. sharp is the miniapp's dependency. */
type SharpV1 = (input: Uint8Array) => { removeAlpha(): { png(): { toBuffer(): Promise<Buffer> } } };
async function opaqueV1(png: Uint8Array): Promise<Uint8Array> {
  const sharp = createRequire(resolve(__dirname, '../artifacts/miniapp/package.json'))('sharp') as SharpV1;
  return new Uint8Array(await sharp(png).removeAlpha().png().toBuffer());
}

async function main(): Promise<void> {
  const out = resolve(__dirname, '../artifacts/interface/public');
  const write = (names: string[], png: Uint8Array) => {
    for (const name of names) writeFileSync(resolve(out, name), png);
  };
  write(['og-still.png'], await renderCardPngV1(stillBrandCardSvgV1('wide')));
  write(['og-still-3x2.png'], await renderCardPngV1(stillBrandCardSvgV1('tall')));
  write(['og-still-stocks.png', 'og-stocks.png'], await renderCardPngV1(stillStocksCardSvgV1('wide')));
  write(['og-still-stocks-3x2.png', 'og-stocks-3x2.png'], await renderCardPngV1(stillStocksCardSvgV1('tall')));
  write(['og-still-gift.png', 'og-gift.png'], await renderCardPngV1(stillGiftCardSvgV1('wide')));
  write(['og-still-gift-3x2.png', 'og-gift-3x2.png'], await renderCardPngV1(stillGiftCardSvgV1('tall')));
  write(['still-icon.png', 'miniapp-icon.png'], await opaqueV1(await renderCardPngV1(stillIconSvgV1(1024))));
  write(['still-splash.png', 'miniapp-splash.png'], await opaqueV1(await renderCardPngV1(stillIconSvgV1(200))));
  console.log('wrote the Still cards, the icon and the splash');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
