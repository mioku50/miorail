import { stockByToken, type StockId } from './registry.js';

// ---------------------------------------------------------------------------
// A Loop: a Still loan against one company's stock pays, in the same batch, a
// Bitrefill card of that same company. The stock stays the owner's, pledged
// until the loan is repaid; the card arrives.
//
// Matched by Bitrefill's product id only, never by its name: names are
// translated and reused across products, ids are not. The ids below were read
// from Bitrefill's catalogue through still_find_spend on 2026-11-17, in DE, GB
// and FR: itunes-germany, apple-united-kingdom, apple-france, amazon_de-germany,
// amazon-uk, amazon_fr-france, google-play-germany, google-play-united-kingdom,
// meta-quest-germany, meta-quest-eu, meta-quest-uk-united-kingdom, xbox-germany,
// xbox-currency-united-kingdom and the Game Pass cards.
//
// NVIDIA, SpaceX and Tesla sell no card of their own at Bitrefill (no GeForce,
// no Starlink), so a loan against them makes no Loop.
// ---------------------------------------------------------------------------

export type LoopBrandIdV1 = 'apple' | 'amazon' | 'google' | 'meta' | 'microsoft';

export interface LoopBrandV1 {
  brand: LoopBrandIdV1;
  /** The company, as a reader names it. Never a logo: the name alone, with "not affiliated". */
  name: string;
  /** The stock that must be pledged. */
  collateral: StockId;
  /** What the card is, in a sentence: "An Apple gift card arrived." */
  card: string;
  /** Bitrefill product ids of this brand, in any country. */
  productIds: readonly RegExp[];
}

export const LOOP_BRANDS_V1: readonly LoopBrandV1[] = [
  { brand: 'apple', name: 'Apple', collateral: 'AAPLc', card: 'Apple gift card', productIds: [/^itunes-/, /^apple-/] },
  { brand: 'amazon', name: 'Amazon', collateral: 'AMZNc', card: 'Amazon gift card', productIds: [/^amazon[-_]/] },
  { brand: 'google', name: 'Google', collateral: 'GOOGLc', card: 'Google Play card', productIds: [/^google-play-/] },
  { brand: 'meta', name: 'Meta', collateral: 'METAc', card: 'Meta Quest card', productIds: [/^meta-quest-/] },
  { brand: 'microsoft', name: 'Microsoft', collateral: 'MSFTc', card: 'Xbox card', productIds: [/^xbox-/] },
];

/** Bitrefill's product id: a lowercase slug, as Still's own routes accept it. */
const PRODUCT_ID_V1 = /^[a-z0-9][a-z0-9_.-]{0,99}$/;

/**
 * The Loop a loan's purchase makes, or null.
 *
 * `collateralTokenAddress` is the pledged token as the loan's facts carry it;
 * `productId` is the Bitrefill product its USDC paid. A loan that paid nothing,
 * a stock with no card of its own and a card of another company are not Loops.
 */
export function loopBrandOfV1(input: { collateralTokenAddress: string; productId: string | null | undefined }): LoopBrandV1 | null {
  const productId = input.productId;
  if (typeof productId !== 'string' || !PRODUCT_ID_V1.test(productId)) return null;
  const token = input.collateralTokenAddress;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return null;
  const stock = stockByToken(token as `0x${string}`);
  if (!stock) return null;
  const brand = LOOP_BRANDS_V1.find((row) => row.collateral === stock.id);
  return brand && brand.productIds.some((pattern) => pattern.test(productId)) ? brand : null;
}
