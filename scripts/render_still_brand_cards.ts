/**
 * Still's own link pictures, drawn by the same code as a wallet's card
 * (artifacts/api-server/lib/stillCard.ts) and kept as files beside the app:
 * index.html names them for every page without a head of its own.
 *
 *   node --import tsx scripts/render_still_brand_cards.ts
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderCardPngV1 } from '../artifacts/api-server/lib/cardImage.js';
import { stillBrandCardSvgV1 } from '../artifacts/api-server/lib/stillCard.js';

async function main(): Promise<void> {
  const out = resolve(__dirname, '../artifacts/interface/public');
  writeFileSync(resolve(out, 'og-still.png'), await renderCardPngV1(stillBrandCardSvgV1('wide')));
  writeFileSync(resolve(out, 'og-still-3x2.png'), await renderCardPngV1(stillBrandCardSvgV1('tall')));
  console.log('wrote og-still.png and og-still-3x2.png');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
