# @mioagent/still-engine

Still's read engine: what a wallet can spend without selling, under Still's own terms. It moved
here from Still's `packages/engine` on 2026-10-26, when Still became Miorail's front door.

- `policy.ts`: Still's terms. It lends at half the protocol's collateral factor, and at 40% for
  stocks while Wall Street is closed (weekends and market holidays, by Miorail's reviewed market
  calendar) and around an earnings report.
- `read.ts` and `mirror.ts`: one-block reads of the Aave V4 "Coinbase Stocks" spoke and the Morpho
  cbBTC and WETH markets. They compute the Mirror report: limits, debt, safety and the headline.
- `math.ts`: bigint arithmetic for money. Every division names its rounding direction. Morpho
  Blue's own arithmetic (accrual, debt, the health check, the liquidation price) is not here: it
  comes from `@mioagent/rwa-issuer/morphoBorrowMath`, the module Miorail's borrow review checks a
  borrow with.
- `report.ts` and `report-schema.ts`: the report's shape, and the same shape in zod for a client
  to check before it shows a number. A compile-time check keeps the two from drifting apart.
- `subject.ts`: addresses, Basenames and ENS names, resolved forward and back.

Three things changed in the move. Relative imports now end in `.js`, as elsewhere in `lib/`. The
tests run on `node:test` instead of vitest: 104 then, 104 after the move. Still's own Found (the
LP-reward scan) is gone. Miorail's Found reads Aerodrome and Uniswap rewards for both products.

The API serves the Mirror at `GET /api/public/still/mirror` and the terms at
`GET /api/public/still/terms`. It reads through Miorail's configured Base endpoint, with Base's
public one as the second opinion.

Each question uses one shared source.
On 2026-10-26 Still's Morpho arithmetic gave way to `rwa-issuer`'s, the Aave API's read of a
person's position gave way to this engine's chain read, and Still's dividend reader gave way to
Miorail's Stocks calendar. Each pair was run on the same data first. The replay test borrows what
the Mirror offers through `morphoAfterBorrowV1`, the borrow review's check, and expects a health
factor of 2.
