# @mioagent/still-engine

Still's read engine: what a wallet can spend without selling, under Still's own terms. It moved
here from Still's `packages/engine` on 2026-10-26, when Still became Miorail's front door.

- `policy.ts`: Still's terms. It lends at half the protocol's collateral factor, and at 40% for
  stocks on weekends (Friday 20:00 to Sunday 20:00, New York) and around an earnings report.
- `read.ts` and `mirror.ts`: one-block reads of the Aave V4 "Coinbase Stocks" spoke and the Morpho
  cbBTC and WETH markets. They compute the Mirror report: limits, debt, safety and the headline.
- `morpho.ts` and `math.ts`: Morpho Blue's share and interest arithmetic in bigint. Every
  division names its rounding direction.
- `dividends.ts` and `dividend-calendar.ts`: Aave's dividend calendar, the multiplier snapshot,
  and receipts proven from the issuer's own announcements.
- `found*.ts`: the bounded LP-reward check. It stays off in production until it has its own
  RPC budget (see the 2026-10-25 Alchemy incident).
- `subject.ts`: addresses, Basenames and ENS names, resolved forward and back.

The code is unchanged except for two things. Relative imports now end in `.js`, as elsewhere in
`lib/`. The tests run on `node:test` instead of vitest: 104 then, 104 now.

Still is not yet wired into the API, and nothing here is deduplicated yet. The next steps give each
question one source: Morpho math beside `rwa-issuer`'s borrow modules, the Aave V4 read beside
`aaveV4.ts`, and dividends beside the Stocks dividend calendar.
