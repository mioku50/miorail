// ---------------------------------------------------------------------------
// The two pictures a shared link is drawn as.
//
// X, Telegram and the other unfurlers show 1200 by 630. A Farcaster mini app
// embed must be 3:2 and is cropped to it otherwise, so the same card is drawn
// 800 tall for it: the same words at the same sizes, the rows set further
// apart. A card is laid out once, for 630, and every vertical position moves
// with the height.
// ---------------------------------------------------------------------------

export type CardShapeV1 = 'link' | 'embed';

export const CARD_WIDTH_V1 = 1200;
const LINK_HEIGHT_V1 = 630;
const EMBED_HEIGHT_V1 = 800;

export function cardHeightV1(shape: CardShapeV1): number {
  return shape === 'embed' ? EMBED_HEIGHT_V1 : LINK_HEIGHT_V1;
}

/** A vertical position laid out for 630, where it falls on a card `height` tall. */
export function cardYV1(y: number, height: number): number {
  return Math.round((y * height) / LINK_HEIGHT_V1);
}

/** The file name a card is served under: `<name>.png`, or `<name>-3x2.png`. */
export function cardFileSuffixV1(shape: CardShapeV1): string {
  return shape === 'embed' ? '-3x2' : '';
}
