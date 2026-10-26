# Still

Still is the front door of this product: spend without selling. A person borrows USDC against
Coinbase's tokenized stocks (the Aave V4 "Coinbase Stocks" spoke on Base) and against cbBTC and ETH
(Morpho Blue). They keep the shares. Still started as its own repository on 2026-10-25. On
2026-10-26 its code moved here, and Miorail became the engine under it.

Code: [`lib/still-engine`](../lib/still-engine/README.md). API: `GET /api/public/still/mirror` and
`GET /api/public/still/terms` (`artifacts/api-server/routes/stillPublic.ts`).

## Terms

The terms are versioned in `lib/still-engine/src/policy.ts`. A decision keeps the version it was
made under.

| Rule | Value |
| --- | --- |
| Share of the protocol's collateral factor | 50% |
| Stocks from Friday 20:00 to Sunday 20:00, New York time | 40% |
| A stock from 00:00 the day before its report date to 20:00 the day after | 40% |
| Weekend and earnings windows together | 40%, never stacked |
| Earnings calendar unread | Every stock counts at 40%, and the report says so |
| Safety bands, by the margin to liquidation | Calm from 37.5%, watch below it, act below 20% |
| Native ETH kept for network fees | 0.0005 ETH, never collateral |
| A stock Coinbase's registry marks paused | Closed for new loans |

Why 40%: Aave's daily closes since 2018 cover 247 reports by these seven companies. The worst move
across a report window was −28.8% (Meta, October 2022). After such a move, a fresh full draw at 50%
falls to a 30% margin ("watch"), while one at 40% keeps 44% ("calm").

Borrowed USDC is never re-pledged, so there is no leverage. There is no investment advice and no
ranking. Still is not offered to US persons, because the issuer's terms exclude them.

## The evidence bar

- A failed read is not an empty read. "Not measured", "measured as zero" and "unknown" stay three
  values all the way to the screen.
- Our failure is never shown as a fact about the token, the market or the person. A chain or name
  service that does not answer is `chain_unavailable` or `names_unavailable` (HTTP 503), and never
  a wallet with nothing in it.
- Every amount carries the block it was read at. Money is integer cents of USDC, and every
  division names its rounding direction: what a person may borrow rounds down, a debt rounds up.

## Reading the chain

Still reads through Miorail's read path and follows Miorail's RPC rules. That means the configured
Base endpoint first, with Base's public endpoint as the second opinion. Still's own Found scan was
removed on 2026-10-26, because Miorail's Found already reads Aerodrome and Uniswap rewards for a
wallet.

## Dividends

Miorail's Stocks calendar is the one public source for dividends. Still's own reader
(`dividends.ts`) proves a per-share receipt from the issuer's `Announcement` and `EndAnnouncement`
brackets around the multiplier change. It is not exposed while the two readers merge.
