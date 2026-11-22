// ---------------------------------------------------------------------------
// Subscriptions Still can pay through Bitrefill cards (catalogue read
// 2026-11-17 in 14 countries, scratch map). Two kinds:
//
// - A service's own card: Discord Nitro, Netflix, Disney+, Xbox, PlayStation,
//   Nintendo, Twitch, Crunchyroll. Bitrefill sells each in some countries.
// - An app store's balance: an Apple or a Google Play card tops up the
//   account's balance, which pays what that store bills: a subscription
//   bought inside the service's app (X Premium, ChatGPT Plus, Claude Pro and
//   others can be bought there), as Apple and Google say. A plan bought on the
//   service's own website is billed by the service, and no store card pays it
//   (audit P3, 2026-11-18); a card works only for an account of its own
//   country, which an assistant says whenever it shows another country's
//   card (operator, 2026-11-18).
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
  /**
   * The app stores that bill this service's plan when it is bought inside the
   * service's own app, as read on `checked`. Where the service's own card is
   * missing for a country, a card of one of these stores for that country pays
   * such a plan. Only services read are marked, because not every service sells
   * its plan inside its app.
   */
  inApp?: { app: string; plan: string; stores: readonly ('apple' | 'google')[]; checked: string };
}

export const STILL_SUBSCRIPTIONS_V1: readonly StillSubscriptionV1[] = [
  // Nitro in-app: the Irish App Store lists it (Nitro €9.99 a month, 2026-11-22), and Discord's paid services
  // terms (May 2025) cancel "in-app subscription purchases made on iOS or Android devices" through the App Store
  // or Google Play. Bitrefill's own Nitro card is US only since 2026-11-21.
  { key: 'discord', name: 'Discord Nitro', search: 'Discord', product: /^discord-nitro/, pays: 'Nitro on your Discord account',
    inApp: { app: 'Discord', plan: 'Nitro', stores: ['apple', 'google'], checked: '2026-11-22' } },
  { key: 'netflix', name: 'Netflix', search: 'Netflix', product: /^netflix-/, pays: 'Your Netflix plan, from its balance' },
  { key: 'disney', name: 'Disney+', search: 'Disney', product: /^disney-plus-|^disney_-/, pays: 'Your Disney+ subscription' },
  { key: 'xbox', name: 'Xbox and Game Pass', search: 'Xbox', product: /^xbox-/, pays: 'Game Pass, or your Microsoft balance for it' },
  { key: 'playstation', name: 'PlayStation', search: 'PlayStation', product: /^playstation-/, pays: 'Your PlayStation wallet: PlayStation Plus and games' },
  { key: 'nintendo', name: 'Nintendo', search: 'Nintendo', product: /^nintendo-/, pays: 'Your Nintendo eShop balance, or Switch Online' },
  { key: 'twitch', name: 'Twitch', search: 'Twitch', product: /^twitch-/, pays: 'Twitch subscriptions and Bits' },
  { key: 'crunchyroll', name: 'Crunchyroll', search: 'Crunchyroll', product: /crunchyroll/, pays: 'Your Crunchyroll membership' },
  { key: 'apple', name: 'Apple (iPhone apps)', search: 'Apple', product: /^itunes-|^apple-|^app-store/, store: 'apple',
    pays: 'Your Apple Account balance: it pays what Apple bills, such as X Premium, ChatGPT Plus or Claude Pro bought inside their iPhone apps, not a plan bought on their websites' },
  { key: 'google-play', name: 'Google Play (Android apps)', search: 'Google Play', product: /^google-play-/, store: 'google',
    pays: 'Your Google Play balance: it pays what Google Play bills, such as a subscription bought inside an Android app' },
];

/** The service's products among a search's, in the order Bitrefill gave them. */
export function stillSubscriptionProductsV1<T extends { id: string }>(key: string, products: readonly T[]): T[] {
  const service = STILL_SUBSCRIPTIONS_V1.find((row) => row.key === key);
  return service ? products.filter((product) => service.product.test(product.id)) : [];
}

/** The app store tiles whose card pays a service's plan bought inside its app, in the table's order; none for a service not marked. */
export function stillSubscriptionStoreRoutesV1(key: string): StillSubscriptionV1[] {
  const stores = STILL_SUBSCRIPTIONS_V1.find((row) => row.key === key)?.inApp?.stores ?? [];
  return STILL_SUBSCRIPTIONS_V1.filter((row) => row.store !== undefined && stores.includes(row.store));
}

const IN_APP_DEVICES_V1 = { apple: 'iPhone', google: 'Android' } as const;

/** "iPhone and Android apps", "iPhone app": where a marked service sells its plan. */
export function stillSubscriptionAppsV1(stores: readonly ('apple' | 'google')[]): string {
  const devices = stores.map((store) => IN_APP_DEVICES_V1[store]);
  return devices.length > 1 ? `${devices.slice(0, -1).join(', ')} and ${devices[devices.length - 1]} apps` : `${devices[0] ?? ''} app`;
}

/** What an assistant is told about paying a subscription: the same table the page shows. */
export function stillSubscriptionGuideV1(): string {
  const direct = STILL_SUBSCRIPTIONS_V1.filter((row) => !row.store).map((row) => row.name).join(', ');
  const inApp = STILL_SUBSCRIPTIONS_V1.flatMap((row) => row.inApp ? [`${row.name}, in its ${stillSubscriptionAppsV1(row.inApp.stores)}`] : []).join('; ');
  return `To pay a subscription, search for the service's own card first (${direct}) in the person's country. `
    + 'A subscription bought inside the service’s iPhone or Android app is billed by that app store (X Premium, ChatGPT Plus, Claude Pro and others '
    + 'can be bought there), and can be paid from the store’s balance: an Apple gift card for one Apple bills, a Google Play card for one Google Play '
    + 'bills, of the same country as the person’s store account. A store’s balance pays only what that store bills: a plan bought on the service’s '
    + 'own website is billed by the service, and a store card does not pay it. '
    + 'Say that a card tops up a balance and does not renew by itself, that a price inside an app can be above the service’s own web price, '
    + 'and when no card for the service is listed, say so. '
    + (inApp ? `Some services sell their plan inside their own app, where the app store bills it: ${inApp}. When such a service’s own card is not `
      + 'listed for the person’s country, offer the card of the store that bills it, for that same country, for the plan bought inside the app, '
      + 'before another country’s card of the service: it works on the person’s own account. ' : '')
    + 'Search the country of the person’s own account first (for an Apple or Google Play card, their store account), and ask which it is '
    + 'when you do not know. When that country lists no card, say so; you may then show another country’s cards, and if you do, say how they '
    + 'work: a card tops up only an account of its own country, so it does not work on the person’s account as it is; whether an account can '
    + 'move to another country, and on what terms, is the store’s own rule, so point to the store’s help page rather than promise it; and a '
    + 'price inside the app there can differ. Never suggest a VPN.';
}
