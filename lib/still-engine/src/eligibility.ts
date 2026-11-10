/**
 * Who Still is not offered to, and what it asks before it prepares a new
 * position (operator, 2026-11-10).
 *
 * Coinbase's tokenized stocks are "available only to persons in eligible
 * jurisdictions outside of the United States", and Base's documentation adds
 * that "integrators are responsible for applying applicable restrictions". So
 * Still prepares no new loan, Spend purchase or stock buy for a request from
 * the United States, by the country its IP address is registered in, and asks
 * everyone else to confirm this sentence once per sign-in. What closes a
 * position stays open everywhere: repaying, taking collateral back, selling.
 * The sentence is the one Uniswap's interface asks before a tokenized stock.
 */
export const STILL_ELIGIBILITY_STATEMENT_V1 = 'I am not a U.S. person and I am not currently located in the United States.';
/** Names the sentence above: a confirmation of another sentence is not a confirmation of this one. */
export const STILL_ELIGIBILITY_VERSION_V1 = 'not-us-person-2026-11-10';
/** DB-IP's free country database is CC BY 4.0: where Still uses it, it says so. */
export const STILL_REGION_ATTRIBUTION_V1 = { text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' } as const;
/** What a refusal leaves open, in the words the server and the screens share. */
export const STILL_REGION_OPEN_V1 = 'You can still repay a loan, take your collateral back and sell.';
