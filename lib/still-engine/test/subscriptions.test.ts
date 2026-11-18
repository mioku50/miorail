import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STILL_SUBSCRIPTIONS_V1, stillSubscriptionGuideV1, stillSubscriptionProductsV1 } from '../src/subscriptions.js';

// Real Bitrefill product ids, read from its catalogue through Still's search on 2026-11-17 (DE, GB, FR, BR and others).
const REAL_V1: ReadonlyArray<[string, string]> = [
  ['discord-nitro-us', 'discord'], ['netflix-eu', 'netflix'], ['netflix-united-kingdom', 'netflix'], ['netflix-brazil', 'netflix'],
  ['disney-plus-germany', 'disney'], ['disney_-uk', 'disney'], ['xbox-germany', 'xbox'], ['xbox-currency-united-kingdom', 'xbox'],
  ['xbox-game-pass-ultimate-uk', 'xbox'], ['xbox-game-pass-essential-br', 'xbox'], ['playstation-pin-germany', 'playstation'],
  ['playstation-united-kingdom', 'playstation'], ['nintendo-germany', 'nintendo'], ['nintendo-switch-subscription-united-kingdom', 'nintendo'],
  ['twitch-eu', 'twitch'], ['twitch-uk', 'twitch'], ['crunchyroll-on-vrv-united-kingdom', 'crunchyroll'], ['itunes-germany', 'apple'],
  ['apple-united-kingdom', 'apple'], ['app-store-and-itunes-brazil', 'apple'], ['google-play-germany', 'google-play'],
];
// Cards that share a word with a service and pay something else.
const NOT_V1 = ['call-of-duty_-points-xbox-version', 'efootball-international', 'disney-usa', 'disneyland-paris-by-inspire-uk', 'applebees-usa',
  'amazon_de-germany', 'steam-germany', 'claude-ppq-international'];

describe('subscriptions Still can pay with a card', () => {
  it('know each service’s own cards by the ids Bitrefill sold on 2026-11-17, and nothing that only shares a word', () => {
    for (const [id, key] of REAL_V1) {
      assert.deepEqual(STILL_SUBSCRIPTIONS_V1.filter((row) => row.product.test(id)).map((row) => row.key), [key], id);
    }
    for (const id of NOT_V1) assert.deepEqual(STILL_SUBSCRIPTIONS_V1.filter((row) => row.product.test(id)).map((row) => row.key), [], id);
    const found = [{ id: 'disney-usa' }, { id: 'disney-plus-germany' }, { id: 'disneyland-paris-by-inspire-uk' }];
    assert.deepEqual(stillSubscriptionProductsV1('disney', found), [{ id: 'disney-plus-germany' }]);
    assert.deepEqual(stillSubscriptionProductsV1('spotify', found), [], 'a service it does not know keeps nothing');
  });

  it('search by a word Still’s search accepts, each key once, the app stores marked', () => {
    assert.equal(new Set(STILL_SUBSCRIPTIONS_V1.map((row) => row.key)).size, STILL_SUBSCRIPTIONS_V1.length);
    for (const row of STILL_SUBSCRIPTIONS_V1) assert.match(row.search, /^[\p{L}\p{N} .&'+-]{1,40}$/u, row.key);
    assert.deepEqual(STILL_SUBSCRIPTIONS_V1.filter((row) => row.store).map((row) => [row.key, row.store]), [['apple', 'apple'], ['google-play', 'google']]);
  });

  it('tell an assistant the own card first, the store balance of the same country second, and the limits plainly', () => {
    const guide = stillSubscriptionGuideV1();
    assert.match(guide, /service's own card first \(Discord Nitro, Netflix, Disney\+, Xbox and Game Pass, PlayStation, Nintendo, Twitch, Crunchyroll\)/);
    assert.match(guide, /same country as the person’s store account/);
    // A store's balance pays what that store bills, never a plan the service bills on its own website (audit P3, 2026-11-18).
    assert.match(guide, /A store’s balance pays only what that store bills: a plan bought on the service’s own website is billed by the service, and a store card does not pay it\./);
    assert.doesNotMatch(guide, /sold only inside its app/);
    assert.match(guide, /does not renew by itself/);
    assert.match(guide, /Never suggest another country’s card or a VPN\./);
    // An assistant listed Apple France and Apple USA cards to a person whose country had none (operator's check, 2026-11-18).
    assert.match(guide, /Search only the country of the person’s own account/);
    assert.match(guide, /ask which it is when you do not know/);
    assert.match(guide, /do not list or price other countries’ cards/);
    assert.match(guide, /do not explain how to move an account to another country/);
  });
});
