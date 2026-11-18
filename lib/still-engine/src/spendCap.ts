// The most one Spend purchase paid from Still may cost: the server refuses an invoice above it, and every page and
// tool that names the limit says this number. One place, so a sentence cannot drift from the check.
//
// 2026-11-01: 100 USDC, while Bitrefill's refund handling for these invoices is unconfirmed (gift cards are also
// how people are scammed, and the page warns of that). 2026-11-18 (operator): 210 USDC. A round 100 package priced
// at 100.01 USDC was refused, and so were Netflix's EUR 100 and 150; 210 leaves room for a 200 card priced a little
// over its face value. Refunds of a failed order still go through Bitrefill's support.

/** In USDC atomic units (6 decimals). */
export const STILL_SPEND_CAP_ATOMIC_V1 = 210_000_000n;

/** The same limit as said to a reader: "210 USDC". */
export const STILL_SPEND_CAP_TEXT_V1 = `${STILL_SPEND_CAP_ATOMIC_V1 / 1_000_000n} USDC`;
