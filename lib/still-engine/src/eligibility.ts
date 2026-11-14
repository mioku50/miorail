/**
 * Who Still is not offered to, and what it asks before it prepares a new
 * position (operator, 2026-11-10; the sanctioned places, 2026-11-14).
 *
 * Coinbase's tokenized stocks are "available only to persons in eligible
 * jurisdictions outside of the United States", and Base's documentation adds
 * that "integrators are responsible for applying applicable restrictions". It
 * publishes no list of the eligible ones (audit BASE-2, 2026-11-14: the gate
 * and every text had narrowed that to "not the United States", and a person in
 * Iran passed both). So Still prepares no new loan, Spend purchase or stock buy
 * for a US person, nor for a request from the United States and its
 * territories or from a country under comprehensive US sanctions: Cuba, Iran,
 * North Korea and Syria, by the country the request's IP address is registered
 * in. Crimea and the so-called Donetsk and Luhansk People's Republics are under
 * the same sanctions, but a table of countries cannot tell those regions of
 * Ukraine apart from the rest of it: they are in the sentence a person
 * confirms, not in the gate. Everyone else confirms that sentence once per
 * sign-in. What closes a position stays open everywhere: repaying, taking
 * collateral back, selling.
 */
/** The countries under comprehensive US sanctions, closed by the region gate whatever its list says. */
export const STILL_SANCTIONED_COUNTRIES_V1 = [
  { code: 'CU', name: 'Cuba' },
  { code: 'IR', name: 'Iran' },
  { code: 'KP', name: 'North Korea' },
  { code: 'SY', name: 'Syria' },
] as const;
/** Sanctioned regions no country table can place: said, never gated. */
export const STILL_SANCTIONED_REGIONS_V1 = ['Crimea', 'the so-called Donetsk People’s Republic', 'the so-called Luhansk People’s Republic'] as const;
/** Where Still prepares nothing new, as one phrase every page and answer shares. */
export const STILL_NOT_OFFERED_IN_V1 = 'the United States, Cuba, Iran, North Korea, Syria, Crimea, or the so-called Donetsk or Luhansk People’s Republics';
/** The sentence a public text opens with: eligible jurisdictions, and which places are not. */
export const STILL_ELIGIBLE_JURISDICTIONS_V1 = 'Coinbase’s tokenized stocks are available only to persons in eligible jurisdictions outside the United States. '
  + `Still prepares no new loan, purchase or stock buy for a U.S. person, or for anyone in ${STILL_NOT_OFFERED_IN_V1}.`;
export const STILL_ELIGIBILITY_STATEMENT_V1 = `I am not a U.S. person, and I am not currently located in ${STILL_NOT_OFFERED_IN_V1}.`;
/** Who a U.S. person is, under the box: everyday reading takes it for "a person in the United States", and a US citizen
 * abroad, whom no IP address places, is exactly whom the box is for (audit UI-18, 2026-11-14). */
export const STILL_US_PERSON_DEFINITION_V1 = 'A U.S. person is a U.S. citizen or green-card holder, wherever they live, or anyone resident in the United States.';
/** Names the sentence above: a confirmation of another sentence is not a confirmation of this one. */
export const STILL_ELIGIBILITY_VERSION_V1 = 'not-us-person-or-sanctioned-2026-11-14';
/** DB-IP's free country database is CC BY 4.0: where Still uses it, it says so. */
export const STILL_REGION_ATTRIBUTION_V1 = { text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' } as const;
/** What a refusal leaves open, in the words the server and the screens share. */
export const STILL_REGION_OPEN_V1 = 'You can still repay a loan, take your collateral back and sell.';
