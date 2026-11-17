// ---------------------------------------------------------------------------
// Subscriptions Still can pay through Bitrefill cards (catalogue read
// 2026-11-17 in 14 countries, scratch map). Two kinds:
//
// - A service's own card: Discord Nitro, Netflix, Disney+, Xbox, PlayStation,
//   Nintendo, Twitch, Crunchyroll. Bitrefill sells each in some countries.
// - An app store's balance: an Apple or a Google Play card tops up the
//   account's balance, which pays subscriptions bought inside an app (X
//   Premium, ChatGPT Plus, Claude Pro and others), as Apple and Google say;
//   a card works only for an account of its own country.
//
// A card is a prepaid top-up: nothing renews by itself, and every purchase is
// the person's own, signed. The page searches Bitrefill for `search` in the
// person's country and keeps only the products whose id `product` matches;
// an assistant reads the same table (stillSubscriptionGuideV1).
// ---------------------------------------------------------------------------

export interface StillSubscriptionV1 {
  key: string;
  name: string;
  /** What Bitrefill is searched for. */
  search: string;
  /** Bitrefill product ids that are this service's cards. */
  product: RegExp;
  /** What the card pays, in a line. */
  pays: string;
  /** An app store's balance rather than the service's own card. */
  store?: 'apple' | 'google';
}

export const STILL_SUBSCRIPTIONS_V1: readonly StillSubscriptionV1[] = [
  { key: 'discord', name: 'Discord Nitro', search: 'Discord', product: /^discord-nitro/, pays: 'Nitro on your Discord account' },
  { key: 'netflix', name: 'Netflix', search: 'Netflix', product: /^netflix-/, pays: 'Your Netflix plan, from its balance' },
  { key: 'disney', name: 'Disney+', search: 'Disney', product: /^disney-plus-|^disney_-/, pays: 'Your Disney+ subscription' },
  { key: 'xbox', name: 'Xbox and Game Pass', search: 'Xbox', product: /^xbox-/, pays: 'Game Pass, or your Microsoft balance for it' },
  { key: 'playstation', name: 'PlayStation', search: 'PlayStation', product: /^playstation-/, pays: 'Your PlayStation wallet: PlayStation Plus and games' },
  { key: 'nintendo', name: 'Nintendo', search: 'Nintendo', product: /^nintendo-/, pays: 'Your Nintendo eShop balance, or Switch Online' },
  { key: 'twitch', name: 'Twitch', search: 'Twitch', product: /^twitch-/, pays: 'Twitch subscriptions and Bits' },
  { key: 'crunchyroll', name: 'Crunchyroll', search: 'Crunchyroll', product: /crunchyroll/, pays: 'Your Crunchyroll membership' },
  { key: 'apple', name: 'Apple (iPhone apps)', search: 'Apple', product: /^itunes-|^apple-|^app-store/, store: 'apple',
    pays: 'Your Apple Account balance, which pays subscriptions bought inside iPhone apps, such as X Premium, ChatGPT Plus or Claude Pro' },
  { key: 'google-play', name: 'Google Play (Android apps)', search: 'Google Play', product: /^google-play-/, store: 'google',
    pays: 'Your Google Play balance, which pays subscriptions bought inside Android apps' },
];

/** The service's products among a search's, in the order Bitrefill gave them. */
export function stillSubscriptionProductsV1<T extends { id: string }>(key: string, products: readonly T[]): T[] {
  const service = STILL_SUBSCRIPTIONS_V1.find((row) => row.key === key);
  return service ? products.filter((product) => service.product.test(product.id)) : [];
}

/** What an assistant is told about paying a subscription: the same table the page shows. */
export function stillSubscriptionGuideV1(): string {
  const direct = STILL_SUBSCRIPTIONS_V1.filter((row) => !row.store).map((row) => row.name).join(', ');
  return `To pay a subscription, search for the service's own card first (${direct}) in the person's country. `
    + 'A service sold only inside its app (X Premium, ChatGPT Plus, Claude Pro and others) is paid from the app store’s balance: '
    + 'an Apple gift card for an iPhone, a Google Play card for Android, of the same country as the person’s store account. '
    + 'Say that a card tops up a balance and does not renew by itself, that a price inside an app can be above the service’s own web price, '
    + 'and when no card for the service is listed, say so. Never suggest another country’s card or a VPN.';
}
