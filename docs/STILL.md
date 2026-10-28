# Still

Still is the front door of this product: spend without selling. Its Mirror reads borrowing room against
Coinbase's tokenized stocks (the Aave V4 "Coinbase Stocks" spoke on Base) and against cbBTC and ETH
(Morpho Blue), without selling them. The Still Get money and Repay actions are the next phase;
the current Mirror only reads. Still started as its own repository on 2026-10-25. On
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

The frame keeps a visible wallet entry on every screen. It reuses the existing WalletPicker,
wallet connection and SIWE flow. A browser connection and a signed-in server account remain
separate facts; a mismatch names both. Signing out invalidates prepared actions before a wallet
is disconnected or changed. Nothing signs automatically.

On a desktop, Home puts its amounts and actions beside a bounded, undistorted mobile. Assets
puts the holdings beside a compact dividend link. The Agent's interface defaults to English
regardless of the browser locale; each answer still follows the language of its question.
Positive dividend values below one cent retain that meaning instead of becoming `$0.00`.

The Sky mobile reference also governs console pages inside Still: cool grounds, white or
night-blue cards, flat Base-blue actions and 18px card corners. The adapter is scoped to
`.still .still-console`; the classic console and miniapp retain their palette and evidence
status colours. On a phone, the wallet entry shares Home's sky and the Agent keeps its
conversation directly on the page, with separate answer cards.

The shared app also understands the original `/w/:subject` wallet links. That is a public check
of the address or name in the URL, even while a different wallet is signed in; it never replaces
the linked subject with the session wallet. Failed checks remain failures. Its link preview is
the general app preview, without the old wallet-specific amounts.

The shared app is currently served on `miorail.xyz`; switching `stills.lat` is a separate
operational step. Wallet sign-in uses each request's host while no wallet-auth origin override
is configured. Cookies remain host-only. Wallet MCP callbacks on the fixed `stills.lat` and
`www.stills.lat` hosts return to that same host, independently of the canonical API origin.
Miorail's MCP, OAuth and Farcaster identities keep their existing addresses.

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

## Assistants

Miorail MCP `1.8.0` adds two reads over the same services as the pages:

- Public `get_still_terms` returns exactly `StillTermsSchema`, using the earnings service and
  cache of `GET /api/public/still/terms`. It takes no arguments and reads no wallet. Its version,
  active windows and per-stock `calendarRead` fields remain explicit; unread calendars keep the
  conservative 40% stock limit. This answer is the terms themselves, without an EvidencePackage.
- Connected `miorail_get_my_still` takes no arguments and reads only the OAuth connection owner's
  wallet through the service and cache of `GET /api/still/mine`. It returns the same `report` /
  `chain_unavailable` envelope, validated against the Mirror schema before leaving the server.
  A partial known amount is **at least** that amount. Null is unknown; a chain failure is not an
  empty wallet. The report keeps its reading block and time even when cached.

The public registry has 18 tools; Connected carries that registry plus 16 wallet-bound tools.
The Wallet MCP plugin at `/wallet-mcp/miorail.md` explains these reads and the existing Morpho
capacity and review tools. It requires a person to approve in their wallet. A protocol maximum
is not a Still allowance. For the registered cbBTC/USDC and WETH/USDC markets, the capacity read
returns a separate `still` allowance against collateral **already deposited**. The server enforces
half the total protocol debt limit minus accrued debt and checks share-rounded projected debt.
Wallet-held collateral supply, native ETH wrapping, Get money and Repay remain pending.
Stock borrowing through Aave V4 remains research. These reads and terms
are not advice to borrow, and Still is not offered to US persons.

## One source per question

### Existing-collateral Morpho review

Still's registered crypto markets reuse the Mirror's same-block chain reader and accrued debt,
not the first page of a GraphQL market directory. `still-engine/capacity` owns the conservative
cent offer and the exact projected-debt check for both Mirror and execution. A positive draw
that rounds debt above Still's ceiling is refused, even if protocol health alone would pass.

Morpho writes the unsigned calldata through its official Actions API. The adapter verifies the
ES256 `Morpho-Action-Proof` against Morpho's fixed JWKS and the exact request/response bytes,
headers, status and path before accepting its data. A signature-required action, failed venue
simulation, intent mismatch, expired proof or action has no executable result. This supplements
Miorail's independent ordered batch simulation; it never substitutes for it.

For those two crypto markets, the same simulation also reads the exact market parameters,
position, market totals and oracle before and after the approved calls. Getter calls stay out
of the wallet batch and its calls hash. The position must preserve collateral and supply shares,
and its new debt shares must match the shared protocol projection, including accrued interest
and fee-share accounting. The server checks Still's ceiling again on those measured values.
Missing return bytes are a reading gap; a transfer into the wallet alone cannot pass this gate.

The browser re-runs the review before opening the wallet. If terms or calls changed, it displays
the fresh review and requires another explicit click within the server's thirty-second window,
bounded by the action/proof expiry. That second click accepts the displayed batch without
re-preparing forever as interest accrues. Changing wallet/draft or expiry clears that window.

A wallet request with an uncertain result cannot be retried from the same review in that browser
session. A marker is written before calling the wallet and survives reloads and returning to a
previous wallet; it stores only a hash of the draft/wallet identity and an attempt state. A
definitive user rejection permits retry. A batch id remains Submitted, never Completed. This
browser-session guard does not replace server reconciliation or prevent duplicate submissions
across independent tabs or browsers.

Prepared calls are not a successful loan. First real borrowing remains an operator-performed
transaction followed by chain reconciliation; no real transaction was made to test this release.

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
