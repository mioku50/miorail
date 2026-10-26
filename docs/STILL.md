# Still

Still is the front door of this product: spend without selling. A person borrows USDC against
Coinbase's tokenized stocks (the Aave V4 "Coinbase Stocks" spoke on Base) and against cbBTC and ETH
(Morpho Blue). They keep the shares. Still started as its own repository on 2026-10-25. On
2026-10-26 its code moved here, and Miorail became the engine under it.

Code: [`lib/still-engine`](../lib/still-engine/README.md). API: `GET /api/public/still/mirror` and
`GET /api/public/still/terms` (`artifacts/api-server/routes/stillPublic.ts`), and for the signed-in
wallet only, `GET /api/still/mine` (`routes/stillMine.ts`). Screens: `lib/ui/src/still`, wired into
the web app in `artifacts/interface/src/features/still`.

## Terms

The terms are versioned in `lib/still-engine/src/policy.ts`. A decision keeps the version it was
made under.

| Rule | Value |
| --- | --- |
| Share of the protocol's collateral factor | 50% |
| Stocks while Wall Street is closed: weekends and market holidays, from 20:00 New York time after the last session to 20:00 before the next | 40% |
| A stock from 00:00 the day before its report date to 20:00 the day after | 40% |
| Closed market and earnings windows together | 40%, never stacked |
| Earnings calendar unread | Every stock counts at 40%, and the report says so |
| Safety bands, by the margin to liquidation | Calm from 37.5%, watch below it, act below 20% |
| Native ETH kept for network fees | 0.0005 ETH, never collateral |
| A stock Coinbase's registry marks paused | Closed for new loans |

The closed-market window is Miorail's reviewed market calendar, the same one the Stocks weekend card
reads. Until 2026-10-26 it was Friday 20:00 to Sunday 20:00 and knew no holidays. On a holiday the
stock reference prices stand still just as on a weekend, so the window now covers holidays too
(operator, 2026-10-26; terms version `2026-10-26`). Thanksgiving 2026 is Wednesday 20:00 to
Thursday 20:00, and a holiday Monday ends the window at Monday 20:00. Past the reviewed calendar,
which runs through 2027, the old Friday-to-Sunday window applies.

Why 40%: Aave's daily closes since 2018 cover 247 reports by these seven companies. The worst move
across a report window was −28.8% (Meta, October 2022). After such a move, a fresh full draw at 50%
falls to a 30% margin ("watch"), while one at 40% keeps 44% ("calm").

Borrowed USDC is never re-pledged, so there is no leverage. There is no investment advice and no
ranking. Still is not offered to US persons, because the issuer's terms exclude them.

## The shell

Since 2026-10-26 the web app opens on Still. Five places lead: Home, Assets, Agent, Stocks and More
(operator, 2026-10-26). Every other Miorail page sits under More, at the path it always had, and is
drawn in the same frame: a bar at the bottom on a phone, a rail on the left on a desk. A link that
carried a query to `/` still lands on Stocks, which reads it.

- **The sky** is computed, never drawn by mood. Day is the regular session on a day the reviewed
  calendar has one. Night is Still's closed-market window. Dusk is the rest of a trading day. A
  cloud is a stock inside its earnings window, from `/terms`. The caption names the limits only once
  the terms were read, and an unread earnings calendar is said, not shown as full limits. The
  palette follows the sky: the console's light palette by day, its dark one at night. There is no
  theme switch.
- **Home**, signed in, is the wallet's own Mirror: the mobile, where every shape's area is its
  value, what can be spent, what is owed, and what is coming up. Signed out, it is the public check
  of any Base wallet by address or name, and each refusal or failure of that check has its own
  sentence.
- **The Agent**, first version, answers from the numbers already read: the Mirror, the terms and
  the dividend calendar. No model writes its sentences. A question in Russian gets its answer in
  Russian, and a question it does not know gets the list of what it can answer.
- **For assistants** copies the plugin line and the MCP addresses from the Wallet MCP card's
  constants, the ones the plugin file names.
- **Console pages** draw themselves through `ConsoleShell`, and the web app hands it Still's frame
  through `ConsoleFrameContextV1`. The miniapp passes no frame and keeps the console's own chrome.
  It builds the shared package below ES2020, and Still's engine counts money in BigInt literals.

Each sentence takes its shares from `TERMS`, its amounts from the engine's formatters and its
windows from the engine's `stillTerms`, which `/terms` serves too.

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

## One source per question

Still arrived with its own answers to questions Miorail already answered. On 2026-10-26 each pair
was run on the same data. Then one was kept and the other removed.

| Question | The one source | Removed |
| --- | --- | --- |
| Morpho's arithmetic: interest, debt, health, liquidation price | `rwa-issuer/morphoBorrowMath`, the module the borrow review checks a borrow with | Still's `morpho.ts` |
| A wallet's Aave V4 loan | The chain, read by the Mirror (`/api/still/mine`) | The Aave API's `userPosition` read |
| Dividends | Miorail's Stocks calendar | Still's dividend reader |

- **Morpho.** At block 53,075,866, over 40,000 positions, debts and liquidation prices agreed to
  the unit. Still rounded the limit and the health factor once where the contract rounds twice:
  its health factors differed in the last digits, and one limit in 20,000 was a cent higher. The
  replay test now borrows what the Mirror offers through the review's own check.
- **Aave V4.** At block 53,118,515, the chain and the Aave API agreed on every reserve: collateral
  factor, pause, freeze, caps and supplied amounts. USDC totals differed by half a cent of interest
  accrued between the two reads. The API's 3.55% is a compounded rate (APY), and the chain's 3.49%
  is the same rate, uncompounded (APR). The console's Aave card now reads the person's position
  from the chain, so it shows the same debt as Still. A stock's page still lists the market's terms
  from the API, as it does for every other venue. The two were not compared on one person's
  position: no public borrower could be found without a log scan, which Base's public endpoint
  refuses.
- **Dividends.** Aave's calendar (Still's source) and Miorail's (the companies' own releases)
  agreed on every amount, record date and payment date they share. The three conversions Still had
  proven (Alphabet on September 14, Meta on September 28, NVIDIA on October 1) match Miorail's to
  the second and to the last digit of the multiplier. The reinvested value per token agreed within
  $0.0001. Miorail's calendar also has what Aave's lacked: Microsoft's next dividend ($0.98, paid
  December 10), the record-date check that found nothing owed to AAPLc and MSFTc, and 211 stocks
  instead of seven. The earnings calendar has only one source, the Aave V4 API, and stays.
